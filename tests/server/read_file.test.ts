import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { readFile } from '../../src/server/processor/actor/read_file';

describe('readFile', () => {
    const testDir = path.join(os.tmpdir(), 'read-file-tests');
    const testFile = path.join(testDir, 'test.txt');
    const longFile = path.join(testDir, 'long.txt');

    beforeAll(async () => {
        // Create test directory
        await fs.mkdir(testDir, { recursive: true });

        // Create test file with known content
        const testContent = [
            'Line 1',
            'Line 2',
            'Line 3',
            'Line 4',
            'Line 5',
        ].join('\n');
        await fs.writeFile(testFile, testContent);

        // Create long file with more than 50 lines
        const longContent = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
        await fs.writeFile(longFile, longContent);
    });

    afterAll(async () => {
        // Clean up test files
        await fs.rm(testDir, { recursive: true, force: true });
    });

    test('should read entire file when no line range specified', async () => {
        const result = await readFile({ path: testFile });

        expect(result.query).toBe(`View file: ${testFile}`);
        expect(result.file).toBe(testFile);
        expect(result.uri).toBe(testFile);
        expect(result.compiled).toContain('Line 1');
        expect(result.compiled).toContain('Line 5');
    });

    test('should read file with line range', async () => {
        const result = await readFile({
            path: testFile,
            start_line: 2,
            end_line: 4,
        });

        expect(result.query).toBe(`View file: ${testFile} (lines 2-4)`);
        expect(result.compiled).toContain('Line 2');
        expect(result.compiled).toContain('Line 3');
        expect(result.compiled).toContain('Line 4');
        expect(result.compiled).not.toContain('Line 1');
        expect(result.compiled).not.toContain('Line 5');
    });

    test('should read from start_line to end of file if end_line not specified', async () => {
        const result = await readFile({
            path: testFile,
            start_line: 3,
        });

        expect(result.compiled).toContain('Line 3');
        expect(result.compiled).toContain('Line 4');
        expect(result.compiled).toContain('Line 5');
        expect(result.compiled).not.toContain('Line 1');
        expect(result.compiled).not.toContain('Line 2');
    });

    test('should return error when file does not exist', async () => {
        const nonExistentFile = path.join(testDir, 'does-not-exist.txt');
        const result = await readFile({ path: nonExistentFile });

        expect(result.query).toBe(`View file: ${nonExistentFile}`);
        expect(result.compiled).toContain('not found');
    });

    test('should return error when start_line is invalid', async () => {
        const result = await readFile({
            path: testFile,
            start_line: 100,
        });

        expect(result.compiled).toContain('Invalid start_line');
        expect(result.compiled).toContain('File has 5 lines');
    });

    test('should use default line 1 when start_line is 0', async () => {
        // start_line: 0 is falsy, so it defaults to 1
        const result = await readFile({
            path: testFile,
            start_line: 0,
        });

        expect(result.compiled).toContain('Line 1');
        expect(result.compiled).toContain('Line 5');
    });

    test('should truncate to 50 lines when more than 50 lines requested', async () => {
        const result = await readFile({
            path: longFile,
            start_line: 1,
            end_line: 100,
        });

        expect(result.compiled).toContain('Line 1');
        expect(result.compiled).toContain('Line 50');
        expect(result.compiled).not.toContain('Line 51');
        expect(result.compiled).toContain('[Truncated after 50 lines!');
        expect(result.compiled).toContain('Use narrower line range to view complete section');
    });

    test('should handle truncation starting from middle of file', async () => {
        const result = await readFile({
            path: longFile,
            start_line: 25,
            end_line: 100,
        });

        expect(result.compiled).toContain('Line 25');
        expect(result.compiled).toContain('Line 74'); // 25 + 49 = 74 (50 lines total)
        expect(result.compiled).not.toContain('Line 75');
        expect(result.compiled).toContain('[Truncated after 50 lines!');
    });

    test('should not truncate when exactly 50 lines requested', async () => {
        const result = await readFile({
            path: longFile,
            start_line: 1,
            end_line: 50,
        });

        expect(result.compiled).toContain('Line 1');
        expect(result.compiled).toContain('Line 50');
        expect(result.compiled).not.toContain('[Truncated after 50 lines!');
    });

    test('should handle relative paths by resolving them', async () => {
        // Use relative path from current directory
        const relativePath = path.relative(process.cwd(), testFile);
        const result = await readFile({ path: relativePath });

        expect(result.query).toBe(`View file: ${relativePath}`);
        expect(result.compiled).toContain('Line 1');
    });

    test('should handle files with empty content', async () => {
        const emptyFile = path.join(testDir, 'empty.txt');
        await fs.writeFile(emptyFile, '');

        const result = await readFile({ path: emptyFile });

        expect(result.query).toBe(`View file: ${emptyFile}`);
        expect(result.compiled).toBe('');
    });

    test('should handle single line files', async () => {
        const singleLineFile = path.join(testDir, 'single.txt');
        await fs.writeFile(singleLineFile, 'Single line');

        const result = await readFile({ path: singleLineFile });

        expect(result.compiled).toBe('Single line');
    });

    test('should handle files with special characters', async () => {
        const specialFile = path.join(testDir, 'special.txt');
        const specialContent = 'Line with special chars: !@#$%^&*()';
        await fs.writeFile(specialFile, specialContent);

        const result = await readFile({ path: specialFile });

        expect(result.compiled).toBe(specialContent);
    });
});
