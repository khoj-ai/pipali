/**
 * Find-in-document that leaves the DOM alone. Matches are Ranges painted through the CSS
 * Custom Highlight API, so a React-rendered tree, a syntax-highlighted block or a frame's
 * document keeps every node it had and a re-render never meets a node this code replaced.
 */

const FIND_HIGHLIGHT = 'file-find';
const FIND_HIGHLIGHT_ACTIVE = 'file-find-active';

/** Matches past this many are neither counted nor painted */
const MAX_MATCHES = 10_000;

// Keeps a match clear of the source view's sticky line-number gutter when scrolling sideways
const SCROLL_EDGE_PX = 96;

/** The highlight rules for a document with no access to the app's stylesheet (the app's own are in file-viewer.css) */
export const FRAME_FIND_CSS = `
    ::highlight(${FIND_HIGHLIGHT}) { background-color: #fff1a8; }
    ::highlight(${FIND_HIGHLIGHT_ACTIVE}) { background-color: #ff9632; color: #ffffff; }
`;

export interface MatchSpan {
    startNode: number;
    startOffset: number;
    endNode: number;
    endOffset: number;
}

// Case-insensitive, and any whitespace matches any other, so a query typed on one line finds
// text a source file wrapped onto two. Both folds keep the length, so offsets stay true.
function fold(text: string): string {
    const lower = text.toLowerCase();
    return (lower.length === text.length ? lower : text).replace(/\s/g, ' ');
}

/**
 * Matches of `query` in `texts` read end to end, as positions within the individual texts.
 * A match may start in one text and end in a later one, which is what a phrase crossing a
 * syntax-highlight span or an inline tag looks like.
 */
export function findMatchSpans(texts: string[], query: string, limit = MAX_MATCHES): MatchSpan[] {
    const needle = fold(query);
    if (!needle) return [];

    const starts: number[] = [];
    let haystack = '';
    for (const text of texts) {
        starts.push(haystack.length);
        haystack += fold(text);
    }

    // The last text starting at or before `position`; texts are non-empty, so starts ascend strictly
    const textAt = (position: number) => {
        let low = 0;
        let high = starts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (starts[mid]! <= position) low = mid; else high = mid - 1;
        }
        return low;
    };

    const spans: MatchSpan[] = [];
    for (let at = haystack.indexOf(needle); at !== -1 && spans.length < limit; at = haystack.indexOf(needle, at + needle.length)) {
        const startNode = textAt(at);
        const endNode = textAt(at + needle.length - 1);
        spans.push({
            startNode,
            startOffset: at - starts[startNode]!,
            endNode,
            endOffset: at + needle.length - starts[endNode]!,
        });
    }
    return spans;
}

/** The text a reader sees under `root`; script, style and aria-hidden subtrees (a line-number gutter) are not text to find */
function visibleTextNodes(root: Node): Text[] {
    const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
            const element = node as Element;
            return element.tagName === 'SCRIPT' || element.tagName === 'STYLE' || element.getAttribute('aria-hidden') === 'true'
                ? NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_SKIP;
        },
    });
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    return nodes;
}

/**
 * Lines `start` to `end` (1-based, inclusive) of `texts` read end to end, without the
 * newline closing the last. Null when the text has fewer than `start` lines.
 */
export function lineSpan(texts: string[], start: number, end: number): MatchSpan | null {
    let line = 1;
    let from: { node: number; offset: number } | null = start === 1 ? { node: 0, offset: 0 } : null;
    for (let node = 0; node < texts.length; node++) {
        const text = texts[node]!;
        for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
            if (line === end) return from && { startNode: from.node, startOffset: from.offset, endNode: node, endOffset: at };
            if (++line === start) from = { node, offset: at + 1 };
        }
    }
    const last = texts.length - 1;
    return from && last >= 0 ? { startNode: from.node, startOffset: from.offset, endNode: last, endOffset: texts[last]!.length } : null;
}

function spanToRange(nodes: Text[], span: MatchSpan): Range {
    const range = nodes[span.startNode]!.ownerDocument.createRange();
    range.setStart(nodes[span.startNode]!, span.startOffset);
    range.setEnd(nodes[span.endNode]!, span.endOffset);
    return range;
}

export function findRanges(root: Node, query: string): Range[] {
    const nodes = visibleTextNodes(root);
    return findMatchSpans(nodes.map(node => node.nodeValue!), query).map(span => spanToRange(nodes, span));
}

/** The text of lines `start` to `end` under `root`, as a Range */
export function lineRange(root: Node, start: number, end: number): Range | null {
    const nodes = visibleTextNodes(root);
    const span = lineSpan(nodes.map(node => node.nodeValue!), start, end);
    return span && spanToRange(nodes, span);
}

/** Paint `ranges`, with `active` standing out; an engine without the Highlight API shows none */
export function paintMatches(root: Node, ranges: Range[], active?: Range) {
    const win = root.ownerDocument!.defaultView!;
    const registry = win.CSS?.highlights;
    if (!registry) return;
    registry.set(FIND_HIGHLIGHT, new win.Highlight(...ranges));
    registry.set(FIND_HIGHLIGHT_ACTIVE, new win.Highlight(...(active ? [active] : [])));
}

export function clearMatches(root: Node) {
    const registry = root.ownerDocument?.defaultView?.CSS?.highlights;
    registry?.delete(FIND_HIGHLIGHT);
    registry?.delete(FIND_HIGHLIGHT_ACTIVE);
}

/** Scroll `scroller` so `range` sits mid-view; a match already clear of the sides is not moved sideways */
export function scrollToRange(range: Range, scroller: Element) {
    const doc = range.startContainer.ownerDocument!;
    // A document's scrolling element reports its rect scrolled away; its viewport starts at 0
    const box = scroller === doc.scrollingElement ? { top: 0, left: 0 } : scroller.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    const left = rect.left - box.left;
    const offscreen = left < SCROLL_EDGE_PX || rect.right - box.left > scroller.clientWidth - SCROLL_EDGE_PX;
    scroller.scrollBy({
        top: rect.top - box.top - scroller.clientHeight / 2,
        left: offscreen ? left - scroller.clientWidth / 2 : 0,
    });
}
