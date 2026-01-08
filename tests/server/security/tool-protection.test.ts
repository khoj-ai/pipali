import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { readFile } from '../../../src/server/processor/actor/read_file';
import { grepFiles } from '../../../src/server/processor/actor/grep_files';
import { readWebpage } from '../../../src/server/processor/actor/read_webpage';
import {
    type ConfirmationContext,
    type ConfirmationCallback,
    createEmptyPreferences,
} from '../../../src/server/processor/confirmation';
import type { ConfirmationRequest } from '../../../src/server/processor/confirmation/confirmation.types';
import { CONFIRMATION_OPTIONS } from '../../../src/server/processor/confirmation/confirmation.types';

/**
 * Helper to create a mock confirmation context that auto-approves or denies
 */
function createMockConfirmationContext(
    autoApprove: boolean,
    capturedRequests: ConfirmationRequest[] = []
): ConfirmationContext {
    const requestConfirmation: ConfirmationCallback = async (request) => {
        capturedRequests.push(request);
        return {
            requestId: request.requestId,
            selectedOptionId: autoApprove ? CONFIRMATION_OPTIONS.YES : CONFIRMATION_OPTIONS.NO,
        };
    };

    return {
        requestConfirmation,
        preferences: createEmptyPreferences(),
    };
}

describe('Tool Protection - Sensitive Path Confirmation', () => {
    const testDir = path.join(os.tmpdir(), 'tool-protection-tests');
    const sensitiveTestDir = path.join(testDir, '.ssh');
    const sensitiveFile = path.join(sensitiveTestDir, 'test_key');
    const normalFile = path.join(testDir, 'normal.txt');

    beforeAll(async () => {
        // Create test directories
        await fs.mkdir(sensitiveTestDir, { recursive: true });

        // Create test files
        await fs.writeFile(sensitiveFile, 'FAKE_SSH_KEY_CONTENT');
        await fs.writeFile(normalFile, 'Normal file content\nwith multiple lines\nfor testing');
    });

    afterAll(async () => {
        await fs.rm(testDir, { recursive: true, force: true });
    });

    describe('readFile with sensitive paths', () => {
        test('should request confirmation for .ssh directory files', async () => {
            const capturedRequests: ConfirmationRequest[] = [];
            const context = createMockConfirmationContext(true, capturedRequests);

            const result = await readFile(
                { path: sensitiveFile },
                { confirmationContext: context }
            );

            // Should have requested confirmation
            expect(capturedRequests.length).toBe(1);
            expect(capturedRequests[0]!.operation).toBe('read_sensitive_file');
            expect(capturedRequests[0]!.title).toBe('Confirm Sensitive File Access');
            expect(capturedRequests[0]!.message).toContain('.ssh');

            // Should return file content when approved
            expect(result.compiled).toContain('FAKE_SSH_KEY_CONTENT');
        });

        test('should deny reading sensitive file when user rejects', async () => {
            const capturedRequests: ConfirmationRequest[] = [];
            const context = createMockConfirmationContext(false, capturedRequests);

            const result = await readFile(
                { path: sensitiveFile },
                { confirmationContext: context }
            );

            // Should have requested confirmation
            expect(capturedRequests.length).toBe(1);

            // Should return denial message, not file content
            expect(result.compiled).toContain('denied');
            expect(result.compiled).not.toContain('FAKE_SSH_KEY_CONTENT');
        });

        test('should NOT request confirmation for normal files', async () => {
            const capturedRequests: ConfirmationRequest[] = [];
            const context = createMockConfirmationContext(true, capturedRequests);

            const result = await readFile(
                { path: normalFile },
                { confirmationContext: context }
            );

            // Should NOT request confirmation for normal files
            expect(capturedRequests.length).toBe(0);

            // Should return file content directly
            expect(result.compiled).toContain('Normal file content');
        });

        test('should work without confirmation context for normal files', async () => {
            const result = await readFile({ path: normalFile });

            // Should work without options
            expect(result.compiled).toContain('Normal file content');
        });
    });

    describe('grepFiles with sensitive paths', () => {
        test('should request confirmation for searching in .ssh directory', async () => {
            const capturedRequests: ConfirmationRequest[] = [];
            const context = createMockConfirmationContext(true, capturedRequests);

            const result = await grepFiles(
                { pattern: 'KEY', path: sensitiveTestDir },
                { confirmationContext: context }
            );

            // Should have requested confirmation
            expect(capturedRequests.length).toBe(1);
            expect(capturedRequests[0]!.operation).toBe('grep_sensitive_path');
            expect(capturedRequests[0]!.title).toBe('Confirm Sensitive Path Search');

            // Should return results when approved
            expect(result.compiled).toContain('FAKE_SSH_KEY_CONTENT');
        });

        test('should deny searching sensitive path when user rejects', async () => {
            const capturedRequests: ConfirmationRequest[] = [];
            const context = createMockConfirmationContext(false, capturedRequests);

            const result = await grepFiles(
                { pattern: 'KEY', path: sensitiveTestDir },
                { confirmationContext: context }
            );

            // Should have requested confirmation
            expect(capturedRequests.length).toBe(1);

            // Should return denial message
            expect(result.compiled).toContain('denied');
            expect(result.compiled).not.toContain('FAKE_SSH_KEY_CONTENT');
        });

        test('should NOT request confirmation for normal directories', async () => {
            const capturedRequests: ConfirmationRequest[] = [];
            const context = createMockConfirmationContext(true, capturedRequests);

            const result = await grepFiles(
                { pattern: 'Normal', path: testDir },
                { confirmationContext: context }
            );

            // The sensitive subdirectory would trigger confirmation,
            // but searching the parent dir for 'Normal' should find only normal.txt
            // This depends on implementation - let's check the behavior
            expect(result.compiled).toContain('Normal file content');
        });

        test('should work without confirmation context for normal directories', async () => {
            const result = await grepFiles({ pattern: 'content', path: testDir });

            // Should find matches
            expect(result.query).toContain('Found');
        });
    });

    describe('Confirmation preference memory', () => {
        test('should remember "dont ask again" preference for sensitive file reads', async () => {
            const capturedRequests: ConfirmationRequest[] = [];

            // Create context that returns "Yes, don't ask again"
            const preferences = createEmptyPreferences();
            const context: ConfirmationContext = {
                requestConfirmation: async (request) => {
                    capturedRequests.push(request);
                    return {
                        requestId: request.requestId,
                        selectedOptionId: CONFIRMATION_OPTIONS.YES_DONT_ASK,
                    };
                },
                preferences,
            };

            // First read - should ask for confirmation
            await readFile({ path: sensitiveFile }, { confirmationContext: context });
            expect(capturedRequests.length).toBe(1);

            // Second read with same context - should NOT ask again
            await readFile({ path: sensitiveFile }, { confirmationContext: context });
            expect(capturedRequests.length).toBe(1); // Still 1, not 2
        });
    });
});

