import { describe, expect, test } from 'bun:test';
import {
    fileViewKind,
    highlightLanguage,
    highlightSource,
    resolveDocumentLink,
    RICH_RENDER_MAX_CHARS,
} from '../../src/client/utils/file-viewer';
import { fileUrlToPath, parseFileLink } from '../../src/client/utils/formatting';

describe('fileViewKind', () => {
    test('picks the view by extension, case-insensitively', () => {
        expect(fileViewKind('/tmp/pipali/report.HTML')).toBe('html');
        expect(fileViewKind('/Users/me/notes.md')).toBe('markdown');
        expect(fileViewKind('/Users/me/chart.png')).toBe('image');
        expect(fileViewKind('/Users/me/script.ts')).toBe('text');
        expect(fileViewKind('/Users/me/brief.docx')).toBe('docx');
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
        expect(fileViewKind('/Users/me/legacy.doc')).toBeNull();
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
        expect(highlightLanguage('journal.org')).toBe('org');
        expect(highlightLanguage('a.txt')).toBeNull();
    });

    test('emits only its own spans around escaped source', () => {
        const html = highlightSource('const x = "<b>";', 'typescript');
        expect(html).toContain('hljs-keyword');
        expect(html).toContain('&lt;b&gt;');
        expect(html).not.toContain('<b>');
    });

    test('marks org-mode structure and leaves paths alone', () => {
        const html = highlightSource(
            '* TODO [#A] Call the bank :finance:\n'
            + 'SCHEDULED: <2026-09-08 Mon>\n'
            + '- [ ] see [[https://example.com][the site]] under /usr/bin/ for *this* one',
            'org',
        );
        expect(html).toContain('<span class="hljs-section">* <span class="hljs-keyword">TODO</span>');
        expect(html).toContain('<span class="hljs-number">[#A]</span>');
        expect(html).toContain('<span class="hljs-symbol">:finance:</span>');
        expect(html).toContain('<span class="hljs-keyword">SCHEDULED:</span>');
        expect(html).toContain('<span class="hljs-number">&lt;2026-09-08 Mon&gt;</span>');
        expect(html).toContain('<span class="hljs-literal">[ ]</span>');
        expect(html).toContain('<span class="hljs-link">[[https://example.com][the site]]</span>');
        expect(html).toContain('<span class="hljs-strong">*this*</span>');
        expect(html).not.toContain('hljs-emphasis');
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

    test('drops the fragment', () => {
        expect(fileUrlToPath('file:///Users/me/a.ts#L42')).toBe('/Users/me/a.ts');
        expect(fileUrlToPath('file://~/a.ts#L42')).toBe('~/a.ts');
    });

    test('passes anything that is not a file URL through', () => {
        expect(fileUrlToPath('/Users/me/a.md')).toBe('/Users/me/a.md');
        expect(fileUrlToPath('https://example.com')).toBe('https://example.com');
    });
});

describe('parseFileLink', () => {
    test('reads the lines a fragment names, and leaves them off the path', () => {
        const lines = (start: number, end: number) => ({ kind: 'lines' as const, start, end });
        expect(parseFileLink('file:///Users/me/a.ts#L42')).toEqual({ path: '/Users/me/a.ts', target: lines(42, 42) });
        expect(parseFileLink('file:///Users/me/a.ts#L42-L50').target).toEqual(lines(42, 50));
        expect(parseFileLink('file:///Users/me/a.ts#L42-50').target).toEqual(lines(42, 50));
        expect(parseFileLink('file:///Users/me/a.ts#L50-L42').target).toEqual(lines(50, 50));
        expect(parseFileLink('file://~/notes/a.md#L3')).toEqual({ path: '~/notes/a.md', target: lines(3, 3) });
    });

    test('reads a text fragment, decoded, with its optional end', () => {
        const text = (fragment: string) => parseFileLink(`file:///Users/me/a.md#${fragment}`).target;
        expect(text(':~:text=Quarterly%20report')).toEqual({ kind: 'text', start: 'Quarterly report' });
        expect(text(':~:text=start%20here,end%20there')).toEqual({ kind: 'text', start: 'start here', end: 'end there' });
        expect(text(':~:text=a%2C%20b')).toEqual({ kind: 'text', start: 'a, b' });
        expect(text('intro:~:text=Budget')).toEqual({ kind: 'text', start: 'Budget' });
        expect(text(':~:text=Budget&text=Agenda')).toEqual({ kind: 'text', start: 'Budget' });
    });

    test('takes the first match, so a text fragment\'s prefix and suffix terms are dropped', () => {
        expect(parseFileLink('file:///a.md#:~:text=Q3-,Budget,-line').target).toEqual({ kind: 'text', start: 'Budget' });
        expect(parseFileLink('file:///a.md#:~:text=Q3-,Budget,plan,-line').target).toEqual({ kind: 'text', start: 'Budget', end: 'plan' });
        expect(parseFileLink('file:///a.md#:~:text=').target).toBeNull();
    });

    test('keeps an encoded # in the path and ignores a fragment it does not know', () => {
        expect(parseFileLink('file:///Users/me/issue%231.md#L2')).toEqual({
            path: '/Users/me/issue#1.md',
            target: { kind: 'lines', start: 2, end: 2 },
        });
        expect(parseFileLink('file:///Users/me/report.html#summary')).toEqual({ path: '/Users/me/report.html', target: null });
        expect(parseFileLink('file:///Users/me/a.ts')).toEqual({ path: '/Users/me/a.ts', target: null });
    });
});

describe('resolveDocumentLink', () => {
    const doc = '/Users/me/report/index.html';

    test('sends web links to the browser and file links to the viewer', () => {
        expect(resolveDocumentLink('https://example.com/x', doc)).toEqual({ kind: 'web', url: 'https://example.com/x' });
        expect(resolveDocumentLink('file:///Users/me/other.md', doc)).toEqual({ kind: 'file', path: '/Users/me/other.md', target: null });
    });

    test('resolves relative links against the document folder', () => {
        expect(resolveDocumentLink('chapter2.html', doc)).toEqual({ kind: 'file', path: '/Users/me/report/chapter2.html', target: null });
        expect(resolveDocumentLink('../notes.md', doc)).toEqual({ kind: 'file', path: '/Users/me/notes.md', target: null });
        expect(resolveDocumentLink('img/chart.png', 'C:\\Users\\me\\report\\index.html'))
            .toEqual({ kind: 'file', path: 'C:/Users/me/report/img/chart.png', target: null });
    });

    test('keeps where in the linked file to land', () => {
        expect(resolveDocumentLink('file:///Users/me/run.ts#L42', doc))
            .toEqual({ kind: 'file', path: '/Users/me/run.ts', target: { kind: 'lines', start: 42, end: 42 } });
        expect(resolveDocumentLink('../notes.md#:~:text=Budget', doc))
            .toEqual({ kind: 'file', path: '/Users/me/notes.md', target: { kind: 'text', start: 'Budget' } });
    });

    test('blocks every other scheme', () => {
        expect(resolveDocumentLink('javascript:alert(1)', doc)).toEqual({ kind: 'blocked' });
        expect(resolveDocumentLink('data:text/html,hi', doc)).toEqual({ kind: 'blocked' });
        expect(resolveDocumentLink('mailto:a@b.c', doc)).toEqual({ kind: 'blocked' });
    });
});
