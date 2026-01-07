import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { readFile } from '../../src/server/processor/actor/read_file';

describe('readFile', () => {
    const testDir = path.join(os.tmpdir(), 'read-file-tests');
    const testFile = path.join(testDir, 'test.txt');
    const longFile = path.join(testDir, 'long.txt');
    const mixedCaseFile = path.join(testDir, 'MixedCase.TXT');

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

        // Create a file with mixed casing
        await fs.writeFile(mixedCaseFile, 'Mixed case content');
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

    test('should read file with offset and limit', async () => {
        const result = await readFile({
            path: testFile,
            offset: 1,  // 0-based, so skip line 1
            limit: 3,   // read 3 lines (lines 2, 3, 4)
        });

        expect(result.query).toBe(`View file: ${testFile} (offset=1, limit=3)`);
        expect(result.compiled).toContain('Line 2');
        expect(result.compiled).toContain('Line 3');
        expect(result.compiled).toContain('Line 4');
        expect(result.compiled).not.toContain('Line 1');
        expect(result.compiled).not.toContain('Line 5');
    });

    test('should read from offset with default limit', async () => {
        const result = await readFile({
            path: testFile,
            offset: 2,  // 0-based, skip first 2 lines
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

    test('should handle offset beyond file length gracefully', async () => {
        const result = await readFile({
            path: testFile,
            offset: 100,  // offset is clamped, so this returns empty content
        });

        // When offset exceeds file length, it returns empty content (clamped to end)
        expect(result.compiled).toBe('');
    });

    test('should start from beginning when offset is 0', async () => {
        const result = await readFile({
            path: testFile,
            offset: 0,
        });

        expect(result.compiled).toContain('Line 1');
        expect(result.compiled).toContain('Line 5');
    });

    test('should truncate to default 50 lines when no limit specified', async () => {
        const result = await readFile({
            path: longFile,
            offset: 0,
        });

        expect(result.compiled).toContain('Line 1');
        expect(result.compiled).toContain('Line 50');
        expect(result.compiled).not.toContain('Line 51');
        expect(result.compiled).toContain('[File truncated');
        expect(result.compiled).toContain('Use offset/limit parameters to view more');
    });

    test('should handle truncation starting from middle of file', async () => {
        const result = await readFile({
            path: longFile,
            offset: 24,  // 0-based, so this starts at line 25
        });

        expect(result.compiled).toContain('Line 25');
        expect(result.compiled).toContain('Line 74'); // 24 + 50 = 74 (50 lines total)
        expect(result.compiled).not.toContain('Line 75');
        expect(result.compiled).toContain('[File truncated');
    });

    test('should show truncation message when file has more lines than limit', async () => {
        // File has 100 lines, requesting 50
        const result = await readFile({
            path: longFile,
            offset: 0,
            limit: 50,
        });

        expect(result.compiled).toContain('Line 1');
        expect(result.compiled).toContain('Line 50');
        // Should show truncation since file has more lines
        expect(result.compiled).toContain('[File truncated');
        expect(result.compiled).toContain('showing lines 1-50 of 100');
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

    test('should read file with case-insensitive path', async () => {
        // Deliberately change casing in the filename
        const wrongCasePath = path.join(testDir, 'mixedcase.txt');
        const result = await readFile({ path: wrongCasePath });

        expect(result.compiled).toBe('Mixed case content');
    });

    describe('image files', () => {
        // Create a minimal valid PNG (1x1 red pixel)
        // PNG signature + IHDR + IDAT + IEND chunks
        const minimalPngBytes = new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk length + type
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 dimensions
            0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // bit depth, color type, etc + CRC
            0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
            0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
            0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59,
            0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
            0x44, 0xae, 0x42, 0x60, 0x82
        ]);

        test('should read PNG image and return multimodal content', async () => {
            const pngFile = path.join(testDir, 'test-image.png');
            await fs.writeFile(pngFile, minimalPngBytes);

            const result = await readFile({ path: pngFile });

            expect(result.isImage).toBe(true);
            expect(Array.isArray(result.compiled)).toBe(true);

            const compiled = result.compiled as Array<{ type: string; [key: string]: any }>;
            expect(compiled.length).toBe(2);

            const textBlock = compiled[0]!;
            const imageBlock = compiled[1]!;

            // First element should be text description
            expect(textBlock.type).toBe('text');
            expect(textBlock.text).toContain('Read image file:');
            expect(textBlock.text).toContain('image/png');

            // Second element should be image data
            expect(imageBlock.type).toBe('image');
            expect(imageBlock.source_type).toBe('base64');
            expect(imageBlock.mime_type).toBe('image/png');
            expect(typeof imageBlock.data).toBe('string');
            // Verify it's valid base64
            expect(() => Buffer.from(imageBlock.data, 'base64')).not.toThrow();
        });

        test.each([
            { ext: '.jpg', mimeType: 'image/jpeg' },
            { ext: '.jpeg', mimeType: 'image/jpeg' },
            { ext: '.webp', mimeType: 'image/webp' },
        ])('should return correct mime type for $ext extension', async ({ ext, mimeType }) => {
            const imageFile = path.join(testDir, `test-image${ext}`);
            // Minimal image bytes (just enough to create a file)
            await fs.writeFile(imageFile, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));

            const result = await readFile({ path: imageFile });

            expect(result.isImage).toBe(true);
            const compiled = result.compiled as Array<{ type: string; [key: string]: any }>;
            expect(compiled[1]!.mime_type).toBe(mimeType);
        });

        test('should ignore offset/limit parameters for images', async () => {
            const pngFile = path.join(testDir, 'offset-test.png');
            await fs.writeFile(pngFile, minimalPngBytes);

            // Even with offset/limit, should return full image
            const result = await readFile({ path: pngFile, offset: 10, limit: 5 });

            expect(result.isImage).toBe(true);
            const compiled = result.compiled as Array<{ type: string; [key: string]: any }>;
            // Should still have the full base64 data
            expect(compiled[1]!.data.length).toBeGreaterThan(0);
        });

        test('should return base64 that decodes back to original image bytes', async () => {
            const pngFile = path.join(testDir, 'roundtrip.png');
            await fs.writeFile(pngFile, minimalPngBytes);

            const result = await readFile({ path: pngFile });

            expect(result.isImage).toBe(true);
            const compiled = result.compiled as Array<{ type: string; [key: string]: any }>;

            // Decode base64 and verify it matches original bytes
            const decodedBytes = Buffer.from(compiled[1]!.data, 'base64');
            expect(decodedBytes.length).toBe(minimalPngBytes.length);
            expect(new Uint8Array(decodedBytes)).toEqual(minimalPngBytes);
        });
    });
});
