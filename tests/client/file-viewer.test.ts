import { describe, expect, test } from 'bun:test';
import {
    fileViewKind,
    highlightLanguage,
    highlightSource,
    resolveDocumentLink,
    RICH_RENDER_MAX_CHARS,
} from '../../src/client/utils/file-viewer';
import { fileUrlToPath } from '../../src/client/utils/formatting';

describe('fileViewKind', () => {
    test('picks the view by extension, case-insensitively', () => {
        expect(fileViewKind('/tmp/pipali/report.HTML')).toBe('html');
        expect(fileViewKind('/Users/me/notes.md')).toBe('markdown');
        expect(fileViewKind('/Users/me/chart.png')).toBe('image');
        expect(fileViewKind('/Users/me/script.ts')).toBe('text');
    });

    test('treats office text of any extension as text', () => {
        expect(fileViewKind('/Users/me/minutes.txt')).toBe('text');
        expect(fileViewKind('/Users/me/export.csv')).toBe('text');
        expect(fileViewKind('/Users/me/invite.ics')).toBe('text');
        expect(fileViewKind('/Users/me/transcript.srt')).toBe('text');
        expect(fileViewKind('/Users/me/thread.eml')).toBe('text');
        expect(fileViewKind('/Users/me/journal.org')).toBe('text');
        expect(fileViewKind('/Users/me/Makefile')).toBe('text');
        expect(fileViewKind('/Users/me/.bashrc')).toBe('text');
    });

    test('leaves documents with their own viewer, archives, media and folders to the system', () => {
        expect(fileViewKind('/Users/me/deck.pptx')).toBeNull();
        expect(fileViewKind('/Users/me/paper.pdf')).toBeNull();
        expect(fileViewKind('/Users/me/backup.zip')).toBeNull();
        expect(fileViewKind('/Users/me/demo.mp4')).toBeNull();
        expect(fileViewKind('/Users/me/Reports/')).toBeNull();
    });
});

describe('highlightSource', () => {
    test('maps extensions to registered grammars', () => {
        expect(highlightLanguage('a.tsx')).toBe('typescript');
        expect(highlightLanguage('a.yml')).toBe('yaml');
        expect(highlightLanguage('Cargo.toml')).toBe('ini');
        expect(highlightLanguage('changes.patch')).toBe('diff');
        expect(highlightLanguage('paper.tex')).toBe('latex');
        expect(highlightLanguage('deploy.ps1')).toBe('powershell');
        expect(highlightLanguage('a.txt')).toBeNull();
    });

    test('emits only its own spans around escaped source', () => {
        const html = highlightSource('const x = "<b>";', 'typescript');
        expect(html).toContain('hljs-keyword');
        expect(html).toContain('&lt;b&gt;');
        expect(html).not.toContain('<b>');
    });

    test('skips highlighting without a grammar or past the size limit', () => {
        expect(highlightSource('plain', null)).toBeNull();
        expect(highlightSource('x'.repeat(RICH_RENDER_MAX_CHARS + 1), 'typescript')).toBeNull();
    });
});

describe('fileUrlToPath', () => {
    test('decodes posix, windows and percent-encoded file URLs', () => {
        expect(fileUrlToPath('file:///Users/me/report.html')).toBe('/Users/me/report.html');
        expect(fileUrlToPath('file:///Users/me/My%20Docs/a.md')).toBe('/Users/me/My Docs/a.md');
        expect(fileUrlToPath('file:///Users/me/My Docs/a.md')).toBe('/Users/me/My Docs/a.md');
        expect(fileUrlToPath('file:///C:/Users/me/a.md')).toBe('C:/Users/me/a.md');
    });

    test('keeps home-relative paths the model wrote as they are', () => {
        expect(fileUrlToPath('file://~/Code/khoj/infer.yaml')).toBe('~/Code/khoj/infer.yaml');
        expect(fileUrlToPath('file://Code/khoj/infer.yaml')).toBe('Code/khoj/infer.yaml');
        expect(fileUrlToPath('file://localhost/Users/me/a.md')).toBe('/Users/me/a.md');
    });

    test('passes anything that is not a file URL through', () => {
        expect(fileUrlToPath('/Users/me/a.md')).toBe('/Users/me/a.md');
        expect(fileUrlToPath('https://example.com')).toBe('https://example.com');
    });
});

describe('resolveDocumentLink', () => {
    const doc = '/Users/me/report/index.html';

    test('sends web links to the browser and file links to the viewer', () => {
        expect(resolveDocumentLink('https://example.com/x', doc)).toEqual({ kind: 'web', url: 'https://example.com/x' });
        expect(resolveDocumentLink('file:///Users/me/other.md', doc)).toEqual({ kind: 'file', path: '/Users/me/other.md' });
    });

    test('resolves relative links against the document folder', () => {
        expect(resolveDocumentLink('chapter2.html', doc)).toEqual({ kind: 'file', path: '/Users/me/report/chapter2.html' });
        expect(resolveDocumentLink('../notes.md', doc)).toEqual({ kind: 'file', path: '/Users/me/notes.md' });
        expect(resolveDocumentLink('img/chart.png', 'C:\\Users\\me\\report\\index.html'))
            .toEqual({ kind: 'file', path: 'C:/Users/me/report/img/chart.png' });
    });

    test('blocks every other scheme', () => {
        expect(resolveDocumentLink('javascript:alert(1)', doc)).toEqual({ kind: 'blocked' });
        expect(resolveDocumentLink('data:text/html,hi', doc)).toEqual({ kind: 'blocked' });
        expect(resolveDocumentLink('mailto:a@b.c', doc)).toEqual({ kind: 'blocked' });
    });
});
