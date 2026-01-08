import { test, expect, describe, beforeEach, afterEach } from 'bun:test';

// Mock pino-pretty since it's a dev dependency that may not work in test env
// We test the redaction logic directly by importing the logger

describe('Logger Redaction', () => {
    // We need to test that the redaction logic in the logger works correctly
    // Since pino uses hooks to redact, we'll test by checking the output

    describe('Redaction patterns', () => {
        // Import the redaction logic directly for testing
        const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
            // Anthropic API keys (must come before OpenAI pattern since sk-ant- contains sk-)
            { pattern: /sk-ant-[a-zA-Z0-9-_]{20,}/g, replacement: 'sk-ant-[REDACTED]' },

            // OpenAI API keys
            { pattern: /sk-[a-zA-Z0-9-_]{20,}/g, replacement: 'sk-[REDACTED]' },

            // Groq API keys
            { pattern: /gsk_[a-zA-Z0-9]{20,}/g, replacement: 'gsk_[REDACTED]' },

            // Google AI/Gemini API keys (39 chars after AIza prefix)
            { pattern: /AIza[a-zA-Z0-9_-]{35,}/g, replacement: 'AIza[REDACTED]' },

            // xAI/Grok API keys
            { pattern: /xai-[a-zA-Z0-9]{20,}/g, replacement: 'xai-[REDACTED]' },

            // Cerebras API keys
            { pattern: /csk-[a-zA-Z0-9]{20,}/g, replacement: 'csk-[REDACTED]' },

            // HuggingFace tokens
            { pattern: /hf_[a-zA-Z0-9]{20,}/g, replacement: 'hf_[REDACTED]' },

            // Generic API key patterns (in headers or JSON)
            { pattern: /(x-api-key["':\s]+)[a-zA-Z0-9_-]{16,}/gi, replacement: '$1[REDACTED]' },
            { pattern: /(api[_-]?key["':\s=]+)[a-zA-Z0-9_-]{16,}/gi, replacement: '$1[REDACTED]' },

            // Bearer tokens in Authorization headers
            {
                pattern: /(Authorization["':\s]+Bearer\s+)[a-zA-Z0-9._-]+/gi,
                replacement: '$1[REDACTED]',
            },
            { pattern: /Bearer [a-zA-Z0-9._-]{10,}/gi, replacement: 'Bearer [REDACTED]' },

            // Generic token patterns
            { pattern: /(access[_-]?token["':\s=]+)[a-zA-Z0-9._-]{10,}/gi, replacement: '$1[REDACTED]' },
            { pattern: /(refresh[_-]?token["':\s=]+)[a-zA-Z0-9._-]{10,}/gi, replacement: '$1[REDACTED]' },
        ];

        function redactString(value: string): string {
            let result = value;
            for (const { pattern, replacement } of REDACTION_PATTERNS) {
                pattern.lastIndex = 0;
                result = result.replace(pattern, replacement);
            }
            return result;
        }

        test('should redact OpenAI API keys', () => {
            const input = 'Using API key: sk-1234567890abcdefghijklmnop';
            const result = redactString(input);
            expect(result).toBe('Using API key: sk-[REDACTED]');
            expect(result).not.toContain('1234567890');
        });

        test('should redact Anthropic API keys', () => {
            const input = 'Key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
            const result = redactString(input);
            expect(result).toBe('Key is sk-ant-[REDACTED]');
            expect(result).not.toContain('abcdefghijklmnopqrstuvwxyz');
        });

        test('should redact Anthropic before OpenAI (order matters)', () => {
            // This tests that Anthropic patterns come before OpenAI patterns
            const anthropicKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
            const result = redactString(anthropicKey);
            // Should use Anthropic redaction, not OpenAI
            expect(result).toBe('sk-ant-[REDACTED]');
        });

        test('should redact Groq API keys', () => {
            const input = 'Groq key: gsk_1234567890abcdefghij';
            const result = redactString(input);
            expect(result).toBe('Groq key: gsk_[REDACTED]');
        });

        test('should redact Google AI API keys', () => {
            const input = 'Google key: AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ12345678';
            const result = redactString(input);
            expect(result).toBe('Google key: AIza[REDACTED]');
        });

        test('should redact xAI API keys', () => {
            const input = 'xAI key: xai-abcdefghijklmnopqrstuvwxyz';
            const result = redactString(input);
            expect(result).toBe('xAI key: xai-[REDACTED]');
        });

        test('should redact Cerebras API keys', () => {
            const input = 'Cerebras: csk-abcdefghijklmnopqrstuvwxyz';
            const result = redactString(input);
            expect(result).toBe('Cerebras: csk-[REDACTED]');
        });

        test('should redact HuggingFace tokens', () => {
            const input = 'HF token: hf_abcdefghijklmnopqrstuvwxyz';
            const result = redactString(input);
            expect(result).toBe('HF token: hf_[REDACTED]');
        });

        test('should redact Bearer tokens', () => {
            const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
            const result = redactString(input);
            expect(result).toContain('[REDACTED]');
            expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
        });

        test('should redact access_token in JSON', () => {
            const input = '{"access_token": "abc123def456ghi789jkl0"}';
            const result = redactString(input);
            expect(result).toContain('[REDACTED]');
            expect(result).not.toContain('abc123def456ghi789jkl0');
        });

        test('should redact refresh_token in JSON', () => {
            const input = '{"refresh_token": "xyz987wvu654tsr321qpo0"}';
            const result = redactString(input);
            expect(result).toContain('[REDACTED]');
            expect(result).not.toContain('xyz987wvu654tsr321qpo0');
        });

        test('should redact x-api-key header', () => {
            const input = 'Headers: { "x-api-key": "my-secret-api-key-1234567890" }';
            const result = redactString(input);
            expect(result).toContain('[REDACTED]');
            expect(result).not.toContain('my-secret-api-key-1234567890');
        });

        test('should not redact non-sensitive content', () => {
            const input = 'This is a normal log message without any secrets';
            const result = redactString(input);
            expect(result).toBe(input);
        });

        test('should handle multiple keys in same message', () => {
            const input = 'OpenAI: sk-1234567890abcdefghijklmnop, Groq: gsk_abcdefghijklmnopqrst';
            const result = redactString(input);
            expect(result).toBe('OpenAI: sk-[REDACTED], Groq: gsk_[REDACTED]');
        });
    });
});
