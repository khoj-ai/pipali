/**
 * Local file routes for the chat UI: images referenced inline and the source of files
 * the viewer panel renders.
 *
 * Both routes share one resolver. A path must sit under an allowed root, its realpath must
 * still sit under one, and it must not match the read deny-list the agent's own view_file
 * consults. The viewer has no user to ask, so a protected path is refused outright.
 *
 * The content route never emits text/html. Whatever the file's extension, the body is
 * text/plain with nosniff and a sandboxing CSP, so the URL opened directly in a tab shows
 * source rather than a page running on the API's origin. The client decides how to render.
 */

import os from 'os';
import path from 'path';
import { realpath, stat } from 'fs/promises';
import { Hono } from 'hono';
import { isPathDeniedForRead } from '../sandbox';
import { expandPath } from '../utils';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'files-routes' });

const files = new Hono();

const IMAGE_MIME: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp',
};

export const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

const ALLOWED_ROOTS_RAW = [
    os.homedir(),
    '/tmp/pipali',
    '/private/tmp/pipali', // macOS: /tmp symlinks to /private/tmp
    os.tmpdir(),
];

// Resolve symlinks in allowed roots so realpath-resolved file paths still match.
// On macOS, /var → /private/var, so os.tmpdir() "/var/folders/..." resolves to "/private/var/folders/...".
let resolvedRoots: string[] | null = null;
async function getAllowedRoots(): Promise<string[]> {
    if (resolvedRoots) return resolvedRoots;
    const roots = new Set(ALLOWED_ROOTS_RAW);
    for (const root of ALLOWED_ROOTS_RAW) {
        try { roots.add(await realpath(root)); } catch {}
    }
    resolvedRoots = [...roots];
    return resolvedRoots;
}

function isUnderAllowedRoot(filePath: string, roots: string[]): boolean {
    return roots.some(root => filePath.startsWith(root + '/'));
}

type ServableFile =
    | { ok: true; realPath: string; size: number }
    | { ok: false; status: 403 | 404; error: string };

async function resolveServableFile(filePath: string): Promise<ServableFile> {
    const roots = await getAllowedRoots();
    // ~ and home-relative paths, as the file tools read them and the model writes them
    const expanded = expandPath(filePath);
    const resolved = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(os.homedir(), expanded);
    if (!isUnderAllowedRoot(resolved, roots)) {
        return { ok: false, status: 403, error: 'Path not within allowed directories' };
    }
    // Checked before realpath so a protected path is refused without revealing whether it exists
    if (isPathDeniedForRead(resolved)) {
        return { ok: false, status: 403, error: 'Path is protected' };
    }

    let real: string;
    try {
        real = await realpath(resolved);
    } catch {
        return { ok: false, status: 404, error: 'File not found' };
    }
    if (!isUnderAllowedRoot(real, roots) || isPathDeniedForRead(real)) {
        return { ok: false, status: 403, error: 'Path not within allowed directories' };
    }

    const info = await stat(real);
    if (!info.isFile()) return { ok: false, status: 404, error: 'File not found' };
    return { ok: true, realPath: real, size: info.size };
}

// Serve local image files referenced in model responses
files.get('/', async (c) => {
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'Missing path parameter' }, 400);

    const ext = path.extname(filePath).toLowerCase();
    if (!IMAGE_MIME[ext]) return c.json({ error: 'Only image files can be served' }, 403);

    const file = await resolveServableFile(filePath);
    if (!file.ok) return c.json({ error: file.error }, file.status);

    try {
        return c.body(await Bun.file(file.realPath).arrayBuffer(), 200, {
            'Content-Type': IMAGE_MIME[ext],
            'Cache-Control': 'private, max-age=3600',
        });
    } catch (err) {
        log.error({ err, path: file.realPath }, 'Failed to serve file');
        return c.json({ error: 'Failed to read file' }, 500);
    }
});

// Source of a text file for the viewer panel, always as inert plain text
files.get('/content', async (c) => {
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'Missing path parameter' }, 400);

    const file = await resolveServableFile(filePath);
    if (!file.ok) return c.json({ error: file.error }, file.status);
    if (file.size > MAX_CONTENT_BYTES) return c.json({ error: 'File too large to view' }, 413);

    try {
        const bytes = new Uint8Array(await Bun.file(file.realPath).arrayBuffer());
        if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
            return c.json({ error: 'Binary files cannot be viewed as text' }, 415);
        }
        return c.body(bytes, 200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': 'sandbox',
            'Cache-Control': 'no-store',
            // The absolute path behind a ~ or home-relative request, for the client to show and open
            'X-File-Path': file.realPath,
        });
    } catch (err) {
        log.error({ err, path: file.realPath }, 'Failed to serve file content');
        return c.json({ error: 'Failed to read file' }, 500);
    }
});

export default files;
