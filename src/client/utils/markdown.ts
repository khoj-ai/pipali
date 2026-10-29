import { isDeepLink } from './deep-link';

type MarkdownUrlTransformOptions = {
    baseUrl?: string;
    allowRelative?: boolean;
};

function isRelativeUrl(url: string): boolean {
    return url.startsWith('/') || url.startsWith('./') || url.startsWith('../');
}

function isWindowsDrivePath(url: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(url);
}

function windowsPathToFileUrl(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    return `file:///${normalized}`;
}

export function makeMarkdownUrlTransform(options: MarkdownUrlTransformOptions = {}): (url: string) => string {
    const allowRelative = options.allowRelative ?? true;
    const baseUrl = options.baseUrl;

    return (inputUrl: string): string => {
        // Allow in-page anchors
        if (inputUrl.startsWith('#')) return inputUrl;

        // Allow Windows file paths (desktop app can handle via ExternalLink + openFile)
        if (isWindowsDrivePath(inputUrl)) return windowsPathToFileUrl(inputUrl);

        // Allow file links for the desktop app (and fail open if unencoded).
        if (inputUrl.startsWith('file://')) return inputUrl;

        // Allow relative links (optionally resolving against a base URL)
        if (isRelativeUrl(inputUrl)) {
            if (!allowRelative) return '';
            if (!baseUrl) return inputUrl;
            try {
                return new URL(inputUrl, baseUrl).toString();
            } catch {
                return inputUrl;
            }
        }

        // Allow a small set of safe protocols.
        // Block javascript:, data:, vbscript:, etc.
        try {
            const parsed = new URL(inputUrl);
            switch (parsed.protocol) {
                case 'http:':
                case 'https:':
                case 'mailto:':
                case 'tel:':
                case 'file:':
                    return inputUrl;
                // Our own scheme, for links between conversations. ExternalLink routes the
                // ones it recognizes in the app; any other would navigate the webview away.
                case 'pipali:':
                    return isDeepLink(inputUrl) ? inputUrl : '';
                default:
                    return '';
            }
        } catch {
            return '';
        }
    };
}

export const safeMarkdownUrlTransform = makeMarkdownUrlTransform();

// Matches fenced code blocks (tolerating an unclosed fence while streaming) and inline code spans.
const CODE_SEGMENT = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/g;

// Pandoc's single-dollar rules: the opening $ must be followed by a non-space
// (and not another $), the closing $ preceded by a non-space (and not a \) and
// not followed by a digit. Currency survives: in "$5-$10" the closing $ is
// followed by a digit, and in "$5 and $10" it is preceded by a space.
const INLINE_DOLLAR_MATH = /(?<![$\\])\$(?=[^\s$])([^$\n]+?)(?<=[^\s\\])\$(?![\d$])/g;

/**
 * Convert LaTeX \( \) and \[ \] delimiters, plus Pandoc-style single-dollar
 * inline math, to the $$ delimiters remark-math parses. The prompt asks models
 * for the backslash delimiters, but some (e.g. GLM) ignore it and emit their
 * training prior of $ inline math, so both dialects normalize here while the
 * renderer keeps singleDollarTextMath off and $ stays plain text otherwise.
 * Code blocks and inline code are left untouched.
 */
export function normalizeLatexDelimiters(content: string): string {
    return content
        .split(CODE_SEGMENT)
        .map((segment, i) => {
            // CODE_SEGMENT's single capture group makes split() keep the code
            // segments, interleaved: even indices are prose, odd are code.
            if (i % 2 === 1) return segment;
            return segment
                // Convert display \[ \] to block $$ delimiters.
                .replace(/\\\[([\s\S]+?)\\\]/g, (match, math: string) =>
                    math.trim() ? `\n$$\n${math.trim()}\n$$\n` : match)
                // Convert inline \( \) to inline $$ delimiters.
                .replace(/\\\(([\s\S]+?)\\\)/g, (match, math: string) =>
                    math.trim() ? `$$${math.trim()}$$` : match)
                // Convert single-dollar inline math to inline $$ delimiters.
                // Runs last so the $$ spans the passes above emit (guarded by
                // the $ lookarounds) pass through untouched.
                .replace(INLINE_DOLLAR_MATH, (_match, math: string) => `$$${math}$$`);
        })
        .join('');
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;

/** Convert a local file path or file:// URL to an API-served image src. Passes through http(s) and data URIs. */
export function localImageSrc(src: string | undefined, apiBaseUrl = ''): string | undefined {
    if (!src) return undefined;
    if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src;

    const filePath = src.startsWith('file://')
        ? decodeURIComponent(src.slice('file://'.length))
        : src;

    if (!IMAGE_EXTENSIONS.test(filePath)) return undefined;
    return `${apiBaseUrl}/api/files?path=${encodeURIComponent(filePath)}`;
}