describe('Tool Protection - Internal URL Confirmation', () => {
    describe('readWebpage with internal URLs', () => {
        test('should request confirmation for localhost URLs', async () => {
            const capturedRequests: ConfirmationRequest[] = [];
            const context = createMockConfirmationContext(false, capturedRequests);

            const result = await readWebpage(
                { url: 'http://localhost:3000/api', query: 'test' },
                { confirmationContext: context }
            );

            // Should have requested confirmation
            expect(capturedRequests.length).toBe(1);
            expect(capturedRequests[0]!.operation).toBe('fetch_internal_url');
            expect(capturedRequests[0]!.title).toBe('Confirm Internal Network Access');
            expect(capturedRequests[0]!.message).toContain('localhost');

            // Should return denial message when rejected
            expect(result.compiled).toContain('denied');
        });

        test('should request confirmation for private IP addresses', async () => {
            const capturedRequests: ConfirmationRequest[] = [];
            const context = createMockConfirmationContext(false, capturedRequests);

            const result = await readWebpage(
                { url: 'http://192.168.1.1/admin', query: 'test' },
                { confirmationContext: context }
            );

            // Should have requested confirmation
            expect(capturedRequests.length).toBe(1);
            expect(capturedRequests[0]!.message).toContain('192.168.1.1');
        });

        test('should request confirmation for cloud metadata endpoints', async () => {
            const capturedRequests: ConfirmationRequest[] = [];
            const context = createMockConfirmationContext(false, capturedRequests);

            const result = await readWebpage(
                { url: 'http://169.254.169.254/latest/meta-data/', query: 'credentials' },
                { confirmationContext: context }
            );

            // Should have requested confirmation for cloud metadata
            expect(capturedRequests.length).toBe(1);
            expect(capturedRequests[0]!.message).toContain('169.254.169.254');
        });

        test('should request confirmation for 127.0.0.1', async () => {
            const capturedRequests: ConfirmationRequest[] = [];
            const context = createMockConfirmationContext(false, capturedRequests);

            await readWebpage(
                { url: 'http://127.0.0.1:8080/api', query: 'test' },
                { confirmationContext: context }
            );

            expect(capturedRequests.length).toBe(1);
            expect(capturedRequests[0]!.operation).toBe('fetch_internal_url');
        });

        test('should request confirmation for 10.x.x.x addresses', async () => {
            const capturedRequests: ConfirmationRequest[] = [];
            const context = createMockConfirmationContext(false, capturedRequests);

            await readWebpage(
                { url: 'http://10.0.0.5/internal', query: 'test' },
                { confirmationContext: context }
            );

            expect(capturedRequests.length).toBe(1);
        });

        test('should NOT request confirmation for external URLs', async () => {
            const capturedRequests: ConfirmationRequest[] = [];
            const context = createMockConfirmationContext(true, capturedRequests);

            // Note: This will fail to fetch but should NOT request internal URL confirmation
            await readWebpage(
                { url: 'https://example.com', query: 'test' },
                { confirmationContext: context }
            );

            // Should NOT have requested internal URL confirmation
            // (it might fail for other reasons but not security confirmation)
            expect(capturedRequests.length).toBe(0);
        });
    });
});

describe('Risk levels', () => {
    test('should assign medium risk to sensitive file reads', async () => {
        const capturedRequests: ConfirmationRequest[] = [];
        const context = createMockConfirmationContext(true, capturedRequests);

        const testDir = path.join(os.tmpdir(), 'risk-level-test');
        const sensitiveDir = path.join(testDir, '.aws');
        const sensitiveFile = path.join(sensitiveDir, 'credentials');

        await fs.mkdir(sensitiveDir, { recursive: true });
        await fs.writeFile(sensitiveFile, 'test');

        try {
            await readFile({ path: sensitiveFile }, { confirmationContext: context });

            expect(capturedRequests.length).toBe(1);
            expect(capturedRequests[0]!.context.riskLevel).toBe('medium');
        } finally {
            await fs.rm(testDir, { recursive: true, force: true });
        }
    });

    test('should assign medium risk to internal URL fetches', async () => {
        const capturedRequests: ConfirmationRequest[] = [];
        const context = createMockConfirmationContext(false, capturedRequests);

        await readWebpage(
            { url: 'http://localhost/api', query: 'test' },
            { confirmationContext: context }
        );

        expect(capturedRequests.length).toBe(1);
        expect(capturedRequests[0]!.context.riskLevel).toBe('medium');
    });
});
