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
                default:
                return '';
        }
    } catch {
            return '';
        }
    };
}

export const safeMarkdownUrlTransform = makeMarkdownUrlTransform();

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
