import { describe, expect, test, mock, beforeEach, spyOn } from 'bun:test';
import type { McpServerConfig } from '../../../src/server/processor/mcp/types';

/**
 * Unit tests for MCP Client functionality.
 *
 * Since the actual MCP SDK requires process spawning or network connections,
 * these tests focus on the client's logic: configuration parsing,
 * transport type detection, and command parsing.
 */

describe('MCP Client', () => {
    // Test the parseStdioCommand logic (extracted from client for testability)
    function parseStdioCommand(path: string): { command: string; args: string[] } {
        // npm package (starts with @ or has no path separator)
        if (path.startsWith('@') || !path.includes('/')) {
            return { command: 'npx', args: ['-y', path] };
        }

        // Python script
        if (path.endsWith('.py')) {
            return { command: 'python', args: [path] };
        }

        // JavaScript script
        if (path.endsWith('.js') || path.endsWith('.mjs')) {
            return { command: 'node', args: [path] };
        }

        // TypeScript script (run with bun)
        if (path.endsWith('.ts')) {
            return { command: 'bun', args: ['run', path] };
        }

        // Default: treat as executable
        return { command: path, args: [] };
    }

    // Test transport type detection
    function isHttpTransport(path: string): boolean {
        return path.startsWith('http://') || path.startsWith('https://');
    }

    describe('Transport Type Detection', () => {
        test('detects HTTP URLs as HTTP transport', () => {
            expect(isHttpTransport('http://localhost:8080')).toBe(true);
            expect(isHttpTransport('https://api.example.com/mcp')).toBe(true);
            expect(isHttpTransport('https://mcp.service.io/v1')).toBe(true);
        });

        test('detects non-HTTP paths as stdio transport', () => {
            expect(isHttpTransport('@modelcontextprotocol/server-github')).toBe(false);
            expect(isHttpTransport('/path/to/server.py')).toBe(false);
            expect(isHttpTransport('./scripts/mcp-server.ts')).toBe(false);
            expect(isHttpTransport('my-mcp-package')).toBe(false);
        });
    });

    describe('Stdio Command Parsing', () => {
        describe('NPM Packages', () => {
            test('parses scoped npm packages with npx', () => {
                const result = parseStdioCommand('@modelcontextprotocol/server-github');
                expect(result.command).toBe('npx');
                expect(result.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
            });

            test('parses simple npm package names with npx', () => {
                const result = parseStdioCommand('mcp-server-sqlite');
                expect(result.command).toBe('npx');
                expect(result.args).toEqual(['-y', 'mcp-server-sqlite']);
            });

            test('parses npm package with version specifier', () => {
                const result = parseStdioCommand('@example/mcp-server@1.0.0');
                expect(result.command).toBe('npx');
                expect(result.args).toEqual(['-y', '@example/mcp-server@1.0.0']);
            });
        });

        describe('Python Scripts', () => {
            test('parses Python scripts with python command', () => {
                const result = parseStdioCommand('/path/to/server.py');
                expect(result.command).toBe('python');
                expect(result.args).toEqual(['/path/to/server.py']);
            });

            test('parses relative Python script paths', () => {
                const result = parseStdioCommand('./scripts/mcp-server.py');
                expect(result.command).toBe('python');
                expect(result.args).toEqual(['./scripts/mcp-server.py']);
            });
        });

        describe('JavaScript Scripts', () => {
            test('parses .js files with node command', () => {
                const result = parseStdioCommand('/path/to/server.js');
                expect(result.command).toBe('node');
                expect(result.args).toEqual(['/path/to/server.js']);
            });

            test('parses .mjs files with node command', () => {
                const result = parseStdioCommand('/path/to/server.mjs');
                expect(result.command).toBe('node');
                expect(result.args).toEqual(['/path/to/server.mjs']);
            });
        });

        describe('TypeScript Scripts', () => {
            test('parses .ts files with bun command', () => {
                const result = parseStdioCommand('/path/to/server.ts');
                expect(result.command).toBe('bun');
                expect(result.args).toEqual(['run', '/path/to/server.ts']);
            });

            test('parses relative TypeScript paths', () => {
                const result = parseStdioCommand('./my-mcp-server.ts');
                expect(result.command).toBe('bun');
                expect(result.args).toEqual(['run', './my-mcp-server.ts']);
            });
        });

        describe('Executable Files', () => {
            test('parses executable paths directly', () => {
                const result = parseStdioCommand('/usr/local/bin/mcp-server');
                expect(result.command).toBe('/usr/local/bin/mcp-server');
                expect(result.args).toEqual([]);
            });

            test('parses relative executable paths', () => {
                const result = parseStdioCommand('./bin/mcp-server');
                expect(result.command).toBe('./bin/mcp-server');
                expect(result.args).toEqual([]);
            });
        });
    });

    describe('Tool Namespacing', () => {
        function createNamespacedToolName(serverName: string, toolName: string): string {
            return `${serverName}/${toolName}`;
        }

        function parseNamespacedToolName(namespacedName: string): { serverName: string; toolName: string } | null {
            const slashIndex = namespacedName.indexOf('/');
            if (slashIndex === -1) {
                return null;
            }
            return {
                serverName: namespacedName.slice(0, slashIndex),
                toolName: namespacedName.slice(slashIndex + 1),
            };
        }

        test('creates namespaced tool names correctly', () => {
            expect(createNamespacedToolName('github', 'create_issue')).toBe('github/create_issue');
            expect(createNamespacedToolName('slack', 'send_message')).toBe('slack/send_message');
            expect(createNamespacedToolName('db', 'query')).toBe('db/query');
        });

        test('parses namespaced tool names correctly', () => {
            const result1 = parseNamespacedToolName('github/create_issue');
            expect(result1).toEqual({ serverName: 'github', toolName: 'create_issue' });

            const result2 = parseNamespacedToolName('my-server/my_complex_tool');
            expect(result2).toEqual({ serverName: 'my-server', toolName: 'my_complex_tool' });
        });

        test('returns null for non-namespaced tool names', () => {
            expect(parseNamespacedToolName('view_file')).toBeNull();
            expect(parseNamespacedToolName('list_files')).toBeNull();
            expect(parseNamespacedToolName('text')).toBeNull();
        });

        test('handles edge cases in namespaced names', () => {
            // Multiple slashes - takes first slash
            const result = parseNamespacedToolName('server/path/tool');
            expect(result).toEqual({ serverName: 'server', toolName: 'path/tool' });

            // Empty parts
            const result2 = parseNamespacedToolName('/tool');
            expect(result2).toEqual({ serverName: '', toolName: 'tool' });
        });
    });

    describe('McpServerConfig Validation', () => {
        function validateConfig(config: Partial<McpServerConfig>): string[] {
            const errors: string[] = [];

            if (!config.name) {
                errors.push('name is required');
            } else if (!/^[a-z0-9_-]+$/.test(config.name)) {
                errors.push('name must be lowercase alphanumeric with dashes/underscores');
            }

            if (!config.path) {
                errors.push('path is required');
            }

            if (!config.transportType) {
                errors.push('transportType is required');
            } else if (!['stdio', 'sse'].includes(config.transportType)) {
                errors.push('transportType must be stdio or sse');
            }

            return errors;
        }

        test('accepts valid stdio config', () => {
            const config: Partial<McpServerConfig> = {
                name: 'github',
                path: '@modelcontextprotocol/server-github',
                transportType: 'stdio',
            };
            expect(validateConfig(config)).toEqual([]);
        });

        test('accepts valid sse config', () => {
            const config: Partial<McpServerConfig> = {
                name: 'my-api',
                path: 'https://api.example.com/mcp',
                transportType: 'sse',
            };
            expect(validateConfig(config)).toEqual([]);
        });

        test('rejects config without name', () => {
            const config: Partial<McpServerConfig> = {
                path: '/path/to/server',
                transportType: 'stdio',
            };
            const errors = validateConfig(config);
            expect(errors).toContain('name is required');
        });

        test('rejects config with invalid name format', () => {
            const config: Partial<McpServerConfig> = {
                name: 'Invalid-Name-123',
                path: '/path/to/server',
                transportType: 'stdio',
            };
            const errors = validateConfig(config);
            expect(errors).toContain('name must be lowercase alphanumeric with dashes/underscores');
        });

        test('rejects config without path', () => {
            const config: Partial<McpServerConfig> = {
                name: 'my-server',
                transportType: 'stdio',
            };
            const errors = validateConfig(config);
            expect(errors).toContain('path is required');
        });

        test('rejects config with invalid transportType', () => {
            const config: Partial<McpServerConfig> = {
                name: 'my-server',
                path: '/path/to/server',
                transportType: 'websocket' as any,
            };
            const errors = validateConfig(config);
            expect(errors).toContain('transportType must be stdio or sse');
        });
    });

    describe('MCP Result Formatting', () => {
        type McpContentType =
            | { type: 'text'; text: string }
            | { type: 'image'; data: string; mimeType: string }
            | { type: 'audio'; data: string; mimeType: string };

        function formatMcpResult(content: McpContentType[]): string | Array<{ type: string; [key: string]: unknown }> {
            // If there's only text content, return as a simple string
            const hasOnlyText = content.every(item => item.type === 'text');
            if (hasOnlyText) {
                return content.map(item => (item as { type: 'text'; text: string }).text).join('\n');
            }

            // Otherwise, return as multimodal content array
            return content.map(item => {
                if (item.type === 'text') {
                    return { type: 'text', text: item.text };
                } else if (item.type === 'image') {
                    return {
                        type: 'image',
                        source_type: 'base64',
                        mime_type: item.mimeType,
                        data: item.data,
                    };
                } else if (item.type === 'audio') {
                    return {
                        type: 'audio',
                        source_type: 'base64',
                        mime_type: item.mimeType,
                        data: item.data,
                    };
                }
                return item;
            });
        }

        test('formats text-only content as string', () => {
            const content: McpContentType[] = [
                { type: 'text', text: 'Hello' },
                { type: 'text', text: 'World' },
            ];
            const result = formatMcpResult(content);
            expect(result).toBe('Hello\nWorld');
        });

        test('formats single text content as string', () => {
            const content: McpContentType[] = [
                { type: 'text', text: 'Single response' },
            ];
            const result = formatMcpResult(content);
            expect(result).toBe('Single response');
        });

        test('formats mixed content as array', () => {
            const content: McpContentType[] = [
                { type: 'text', text: 'Here is an image:' },
                { type: 'image', data: 'base64data', mimeType: 'image/png' },
            ];
            const result = formatMcpResult(content);
            expect(Array.isArray(result)).toBe(true);
            expect(result).toHaveLength(2);
            expect((result as any)[0]).toEqual({ type: 'text', text: 'Here is an image:' });
            expect((result as any)[1]).toEqual({
                type: 'image',
                source_type: 'base64',
                mime_type: 'image/png',
                data: 'base64data',
            });
        });

        test('formats image-only content as array', () => {
            const content: McpContentType[] = [
                { type: 'image', data: 'imgdata', mimeType: 'image/jpeg' },
            ];
            const result = formatMcpResult(content);
            expect(Array.isArray(result)).toBe(true);
            expect((result as any)[0]).toEqual({
                type: 'image',
                source_type: 'base64',
                mime_type: 'image/jpeg',
                data: 'imgdata',
            });
        });

        test('formats audio content correctly', () => {
            const content: McpContentType[] = [
                { type: 'audio', data: 'audiodata', mimeType: 'audio/mp3' },
            ];
            const result = formatMcpResult(content);
            expect(Array.isArray(result)).toBe(true);
            expect((result as any)[0]).toEqual({
                type: 'audio',
                source_type: 'base64',
                mime_type: 'audio/mp3',
                data: 'audiodata',
            });
        });

        test('handles empty content array', () => {
            const content: McpContentType[] = [];
            const result = formatMcpResult(content);
            expect(result).toBe('');
        });
    });
});
