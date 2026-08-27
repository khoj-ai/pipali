/**
 * YAML frontmatter parsing for the markdown files Pipali owns (SKILL.md, USER.md).
 *
 * Covers the subset those files use: top-level scalars — bare, single or double
 * quoted, or a `>`/`|` folded block — and one level of nesting under `metadata:`.
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const KEY_LINE = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/;
const NESTED_KEY_LINE = /^[ \t]+([A-Za-z_][\w-]*):[ \t]*(.*)$/;

export interface ParsedFrontmatter {
    /** Top-level scalar fields */
    fields: Record<string, string>;
    /** Scalar fields nested under `metadata:` */
    metadata: Record<string, string>;
    /** Raw YAML between the `---` fences */
    yaml: string;
    /** Markdown following the frontmatter */
    body: string;
}

/**
 * Strip surrounding quotes and unescape. Bare values are returned trimmed.
 */
function unquote(value: string): string {
    const doubleQuoted = value.match(/^"((?:[^"\\]|\\.)*)"$/);
    if (doubleQuoted) {
        return doubleQuoted[1]!.replace(/\\(.)/g, '$1').trim();
    }

    const singleQuoted = value.match(/^'((?:[^'\\]|\\.)*)'$/);
    if (singleQuoted) {
        return singleQuoted[1]!.replace(/\\(.)/g, '$1').trim();
    }

    return value.trim();
}

/**
 * Parse frontmatter from markdown content. Returns null when there is no
 * frontmatter block.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter | null {
    const match = content.match(FRONTMATTER);
    if (!match) {
        return null;
    }

    const yaml = match[1] ?? '';
    const lines = yaml.split(/\r?\n/);
    const fields: Record<string, string> = {};
    const metadata: Record<string, string> = {};

    for (let i = 0; i < lines.length; i++) {
        const keyLine = lines[i]!.match(KEY_LINE);
        if (!keyLine) {
            continue;
        }

        const key = keyLine[1]!;
        const value = keyLine[2]!.trim();

        if (value === '>' || value === '|') {
            // Fold the indented lines that follow into a single value
            const folded: string[] = [];
            while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1]!)) {
                folded.push(lines[++i]!.trim());
            }
            fields[key] = folded.filter(Boolean).join(' ');
        } else if (key === 'metadata' && value === '') {
            while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1]!)) {
                const nested = lines[++i]!.match(NESTED_KEY_LINE);
                if (nested) {
                    metadata[nested[1]!] = unquote(nested[2]!);
                }
            }
        } else {
            fields[key] = unquote(value);
        }
    }

    return {
        fields,
        metadata,
        yaml,
        body: content.slice(match[0].length).trim(),
    };
}
