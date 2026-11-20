/**
 * Landing on the place a file link names. Like find, the target is a Range painted through
 * the CSS Custom Highlight API, so the rendered document is read and never rewritten.
 */

import type { FileLinkTarget } from './formatting';
import { lineRange, passageRange } from './find-matches';

const TARGET_HIGHLIGHT = 'file-target';

/** The highlight rule for a document with no access to the app's stylesheet (the app's own is in file-viewer.css) */
export const FRAME_TARGET_CSS = `::highlight(${TARGET_HIGHLIGHT}) { background-color: #cfe3ff; }`;

/**
 * Rendered Markdown stamps each block with the source line it starts on, so lines are looked
 * up there; source and plain text are read line by line.
 */
function blockRange(root: Element, start: number, end: number): Range | null {
    const blocks = [...root.querySelectorAll<HTMLElement>('[data-line]')];
    const line = (block: HTMLElement) => Number(block.dataset.line);
    // A block spanning the lines starts above them, so with none inside them the last one above is it
    const inside = blocks.filter(block => line(block) >= start && line(block) <= end);
    const picked = inside.length ? inside : blocks.filter(block => line(block) <= start).slice(-1);
    if (!picked.length) return null;
    const range = root.ownerDocument.createRange();
    range.setStartBefore(picked[0]!);
    range.setEndAfter(picked[picked.length - 1]!);
    return range;
}

export function targetRange(root: Element, target: FileLinkTarget): Range | null {
    if (target.kind === 'text') return passageRange(root, target.start, target.end);
    return root.querySelector('[data-line]')
        ? blockRange(root, target.start, target.end)
        : lineRange(root, target.start, target.end);
}

export function paintTarget(range: Range) {
    const win = range.startContainer.ownerDocument!.defaultView!;
    win.CSS?.highlights?.set(TARGET_HIGHLIGHT, new win.Highlight(range));
}

export function clearTarget(doc: Document) {
    doc.defaultView?.CSS?.highlights?.delete(TARGET_HIGHLIGHT);
}
