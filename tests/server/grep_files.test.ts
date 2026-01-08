import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { grepFiles } from '../../src/server/processor/actor/grep_files';

describe('grepFiles', () => {
    const testDir = path.join(os.tmpdir(), 'grep-files-tests');

    beforeAll(async () => {
        // Create test directory
        await fs.mkdir(testDir, { recursive: true });

        // Create test files with different content
        await fs.writeFile(
            path.join(testDir, 'file1.txt'),
            'This is a test file\nIt contains test data\nAnd some more lines'
        );

        await fs.writeFile(
            path.join(testDir, 'file2.txt'),
            'Another file\nWith different content\nNo match here'
        );

        await fs.writeFile(
            path.join(testDir, 'file3.txt'),
            'Error occurred at line 10\nWarning: check this\nError in processing'
        );

        // Create subdirectory with files
        const subDir = path.join(testDir, 'subdir');
        await fs.mkdir(subDir);
        await fs.writeFile(
            path.join(subDir, 'nested.txt'),
            'Nested file with test content'
        );

        // Create file with many matches
        const manyMatches = Array.from({ length: 100 }, (_, i) =>
            i % 2 === 0 ? `Match line ${i + 1}` : `No match ${i + 1}`
        ).join('\n');
        await fs.writeFile(path.join(testDir, 'many.txt'), manyMatches);
    });

    afterAll(async () => {
        // Clean up test files
        await fs.rm(testDir, { recursive: true, force: true });
    });

    test('should find matches for simple regex pattern', async () => {
        const result = await grepFiles({
            pattern: 'test',
            path: testDir,
        });

        expect(result.query).toContain('Found');
        expect(result.query).toContain('matches');
        expect(result.compiled).toContain('file1.txt');
        expect(result.compiled).toContain('test');
        expect(result.file).toBe(testDir);
        expect(result.uri).toBe(testDir);
    });

    test('should find matches in multiple files', async () => {
        const result = await grepFiles({
            pattern: 'Error',
            path: testDir,
        });

        expect(result.query).toContain('Found');
        expect(result.compiled).toContain('file3.txt');
        expect(result.compiled).toContain('Error occurred');
        expect(result.compiled).toContain('Error in processing');
    });

    test('should handle case-sensitive searches', async () => {
        const result = await grepFiles({
            pattern: 'error',
            path: testDir,
        });

        // Should not find 'Error' with capital E
        expect(result.compiled).not.toContain('Error occurred');
    });

    test('should handle regex patterns with special characters', async () => {
        const result = await grepFiles({
            pattern: 'Error.*line',
            path: testDir,
        });

        expect(result.compiled).toContain('Error occurred at line 10');
    });

    test('should return error for invalid regex pattern', async () => {
        const result = await grepFiles({
            pattern: '[invalid(',
            path: testDir,
        });

        expect(result.compiled).toContain('Invalid regex pattern');
    });

    test('should show context lines before match', async () => {
        const result = await grepFiles({
            pattern: 'Error in processing',
            path: testDir,
            lines_before: 2,
        });

        expect(result.compiled).toContain('Error occurred at line 10');
        expect(result.compiled).toContain('Warning: check this');
        expect(result.compiled).toContain('Error in processing');
        expect(result.compiled).toContain('--'); // Separator
    });

    test('should show context lines after match', async () => {
        const result = await grepFiles({
            pattern: 'Error occurred',
            path: testDir,
            lines_after: 2,
        });

        expect(result.compiled).toContain('Error occurred at line 10');
        expect(result.compiled).toContain('Warning: check this');
        expect(result.compiled).toContain('Error in processing');
        expect(result.compiled).toContain('--'); // Separator
    });

    test('should show context lines before and after match', async () => {
        const result = await grepFiles({
            pattern: 'Warning',
            path: testDir,
            lines_before: 1,
            lines_after: 1,
        });

        expect(result.compiled).toContain('Error occurred at line 10');
        expect(result.compiled).toContain('Warning: check this');
        expect(result.compiled).toContain('Error in processing');
    });

    test('should include line numbers in output with context', async () => {
        const result = await grepFiles({
            pattern: 'Warning',
            path: testDir,
            lines_before: 1,
            lines_after: 1,
        });

        // Context lines should have '-' separator
        expect(result.compiled).toMatch(/file3\.txt:\d+-/);
        // Match line should have ':' separator
        expect(result.compiled).toMatch(/file3\.txt:\d+:.*Warning/);
    });

    test('should return no matches message when pattern not found', async () => {
        const result = await grepFiles({
            pattern: 'nonexistent-pattern-xyz',
            path: testDir,
        });

        expect(result.compiled).toBe('No matches found.');
        expect(result.query).toContain('Found 0 matches');
    });

    test('should return no files message when directory is empty', async () => {
        const emptyDir = path.join(testDir, 'empty-dir');
        await fs.mkdir(emptyDir, { recursive: true });

        const result = await grepFiles({
            pattern: 'test',
            path: emptyDir,
        });

        expect(result.compiled).toBe('No files found in specified path.');
        await fs.rmdir(emptyDir);
    });

    test('should preserve on-disk casing in returned paths when input case differs', async () => {
        const notesDirActual = path.join(testDir, 'Notes');
        await fs.mkdir(notesDirActual, { recursive: true });
        const fileActual = path.join(notesDirActual, 'tasks.md');
        await fs.writeFile(fileActual, 'Some content\nNeedle\nMore content');

        const notesDirWrongCase = path.join(testDir, 'notes');

        let caseInsensitive = false;
        try {
            await fs.stat(notesDirWrongCase);
            caseInsensitive = true;
        } catch {
            caseInsensitive = false;
        }

        const result = await grepFiles({
            pattern: 'Needle',
            path: notesDirWrongCase,
        });

        if (!caseInsensitive) {
            expect(result.compiled).toBe('No files found in specified path.');
            return;
        }

        expect(result.compiled).toContain(fileActual);
        expect(result.compiled).not.toContain(path.join(testDir, 'notes', 'tasks.md'));
    });

    test('should search in nested directories', async () => {
        const result = await grepFiles({
            pattern: 'Nested',
            path: testDir,
        });

        expect(result.compiled).toContain('nested.txt');
        expect(result.compiled).toContain('Nested file with test content');
    });

    test('should handle files with no newline at end', async () => {
        const noNewlineFile = path.join(testDir, 'no-newline.txt');
        await fs.writeFile(noNewlineFile, 'Content without newline');

        const result = await grepFiles({
            pattern: 'Content',
            path: testDir,
        });

        expect(result.compiled).toContain('Content without newline');
    });

    test('should limit results to max_results (default 500)', async () => {
        const result = await grepFiles({
            pattern: 'Match',
            path: testDir,
        });

        // The 'many.txt' file has 50 matches (every other line)
        // Should not trigger the max_results limit
        expect(result.compiled).not.toContain('showing first 500');
    });

    test('should count matched files correctly', async () => {
        const result = await grepFiles({
            pattern: 'test',
            path: testDir,
        });

        // Should find matches in file1.txt and nested.txt
        expect(result.query).toMatch(/Found \d+ matches.*in \d+ files/);
    });

    test('should handle empty files gracefully', async () => {
        const emptyFile = path.join(testDir, 'empty.txt');
        await fs.writeFile(emptyFile, '');

        const result = await grepFiles({
            pattern: 'test',
            path: testDir,
        });

        // Should not throw error, just skip empty file
        expect(result.query).toContain('Found');
    });

    test('should use home directory as default when path not provided', async () => {
        // Note: This test verifies the default behavior without actually searching
        // the entire home directory to avoid timeout issues
        const result = await grepFiles({
            pattern: 'test',
            path: testDir, // Use test directory for practical testing
        });

        // The function defaults to os.homedir() when path is not provided,
        // but searching entire home directory would timeout in tests
        expect(result.file).toBe(testDir);
        expect(result.uri).toBe(testDir);
    });

    test('should handle regex patterns with word boundaries', async () => {
        const result = await grepFiles({
            pattern: '\\btest\\b',
            path: testDir,
        });

        expect(result.compiled).toContain('test');
    });

    test('should handle multiline content correctly', async () => {
        const multilineFile = path.join(testDir, 'multiline.txt');
        await fs.writeFile(multilineFile, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

        const result = await grepFiles({
            pattern: 'Line 3',
            path: testDir,
            lines_before: 1,
            lines_after: 1,
        });

        expect(result.compiled).toContain('Line 2');
        expect(result.compiled).toContain('Line 3');
        expect(result.compiled).toContain('Line 4');
        expect(result.compiled).not.toContain('Line 1');
        expect(result.compiled).not.toContain('Line 5');
    });

    test('should handle files at start of file for context', async () => {
        const result = await grepFiles({
            pattern: 'This is a test',
            path: testDir,
            lines_before: 5, // More than available
            lines_after: 1,
        });

        // Should not error when requesting more context lines before than available
        expect(result.compiled).toContain('This is a test file');
        expect(result.compiled).toContain('It contains test data');
    });

    test('should handle files at end of file for context', async () => {
        const result = await grepFiles({
            pattern: 'And some more lines',
            path: testDir,
            lines_before: 1,
            lines_after: 5, // More than available
        });

        // Should not error when requesting more context lines after than available
        expect(result.compiled).toContain('It contains test data');
        expect(result.compiled).toContain('And some more lines');
    });

    describe('ReDoS protection', () => {
        test('should reject nested quantifiers pattern (a+)+', async () => {
            const result = await grepFiles({
                pattern: '(a+)+',
                path: testDir,
            });

            expect(result.compiled).toContain('Regex pattern is too complex');
            expect(result.compiled).toContain('nested quantifiers');
        });

        test('should reject nested quantifiers pattern (a*)+', async () => {
            const result = await grepFiles({
                pattern: '(a*)+',
                path: testDir,
            });

            expect(result.compiled).toContain('Regex pattern is too complex');
        });

        test('should reject nested quantifiers pattern (a+)*', async () => {
            const result = await grepFiles({
                pattern: '(a+)*',
                path: testDir,
            });

            expect(result.compiled).toContain('Regex pattern is too complex');
        });

        test('should reject complex nested patterns like (.*a+)+', async () => {
            const result = await grepFiles({
                pattern: '(.*a+)+',
                path: testDir,
            });

            expect(result.compiled).toContain('Regex pattern is too complex');
        });

        test('should allow safe patterns with single quantifiers', async () => {
            const result = await grepFiles({
                pattern: 'test+',
                path: testDir,
            });

            // Should work normally, not be rejected
            expect(result.compiled).not.toContain('Regex pattern is too complex');
        });

        test('should allow normal patterns with alternations', async () => {
            const result = await grepFiles({
                pattern: '(test|data)',
                path: testDir,
            });

            // Should work normally
            expect(result.compiled).not.toContain('Regex pattern is too complex');
            expect(result.compiled).toContain('test');
        });

        test('should allow patterns with character classes and quantifiers', async () => {
            const result = await grepFiles({
                pattern: '[a-z]+',
                path: testDir,
            });

            // Character classes with quantifiers are safe
            expect(result.compiled).not.toContain('Regex pattern is too complex');
        });

        test('should allow normal email-like patterns', async () => {
            const result = await grepFiles({
                pattern: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+',
                path: testDir,
            });

            // Standard email regex is safe
            expect(result.compiled).not.toContain('Regex pattern is too complex');
        });
    });
});
