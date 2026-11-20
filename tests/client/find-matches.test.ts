import { describe, expect, test } from 'bun:test';
import { findMatchSpans } from '../../src/client/utils/find-matches';

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
