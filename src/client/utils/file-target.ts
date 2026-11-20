/**
 * Landing on the place a file link names. Like find, the target is a Range painted through
 * the CSS Custom Highlight API, so the rendered document is read and never rewritten.
 */

import type { FileLinkTarget } from './formatting';
import { lineRange } from './find-matches';

const TARGET_HIGHLIGHT = 'file-target';

export function targetRange(root: Element, target: FileLinkTarget): Range | null {
    return lineRange(root, target.start, target.end);
}

export function paintTarget(range: Range) {
    const win = range.startContainer.ownerDocument!.defaultView!;
    win.CSS?.highlights?.set(TARGET_HIGHLIGHT, new win.Highlight(range));
}

export function clearTarget(doc: Document) {
    doc.defaultView?.CSS?.highlights?.delete(TARGET_HIGHLIGHT);
}
