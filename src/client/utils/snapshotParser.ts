// Parse chrome-devtools a11y tree snapshots for uid resolution and structured rendering

export interface SnapshotNode {
    uid: string;
    role: string;
    label: string;
    indent: number;
    attrs: Record<string, string>;
}

/** Friendly role names for display */
const ROLE_DISPLAY: Record<string, string> = {
    'RootWebArea': 'page',
    'StaticText': 'text',
    'combobox': 'input',
    'textbox': 'input',
    'LineBreak': 'br',
    'contentinfo': 'footer',
};

/** Parse a single snapshot line into a structured node */
function parseLine(line: string): SnapshotNode | null {
    // Match: optional leading spaces, uid=X_Y, role, optional "label", optional key=value or key="value" attrs.
    // A text node has no role: uid=X_Y "label". Conversations stored before
    // chrome-devtools-mcp 1.11 hold snapshots that give it one, StaticText
    const match = line.match(/^(\s*)uid=(\S+)(?:\s+(\w+))?\s*(.*)/);
    if (!match) return null;

    const indent = match[1]!.length;
    const uid = match[2]!;
    const role = match[3] ?? 'StaticText';
    const rest = match[4]!;

    // Extract quoted label (first quoted string after role)
    let label = '';
    const labelMatch = rest.match(/^"([^"]*)"/);
    if (labelMatch) {
        label = labelMatch[1]!;
    }

    // Extract key="value" and key=value attributes
    const attrs: Record<string, string> = {};
    const attrPattern = /(\w+)=(?:"([^"]*)"|(\S+))/g;
    let attrMatch;
    // Skip past the label if it was the first thing
    const attrStr = labelMatch ? rest.slice(labelMatch[0].length) : rest;
    while ((attrMatch = attrPattern.exec(attrStr)) !== null) {
        attrs[attrMatch[1]!] = attrMatch[2] ?? attrMatch[3]!;
    }

    return { uid, role, label, indent, attrs };
}

/**
 * Parse a snapshot result text into a uid→{role, label} map.
 * Used to resolve opaque uids in click/hover/fill tool args.
 */
export function parseSnapshotUids(snapshotText: string): Map<string, { role: string; label: string }> {
    const map = new Map<string, { role: string; label: string }>();
    for (const line of snapshotText.split('\n')) {
        const node = parseLine(line);
        if (!node) continue;
        // Use first occurrence (snapshots don't have duplicate uids)
        if (!map.has(node.uid)) {
            map.set(node.uid, { role: node.role, label: node.label });
        }
    }
    return map;
}

/**
 * Resolve a uid to a friendly display string.
 * Returns e.g. `"Search" button` or `"bali weather" input`.
 * Falls back to the raw uid if not found.
 */
export function resolveUidLabel(
    uid: string,
    uidMap?: Map<string, { role: string; label: string }>
): string {
    if (!uidMap) return uid;
    const entry = uidMap.get(uid);
    if (!entry) return uid;

    const displayRole = ROLE_DISPLAY[entry.role] || entry.role;

    if (entry.label) {
        const truncated = entry.label.length > 40
            ? entry.label.slice(0, 37) + '\u2026'
            : entry.label;
        return `"${truncated}" ${displayRole}`;
    }

    return `${displayRole} ${uid}`;
}

/**
 * Parse a full snapshot into structured nodes for tree rendering.
 * Filters out noise (StaticText duplicating parent label, LineBreak, accessibility helpers).
 */
export function parseSnapshotTree(snapshotText: string): SnapshotNode[] {
    const allNodes: SnapshotNode[] = [];
    const lines = snapshotText.split('\n');

    for (const line of lines) {
        const node = parseLine(line);
        if (node) allNodes.push(node);
    }

    if (allNodes.length === 0) return [];

    // Filter noise
    const filtered: SnapshotNode[] = [];
    let skipUntilIndent = -1; // Skip children of accessibility helper sections

    for (let i = 0; i < allNodes.length; i++) {
        const node = allNodes[i]!;

        // Skip accessibility helper sections
        if (skipUntilIndent >= 0) {
            if (node.indent > skipUntilIndent) continue;
            skipUntilIndent = -1;
        }
        if (node.role === 'heading' && node.label === 'Accessibility Links') {
            skipUntilIndent = node.indent;
            continue;
        }
        if (node.role === 'heading' && node.label === 'Footer Links') {
            skipUntilIndent = node.indent;
            continue;
        }

        // Skip LineBreak nodes
        if (node.role === 'LineBreak') continue;

        // Skip StaticText that duplicates parent label
        if (node.role === 'StaticText' && i > 0) {
            // Find parent (first node before this with smaller indent)
            for (let j = i - 1; j >= 0; j--) {
                const parent = allNodes[j]!;
                if (parent.indent < node.indent) {
                    if (parent.label && node.label && parent.label.includes(node.label)) {
                        // Skip this duplicate
                        break;
                    }
                    // Not a duplicate, keep it
                    filtered.push(node);
                    break;
                }
            }
            continue;
        }

        // Skip generic containers with no label
        if (node.role === 'generic' && !node.label) continue;

        filtered.push(node);
    }

    return filtered;
}

/** Extract page title and URL from a snapshot's RootWebArea node */
export function getSnapshotPageInfo(snapshotText: string): { title: string; url: string } | null {
    const match = snapshotText.match(/RootWebArea\s+"([^"]*)"\s+url="([^"]*)"/);
    if (!match) return null;
    return { title: match[1]!, url: match[2]! };
}
