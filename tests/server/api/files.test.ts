import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import api from '../../../src/server/routes/api';

// Under os.tmpdir(), one of the allowed roots, like the uploads directory the app itself uses
const dir = path.join(os.tmpdir(), 'pipali', `files-test-${crypto.randomUUID()}`);
const imagePath = path.join(dir, 'chart.png');
const textPath = path.join(dir, 'notes.txt');
const escapingLinkPath = path.join(dir, 'hosts-link.png');
// The working directory is the one place under $HOME a sandboxed test may write
const cwdUnderHome = !path.relative(os.homedir(), process.cwd()).startsWith('..');
const homeImagePath = path.join(process.cwd(), `.files-test-${crypto.randomUUID()}.png`);
const created = [imagePath, textPath, escapingLinkPath, homeImagePath];

// The route trusts the extension; the bytes only need to round-trip
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(imagePath, PNG_HEADER);
    await writeFile(textPath, 'not an image\n');
    await symlink('/etc/hosts', escapingLinkPath);
    if (cwdUnderHome) await writeFile(homeImagePath, PNG_HEADER);
});

afterAll(async () => {
    await Promise.all(created.map(filePath => rm(filePath, { force: true })));
    await rm(dir, { recursive: true, force: true });
});

function imageRequest(filePath: string): Request {
    return new Request(`http://127.0.0.1:6464/api/files?path=${encodeURIComponent(filePath)}`);
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
