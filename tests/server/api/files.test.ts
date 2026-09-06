import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, realpath, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import api from '../../../src/server/routes/api';
import { MAX_CONTENT_BYTES } from '../../../src/server/routes/files';

// Under os.tmpdir(), one of the allowed roots, like the uploads directory the app itself uses
const dir = path.join(os.tmpdir(), 'pipali', `files-test-${crypto.randomUUID()}`);
const imagePath = path.join(dir, 'chart.png');
const textPath = path.join(dir, 'notes.txt');
const htmlPath = path.join(dir, 'report.html');
const binaryPath = path.join(dir, 'blob.bin');
const hugePath = path.join(dir, 'huge.log');
const escapingLinkPath = path.join(dir, 'hosts-link.png');
// The working directory is the one place under $HOME a sandboxed test may write
const cwdUnderHome = !path.relative(os.homedir(), process.cwd()).startsWith('..');
const homeImagePath = path.join(process.cwd(), `.files-test-${crypto.randomUUID()}.png`);
const homeTextPath = path.join(process.cwd(), `.files-test-${crypto.randomUUID()}.txt`);
const created = [imagePath, textPath, htmlPath, binaryPath, hugePath, escapingLinkPath, homeImagePath, homeTextPath];

// The image route trusts the extension; the bytes only need to round-trip
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(imagePath, PNG_HEADER);
    await writeFile(textPath, 'first line\nsecond line\n');
    await writeFile(htmlPath, '<html><body><script>alert(1)</script></body></html>');
    await writeFile(binaryPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await writeFile(hugePath, Buffer.alloc(MAX_CONTENT_BYTES + 1, 0x61));
    await symlink('/etc/hosts', escapingLinkPath);
    if (cwdUnderHome) {
        await writeFile(homeImagePath, PNG_HEADER);
        await writeFile(homeTextPath, 'home sweet home\n');
    }
});

afterAll(async () => {
    await Promise.all(created.map(filePath => rm(filePath, { force: true })));
    await rm(dir, { recursive: true, force: true });
});

function imageRequest(filePath: string): Request {
    return new Request(`http://127.0.0.1:6464/api/files?path=${encodeURIComponent(filePath)}`);
}

function contentRequest(filePath: string): Request {
    return new Request(`http://127.0.0.1:6464/api/files/content?path=${encodeURIComponent(filePath)}`);
}

describe('GET /api/files', () => {
    test('serves an image under an allowed root', async () => {
        const response = await api.fetch(imageRequest(imagePath));

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('image/png');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_HEADER);
    });

    test.skipIf(!cwdUnderHome)('expands ~ and home-relative paths as the file tools do', async () => {
        const relative = path.relative(os.homedir(), homeImagePath);
        for (const requested of [`~/${relative}`, relative]) {
            const response = await api.fetch(imageRequest(requested));
            expect(response.status).toBe(200);
        }
    });

    test('serves only images', async () => {
        const response = await api.fetch(imageRequest(textPath));
        expect(response.status).toBe(403);
    });

    test('rejects paths outside the allowed roots', async () => {
        const response = await api.fetch(imageRequest('/etc/chart.png'));
        expect(response.status).toBe(403);
    });

    test('rejects protected paths without revealing whether they exist', async () => {
        const response = await api.fetch(imageRequest(path.join(os.homedir(), '.ssh', `files-test-${crypto.randomUUID()}.png`)));
        expect(response.status).toBe(403);
    });

    test('rejects a symlink whose target leaves the roots', async () => {
        const response = await api.fetch(imageRequest(escapingLinkPath));
        expect(response.status).toBe(403);
    });

    test('returns 404 for a missing file under an allowed root', async () => {
        const response = await api.fetch(imageRequest(path.join(dir, 'missing.png')));
        expect(response.status).toBe(404);
    });
});

describe('GET /api/files/content', () => {
    test('serves a text file under an allowed root as plain text', async () => {
        const response = await api.fetch(contentRequest(textPath));

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
        expect(await response.text()).toBe('first line\nsecond line\n');
    });

    test('never serves html as html, whatever the extension', async () => {
        const response = await api.fetch(contentRequest(htmlPath));

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(response.headers.get('Content-Security-Policy')).toBe('sandbox');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(await response.text()).toContain('<script>');
    });

    test.skipIf(!cwdUnderHome)('names the absolute path behind a ~ or home-relative request', async () => {
        const relative = path.relative(os.homedir(), homeTextPath);
        for (const requested of [`~/${relative}`, relative]) {
            const response = await api.fetch(contentRequest(requested));
            expect(response.status).toBe(200);
            expect(response.headers.get('X-File-Path')).toBe(await realpath(homeTextPath));
            expect(await response.text()).toBe('home sweet home\n');
        }
    });

    test('shares the resolver with the image route', async () => {
        expect((await api.fetch(contentRequest('/etc/hosts'))).status).toBe(403);
        expect((await api.fetch(contentRequest(escapingLinkPath))).status).toBe(403);
        expect((await api.fetch(contentRequest(path.join(dir, 'missing.txt')))).status).toBe(404);
    });

    test('refuses files over the size cap', async () => {
        const response = await api.fetch(contentRequest(hugePath));
        expect(response.status).toBe(413);
    });

    test('refuses binary content', async () => {
        const response = await api.fetch(contentRequest(binaryPath));
        expect(response.status).toBe(415);
    });
});
