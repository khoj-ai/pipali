import { describe, expect, test } from 'bun:test';
import { findMatchSpans, lineSpan } from '../../src/client/utils/find-matches';

describe('findMatchSpans', () => {
    test('finds a phrase that crosses the text nodes syntax highlighting splits it into', () => {
        // <span class="hljs-keyword">return</span> rows.reduce(...)
        const spans = findMatchSpans(['return', ' rows.reduce(', 'sum', ')'], 'RETURN rows');
        expect(spans).toEqual([{ startNode: 0, startOffset: 0, endNode: 1, endOffset: 5 }]);
    });

    test('ends a match on the text holding its last character, not the next one', () => {
        const spans = findMatchSpans(['abc', 'def'], 'abc');
        expect(spans).toEqual([{ startNode: 0, startOffset: 0, endNode: 0, endOffset: 3 }]);
    });

    test('treats a line break in the text as the space a query types', () => {
        const spans = findMatchSpans(['quarterly\nplanning review'], 'quarterly planning');
        expect(spans).toHaveLength(1);
    });

    test('keeps offsets true where lowercasing changes a character\'s length', () => {
        // 'İ'.toLowerCase() is two code units; the match after it must still land on its own text
        const spans = findMatchSpans(['İİ', 'target'], 'target');
        expect(spans).toEqual([{ startNode: 1, startOffset: 0, endNode: 1, endOffset: 6 }]);
    });
});

describe('lineSpan', () => {
    // `const` / ` a = 1;\n` / `b();` / `\n` / `done` : three lines when read end to end
    const texts = ['const', ' a = 1;\nb', '();\n', 'done'];

    test('runs from the start of the first line to the end of the last, across text nodes', () => {
        expect(lineSpan(texts, 1, 1)).toEqual({ startNode: 0, startOffset: 0, endNode: 1, endOffset: 7 });
        expect(lineSpan(texts, 2, 2)).toEqual({ startNode: 1, startOffset: 8, endNode: 2, endOffset: 3 });
        expect(lineSpan(texts, 1, 2)).toEqual({ startNode: 0, startOffset: 0, endNode: 2, endOffset: 3 });
    });

    test('starts a line at the end of the text node whose newline closes the one before', () => {
        expect(lineSpan(texts, 3, 3)).toEqual({ startNode: 2, startOffset: 4, endNode: 3, endOffset: 4 });
    });

    test('stops at the end of the text when the lines run past it, and finds nothing beyond it', () => {
        expect(lineSpan(texts, 2, 99)).toEqual({ startNode: 1, startOffset: 8, endNode: 3, endOffset: 4 });
        expect(lineSpan(texts, 4, 5)).toBeNull();
        expect(lineSpan([], 1, 1)).toBeNull();
    });
});
