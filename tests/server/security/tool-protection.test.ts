import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { readFile } from '../../../src/server/processor/actor/read_file';
import { writeFile } from '../../../src/server/processor/actor/write_file';
import { editFile } from '../../../src/server/processor/actor/edit_file';
import { grepFiles } from '../../../src/server/processor/actor/grep_files';
import { openJudgedFile } from '../../../src/server/processor/actor/actor.utils';
import { getDefaultConfig } from '../../../src/server/sandbox/config';
import { initializeSandboxWithConfig } from '../../../src/server/sandbox';
import { isCaseInsensitiveFS } from '../../../src/server/utils';
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
            timestamp: new Date().toISOString(),
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
            expect(capturedRequests[0]!.message).toContain('SSH');

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

        test('should include attachments when user gives alternate guidance', async () => {
            const capturedRequests: ConfirmationRequest[] = [];
            const context: ConfirmationContext = {
                requestConfirmation: async (request) => {
                    capturedRequests.push(request);
                    return {
                        requestId: request.requestId,
                        selectedOptionId: CONFIRMATION_OPTIONS.GUIDANCE,
                        guidance: 'Use the attached sanitized copy instead.',
                        attachments: [
                            { path: '/tmp/pipali-upload/sanitized-key.txt', name: 'sanitized-key.txt' },
                        ],
                        timestamp: new Date().toISOString(),
                    };
                },
                preferences: createEmptyPreferences(),
            };

            const result = await readFile(
                { path: sensitiveFile },
                { confirmationContext: context }
            );

            expect(capturedRequests.length).toBe(1);
            expect(result.compiled).toContain('Use the attached sanitized copy instead.');
            expect(result.compiled).toContain('<attached_files>');
            expect(result.compiled).toContain('- /tmp/pipali-upload/sanitized-key.txt');
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
                        timestamp: new Date().toISOString(),
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

/**
 * The file tools judge the file a path leads to as well as the name given, so their prompts
 * follow the file touched however it is reached.
 */
describe('Tool Protection - Links and case', () => {
    let root: string;
    let allowed: string;
    let outside: string;
    let secret: string;

    async function asDeniedBy(run: (context: ConfirmationContext) => Promise<{ compiled: unknown }>) {
        const requests: ConfirmationRequest[] = [];
        const result = await run(createMockConfirmationContext(false, requests));
        return { requests, output: String(result.compiled) };
    }

    beforeAll(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pipali-links-')));
        allowed = path.join(root, 'allowed');
        outside = path.join(root, 'outside');
        secret = path.join(root, '.ssh', 'id_rsa');
        await fs.mkdir(path.dirname(secret));
        await fs.mkdir(allowed);
        await fs.mkdir(outside);
        await fs.writeFile(secret, 'FAKE_SSH_KEY_CONTENT');
        await fs.writeFile(path.join(outside, 'rc'), 'original');
        await fs.writeFile(path.join(allowed, 'notes.txt'), 'notes');
        await fs.symlink(secret, path.join(allowed, 'key'));
        await fs.symlink(path.dirname(secret), path.join(allowed, 'keys'));
        await fs.symlink(path.join(outside, 'rc'), path.join(allowed, 'rc'));
        await fs.symlink(path.join(outside, 'new-rc'), path.join(allowed, 'dangling'));
        await fs.symlink(outside, path.join(allowed, 'out'));
        await fs.symlink(path.join(allowed, 'notes.txt'), path.join(allowed, 'notes'));
        await initializeSandboxWithConfig({ ...getDefaultConfig(), enabled: false, allowedWritePaths: [allowed] });
    });

    afterAll(async () => {
        await initializeSandboxWithConfig({ ...getDefaultConfig(), enabled: false });
        await fs.rm(root, { recursive: true, force: true });
    });

    test('asks before reading a protected file through a link', async () => {
        const { requests, output } = await asDeniedBy(context => readFile({ path: path.join(allowed, 'key') }, { confirmationContext: context }));
        expect(requests.map(r => r.operation)).toEqual(['read_sensitive_file']);
        expect(requests[0]!.context?.affectedFiles).toEqual([secret]);
        expect(output).not.toContain('FAKE_SSH_KEY_CONTENT');
    });

    test.if(isCaseInsensitiveFS)('asks before reading a protected file spelled in another case', async () => {
        const { requests, output } = await asDeniedBy(context => readFile({ path: path.join(root, '.SSH', 'id_rsa') }, { confirmationContext: context }));
        expect(requests).toHaveLength(1);
        expect(output).not.toContain('FAKE_SSH_KEY_CONTENT');
    });

    test('asks before searching a protected folder through a link', async () => {
        const { requests, output } = await asDeniedBy(context => grepFiles({ pattern: 'FAKE', path: path.join(allowed, 'keys') }, { confirmationContext: context }));
        expect(requests.map(r => r.operation)).toEqual(['grep_sensitive_path']);
        expect(requests[0]!.context?.affectedFiles).toEqual([path.dirname(secret)]);
        expect(output).not.toContain('FAKE_SSH_KEY_CONTENT');
    });

    test('asks before writing through a link that leads out of the write folders, naming where it lands', async () => {
        const { requests } = await asDeniedBy(context => writeFile({ file_path: path.join(allowed, 'rc'), content: 'replaced' }, { confirmationContext: context }));
        expect(requests[0]!.context?.affectedFiles).toEqual([path.join(outside, 'rc')]);
        expect(await fs.readFile(path.join(outside, 'rc'), 'utf8')).toBe('original');
    });

    test('asks before creating a file through a dangling link, or folders through a linked one', async () => {
        const dangling = await asDeniedBy(context => writeFile({ file_path: path.join(allowed, 'dangling'), content: 'created' }, { confirmationContext: context }));
        expect(dangling.requests).toHaveLength(1);
        expect(await Bun.file(path.join(outside, 'new-rc')).exists()).toBe(false);

        const nested = await asDeniedBy(context => writeFile({ file_path: path.join(allowed, 'out', 'made', 'rc'), content: 'created' }, { confirmationContext: context }));
        expect(nested.requests).toHaveLength(1);
        expect(await Bun.file(path.join(outside, 'made')).exists()).toBe(false);
        expect(await fs.readdir(outside)).toEqual(['rc']);
    });

    test('asks before editing through a link that leads out of the write folders', async () => {
        const { requests } = await asDeniedBy(context => editFile({ file_path: path.join(allowed, 'rc'), old_string: 'original', new_string: 'replaced' }, { confirmationContext: context }));
        expect(requests[0]!.context?.affectedFiles).toEqual([path.join(outside, 'rc')]);
        expect(await fs.readFile(path.join(outside, 'rc'), 'utf8')).toBe('original');
    });

    test('writes through a link that stays in the write folders without asking', async () => {
        const { requests, output } = await asDeniedBy(context => writeFile({ file_path: path.join(allowed, 'notes'), content: 'updated' }, { confirmationContext: context }));
        expect(requests).toHaveLength(0);
        expect(output).toContain('Updated');
        expect(await fs.readFile(path.join(allowed, 'notes.txt'), 'utf8')).toBe('updated');
        expect((await fs.lstat(path.join(allowed, 'notes'))).isSymbolicLink()).toBe(true);
    });

    test('writes nothing through a link planted in a folder the write just made', async () => {
        const victim = path.join(outside, 'rc');
        const realMkdir = fs.mkdir;
        // As a sandboxed command watching for the folder can: link the file in before the write lands
        fs.mkdir = (async (...args: Parameters<typeof fs.mkdir>) => {
            const made = await realMkdir(...args);
            await fs.symlink(victim, path.join(String(args[0]), 'payload'));
            return made;
        }) as typeof fs.mkdir;
        try {
            const { requests, output } = await asDeniedBy(context => writeFile({ file_path: path.join(allowed, 'fresh', 'payload'), content: 'replaced' }, { confirmationContext: context }));
            expect(requests).toHaveLength(0);
            expect(output).toContain('changed while it was being written');
        } finally {
            fs.mkdir = realMkdir;
        }
        expect(await fs.readFile(victim, 'utf8')).toBe('original');
    });

    test('opens nothing for writing through a folder swapped for a link once judged', async () => {
        // Judged as a file in the write folders, before its folder became a link out of them
        const swapped = path.join(allowed, 'swapped');
        await fs.symlink(outside, swapped);
        await expect(openJudgedFile(path.join(swapped, 'rc'))).rejects.toThrow('changed while it was being written');
        expect(await fs.readFile(path.join(outside, 'rc'), 'utf8')).toBe('original');
    });

    describe('with write folders of their own', () => {
        afterAll(async () => {
            await initializeSandboxWithConfig({ ...getDefaultConfig(), enabled: false, allowedWritePaths: [allowed] });
        });

        test('writes without asking under a write folder spelled through a link', async () => {
            const linked = path.join(root, 'linked-allowed');
            await fs.symlink(allowed, linked);
            await initializeSandboxWithConfig({ ...getDefaultConfig(), enabled: false, allowedWritePaths: [linked] });

            const { requests } = await asDeniedBy(context => writeFile({ file_path: path.join(allowed, 'via-link.txt'), content: 'linked' }, { confirmationContext: context }));
            expect(requests).toHaveLength(0);
            expect(await fs.readFile(path.join(allowed, 'via-link.txt'), 'utf8')).toBe('linked');
        });

        test('asks before writing outside a write folder replaced with a link', async () => {
            const home = path.join(root, 'home');
            const writable = path.join(home, '.pipali');
            await fs.mkdir(writable, { recursive: true });
            await fs.writeFile(path.join(home, '.zshrc'), 'original');
            await initializeSandboxWithConfig({ ...getDefaultConfig(), enabled: false, allowedWritePaths: [writable] });

            // What a sandboxed command can do to a folder it may write: move it, and link home in its place
            await fs.rename(writable, path.join(root, 'moved-away'));
            await fs.symlink(home, writable);

            const { requests } = await asDeniedBy(context => writeFile({ file_path: path.join(home, '.zshrc'), content: 'replaced' }, { confirmationContext: context }));
            expect(requests).toHaveLength(1);
            expect(await fs.readFile(path.join(home, '.zshrc'), 'utf8')).toBe('original');
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
            expect(capturedRequests[0]!.message).toContain('private network');
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
            expect(capturedRequests[0]!.message).toContain('cloud instance metadata');
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
            expect(capturedRequests[0]!.context?.riskLevel).toBe('medium');
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
        expect(capturedRequests[0]!.context?.riskLevel).toBe('medium');
    });
});
