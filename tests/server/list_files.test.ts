import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { listFiles } from '../../src/server/processor/actor/list_files';

describe('listFiles', () => {
    const testDir = path.join(os.tmpdir(), 'list-files-tests');
    const subDir = path.join(testDir, 'subdir');

    beforeAll(async () => {
        // Create test directory structure
        await fs.mkdir(testDir, { recursive: true });
        await fs.mkdir(subDir, { recursive: true });

        // Create various test files
        await fs.writeFile(path.join(testDir, 'file1.txt'), 'content1');
        await fs.writeFile(path.join(testDir, 'file2.txt'), 'content2');
        await fs.writeFile(path.join(testDir, 'file3.md'), 'content3');
        await fs.writeFile(path.join(testDir, 'file4.js'), 'content4');
        await fs.writeFile(path.join(subDir, 'nested1.txt'), 'nested1');
        await fs.writeFile(path.join(subDir, 'nested2.md'), 'nested2');
    });

    afterAll(async () => {
        // Clean up test files
        await fs.rm(testDir, { recursive: true, force: true });
    });

    test('should list all files in directory when no pattern specified', async () => {
        const result = await listFiles({ path: testDir });

        expect(result.query).toContain('Found');
        expect(result.query).toContain('files');
        expect(result.compiled).toContain('file1.txt');
        expect(result.compiled).toContain('file2.txt');
        expect(result.compiled).toContain('file3.md');
        expect(result.compiled).toContain('file4.js');
        expect(result.file).toBe(testDir);
        expect(result.uri).toBe(testDir);
    });

    test('should filter files by pattern', async () => {
        const result = await listFiles({
            path: testDir,
            pattern: '*.txt',
        });

        expect(result.compiled).toContain('file1.txt');
        expect(result.compiled).toContain('file2.txt');
        expect(result.compiled).not.toContain('file3.md');
        expect(result.compiled).not.toContain('file4.js');
        expect(result.query).toContain('filtered by *.txt');
    });

    test('should handle glob patterns with multiple extensions', async () => {
        const result = await listFiles({
            path: testDir,
            pattern: '*.{txt,md}',
        });

        expect(result.compiled).toContain('file1.txt');
        expect(result.compiled).toContain('file2.txt');
        expect(result.compiled).toContain('file3.md');
        expect(result.compiled).not.toContain('file4.js');
    });

    test('should list files recursively with ** pattern', async () => {
        const result = await listFiles({
            path: testDir,
            pattern: '**/*.txt',
        });

        expect(result.compiled).toContain('file1.txt');
        expect(result.compiled).toContain('file2.txt');
        expect(result.compiled).toContain('nested1.txt');
        expect(result.compiled).not.toContain('file3.md');
    });

    test('should return no files message when no matches found', async () => {
        const result = await listFiles({
            path: testDir,
            pattern: '*.xyz',
        });

        expect(result.compiled).toBe('No files found.');
        expect(result.query).toContain('Found 0 files');
    });

    test('should return sorted file list', async () => {
        const result = await listFiles({ path: testDir });

        const files = result.compiled.split('\n').map(line => line.replace('- ', ''));
        const sortedFiles = [...files].sort();

        expect(files).toEqual(sortedFiles);
    });

    test('should format file list with bullet points', async () => {
        const result = await listFiles({ path: testDir });

        const lines = result.compiled.split('\n');
        expect(lines.every(line => line.startsWith('- '))).toBe(true);
    });

    test('should resolve home directory with ~', async () => {
        const result = await listFiles({ path: '~' });

        expect(result.file).toBe('~');
        expect(result.uri).toBe('~');
        // Should have some files in home directory
        expect(result.compiled).not.toBe('No files found.');
    });

    test('should resolve home directory with ~/', async () => {
        // Create a test directory in home
        const homeTestDir = path.join(os.homedir(), 'list-files-test-home');
        await fs.mkdir(homeTestDir, { recursive: true });
        await fs.writeFile(path.join(homeTestDir, 'home-test.txt'), 'test');

        const relativePath = path.relative(os.homedir(), homeTestDir);
        const result = await listFiles({ path: `~/${relativePath}` });

        expect(result.compiled).toContain('home-test.txt');

        // Clean up
        await fs.rm(homeTestDir, { recursive: true, force: true });
    });

    test('should resolve relative paths from home directory', async () => {
        // Create a test directory with a common name
        const commonDirName = 'list-files-test-relative';
        const relativeTestDir = path.join(os.homedir(), commonDirName);
        await fs.mkdir(relativeTestDir, { recursive: true });
        await fs.writeFile(path.join(relativeTestDir, 'relative-test.txt'), 'test');

        const result = await listFiles({ path: commonDirName });

        expect(result.compiled).toContain('relative-test.txt');

        // Clean up
        await fs.rm(relativeTestDir, { recursive: true, force: true });
    });

    test('should handle absolute paths correctly', async () => {
        const result = await listFiles({ path: testDir });

        expect(result.compiled).toContain('file1.txt');
    });

    test('should default to home directory when path is empty', async () => {
        const result = await listFiles({ path: '' });

        expect(result.file).toBe('');
        // Should list files from home directory
        expect(result.compiled).not.toBe('No files found.');
    });

    test('should default to home directory when path is not provided', async () => {
        const result = await listFiles({});

        expect(result.file).toBe('');
        // Should list files from home directory
        expect(result.compiled).not.toBe('No files found.');
    });

    test('should handle non-existent directory gracefully', async () => {
        const nonExistentDir = path.join(testDir, 'does-not-exist');
        const result = await listFiles({ path: nonExistentDir });

        expect(result.compiled).toBe('No files found.');
    });

    test('should include file count in query', async () => {
        const result = await listFiles({ path: testDir });

        const lines = result.compiled.split('\n');
        const fileCount = lines.length;

        expect(result.query).toContain(`Found ${fileCount} files`);
    });

    test('should include path in query when specified', async () => {
        const result = await listFiles({ path: testDir });

        expect(result.query).toContain(`in ${testDir}`);
    });

    test('should include pattern in query when specified', async () => {
        const result = await listFiles({
            path: testDir,
            pattern: '*.txt',
        });

        expect(result.query).toContain('filtered by *.txt');
    });

    test('should not include path in query when path is .', async () => {
        const result = await listFiles({ path: '.' });

        // Should not say "in ." when path is current directory
        expect(result.query).not.toContain('in .');
    });

    test('should handle pattern matching specific filenames', async () => {
        const result = await listFiles({
            path: testDir,
            pattern: 'file1.txt',
        });

        expect(result.compiled).toContain('file1.txt');
        expect(result.compiled).not.toContain('file2.txt');
    });

    test('should handle complex glob patterns', async () => {
        const result = await listFiles({
            path: testDir,
            pattern: 'file[1-2].*',
        });

        expect(result.compiled).toContain('file1.txt');
        expect(result.compiled).toContain('file2.txt');
        expect(result.compiled).not.toContain('file3.md');
        expect(result.compiled).not.toContain('file4.js');
    });

    test('should return absolute paths in file list', async () => {
        const result = await listFiles({ path: testDir });

        const files = result.compiled.split('\n');
        expect(files.every(line => {
            const filePath = line.replace('- ', '');
            return path.isAbsolute(filePath);
        })).toBe(true);
    });

    test('should handle directories with special characters', async () => {
        const specialDir = path.join(testDir, 'special-dir!@#');
        await fs.mkdir(specialDir, { recursive: true });
        await fs.writeFile(path.join(specialDir, 'special.txt'), 'content');

        const result = await listFiles({ path: specialDir });

        expect(result.compiled).toContain('special.txt');

        // Clean up
        await fs.rm(specialDir, { recursive: true, force: true });
    });

    test('should handle empty directory', async () => {
        const emptyDir = path.join(testDir, 'empty-dir');
        await fs.mkdir(emptyDir, { recursive: true });

        const result = await listFiles({ path: emptyDir });

        expect(result.compiled).toBe('No files found.');

        // Clean up
        await fs.rmdir(emptyDir);
    });

    test('should list files and directories', async () => {
        const result = await listFiles({ path: testDir });

        // Should include files
        expect(result.compiled).toContain('file1.txt');
        // glob includes directories as well
        expect(result.compiled).toContain('subdir');
    });
});
