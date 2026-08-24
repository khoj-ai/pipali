import { afterEach, describe, expect, test } from 'bun:test';
import { readdir, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import api from '../../../src/server/routes/api';

const uploadDir = path.join(os.tmpdir(), 'pipali', 'uploads');
const createdPaths: string[] = [];

afterEach(async () => {
    await Promise.all(createdPaths.splice(0).map(filePath => rm(filePath, { force: true })));
});

function uploadRequest(fileName: string, origin?: string): Request {
    const body = new FormData();
    body.append('files', new File(['upload contents'], fileName, { type: 'text/plain' }));
    return new Request('http://127.0.0.1:6464/api/upload', {
        method: 'POST',
        headers: origin ? { Origin: origin } : undefined,
        body,
    });
}

describe('POST /api/upload', () => {
    test('keep multipart filenames inside the upload directory', async () => {
        const targetPath = path.join(os.tmpdir(), `pipali-upload-escape-${crypto.randomUUID()}.txt`);
        createdPaths.push(targetPath);

        const rootlessTarget = targetPath
            .slice(path.parse(targetPath).root.length)
            .split(path.sep)
            .join('/');
        const traversalName = `segment/${'../'.repeat(32)}${rootlessTarget}`;
        const response = await api.fetch(uploadRequest(traversalName));

        expect(response.status).toBe(200);
        const result = await response.json() as {
            files: Array<{ fileName: string; filePath: string }>;
        };
        const uploaded = result.files[0];
        if (!uploaded) throw new Error('Upload response did not include a file');
        createdPaths.push(uploaded.filePath);

        expect(uploaded.fileName).toBe(path.basename(targetPath));
        expect(path.dirname(uploaded.filePath)).toBe(uploadDir);
        expect(await Bun.file(uploaded.filePath).text()).toBe('upload contents');
        expect(await Bun.file(targetPath).exists()).toBe(false);
    });

    test('reject uploads from untrusted browser origins', async () => {
        const fileName = `blocked-${crypto.randomUUID()}.txt`;
        const response = await api.fetch(uploadRequest(fileName, 'https://untrusted.example'));

        if (response.ok) {
            const result = await response.json() as { files: Array<{ filePath: string }> };
            createdPaths.push(...result.files.map(file => file.filePath));
        }

        expect(response.status).toBe(403);
        const uploadedNames = await readdir(uploadDir).catch(() => []);
        expect(uploadedNames.some(name => name.endsWith(fileName))).toBe(false);
    });

    for (const origin of ['tauri://localhost', 'http://127.0.0.1:6464']) {
        test(`allows uploads from ${origin}`, async () => {
            const response = await api.fetch(uploadRequest('notes.txt', origin));

            expect(response.status).toBe(200);
            const result = await response.json() as { files: Array<{ filePath: string }> };
            createdPaths.push(...result.files.map(file => file.filePath));
        });
    }
});
