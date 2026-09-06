/**
 * What the viewer panel can show and how. Kinds are chosen by extension so the decision is
 * cheap and testable; the server decides separately whether a path may be read at all.
 *
 * Anything not known to be binary is text. Office work produces notes, transcripts, exports,
 * calendars and mail in formats no grammar covers, and the server's NUL-byte check is the real
 * binary detector, so an allow-list of extensions would only ever be too short.
 */

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dos from 'highlight.js/lib/languages/dos';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import latex from 'highlight.js/lib/languages/latex';
import powershell from 'highlight.js/lib/languages/powershell';
import properties from 'highlight.js/lib/languages/properties';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import org from './org-grammar';
import { apiFetch } from './api';
import { fileUrlToPath } from './formatting';

const GRAMMARS = {
    bash, css, diff, dos, go, ini, javascript, json, latex, org, powershell, properties,
    python, rust, sql, typescript, xml, yaml,
};
for (const [name, grammar] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, grammar);

export type FileViewKind = 'html' | 'markdown' | 'text' | 'image';

const KIND_BY_EXTENSION: Record<string, FileViewKind> = {
    html: 'html', htm: 'html', xhtml: 'html',
    md: 'markdown', markdown: 'markdown',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
};

// Formats with a viewer of their own, or with no text to show
const EXTERNAL_EXTENSIONS = new Set([
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key',
    'rtf', 'pdf', 'epub',
    'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'dmg', 'pkg', 'iso',
    'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mov', 'avi', 'mkv', 'webm',
    'bmp', 'tif', 'tiff', 'ico', 'heic', 'psd', 'ai', 'sketch', 'fig',
    'exe', 'dll', 'so', 'dylib', 'app', 'bin', 'db', 'sqlite', 'sqlite3', 'pyc', 'class', 'jar', 'wasm',
    'ttf', 'otf', 'woff', 'woff2',
]);

const LANGUAGE_BY_EXTENSION: Record<string, keyof typeof GRAMMARS> = {
    sh: 'bash', bash: 'bash', zsh: 'bash',
    css: 'css',
    diff: 'diff', patch: 'diff',
    bat: 'dos', cmd: 'dos',
    go: 'go',
    ini: 'ini', toml: 'ini', cfg: 'ini',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonl: 'json',
    tex: 'latex', ltx: 'latex', sty: 'latex', cls: 'latex', bib: 'latex',
    org: 'org', org_archive: 'org',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
    properties: 'properties',
    py: 'python',
    rs: 'rust',
    sql: 'sql',
    ts: 'typescript', tsx: 'typescript',
    xml: 'xml', svg: 'xml', plist: 'xml', xsl: 'xml', xslt: 'xml', rss: 'xml', atom: 'xml',
    yaml: 'yaml', yml: 'yaml',
};

export function fileExtension(path: string): string {
    const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** How the viewer shows a file, or null when the operating system should open it instead. */
export function fileViewKind(path: string): FileViewKind | null {
    if (/[\\/]$/.test(path)) return null; // a folder
    const ext = fileExtension(path);
    if (KIND_BY_EXTENSION[ext]) return KIND_BY_EXTENSION[ext];
    return EXTERNAL_EXTENSIONS.has(ext) ? null : 'text';
}

export function highlightLanguage(path: string): string | null {
    return LANGUAGE_BY_EXTENSION[fileExtension(path)] ?? null;
}

/**
 * Beyond this, highlighting and markdown cost more than they help and the file renders as
 * plain text. react-markdown takes about 2 s per MB before the browser builds any DOM.
 */
export const RICH_RENDER_MAX_CHARS = 2000 * 1024;

/** Highlight.js markup for the source, or null when it should render as a plain text node. */
export function highlightSource(text: string, language: string | null): string | null {
    if (!language || text.length > RICH_RENDER_MAX_CHARS) return null;
    try {
        return hljs.highlight(text, { language }).value;
    } catch {
        return null;
    }
}

export type FileContentResult =
    /** `path` is the absolute path the server read, whatever form the request used */
    | { ok: true; text: string; path: string }
    | { ok: false; status: number };

export async function fetchFileContent(path: string): Promise<FileContentResult> {
    try {
        const res = await apiFetch(`/api/files/content?path=${encodeURIComponent(path)}`);
        if (!res.ok) return { ok: false, status: res.status };
        return { ok: true, text: await res.text(), path: res.headers.get('X-File-Path') || path };
    } catch {
        return { ok: false, status: 0 };
    }
}

export type DocumentLink =
    | { kind: 'web'; url: string }
    | { kind: 'file'; path: string }
    | { kind: 'blocked' };

/**
 * Where a link inside a rendered document leads. Relative links resolve against the
 * document's own folder, so a report can link its sibling pages. Any other scheme,
 * javascript: and data: among them, is blocked.
 */
export function resolveDocumentLink(href: string, documentPath: string): DocumentLink {
    if (/^https?:\/\//i.test(href)) return { kind: 'web', url: href };
    if (/^file:/i.test(href)) return { kind: 'file', path: fileUrlToPath(href) };
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: 'blocked' };
    try {
        const base = /^[a-zA-Z]:[\\/]/.test(documentPath)
            ? `file:///${documentPath.replace(/\\/g, '/')}`
            : `file://${documentPath}`;
        return { kind: 'file', path: fileUrlToPath(new URL(href, base).href) };
    } catch {
        return { kind: 'blocked' };
    }
}
