// Compact rendering for Chrome MCP page-related tool results
// Handles list_pages, navigate_page, select_page, new_page, close_page

import { Globe } from 'lucide-react';

interface ChromePageViewProps {
    result: string;
}

interface PageEntry {
    id: number;
    url: string;
    selected: boolean;
}

/** Parse the markdown page list from Chrome MCP results */
export function parsePages(result: string): { message?: string; pages: PageEntry[] } {
    const pages: PageEntry[] = [];
    let message: string | undefined;

    for (const line of result.split('\n')) {
        const trimmed = line.trim();

        // Capture status messages like "Successfully navigated to ..."
        if (trimmed.startsWith('Successfully')) {
            message = trimmed;
            continue;
        }

        // Parse page entries like "1: https://example.com [selected]",
        // or "1: Example (https://example.com) [selected]" for a page with a title
        const match = trimmed.match(/^(\d+):\s+(.+?)(\s+\[selected\])?\s*$/);
        if (match?.[1] && match[2]) {
            pages.push({
                id: parseInt(match[1]),
                url: match[2].match(/\s\((\S+)\)$/)?.[1] ?? match[2],
                selected: !!match[3],
            });
        }
    }

    return { message, pages };
}

function formatPageUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname !== '/' ? parsed.pathname : '';
        const query = parsed.search || '';
        return parsed.hostname + path + query;
    } catch {
        return url;
    }
}

export function ChromePageView({ result }: ChromePageViewProps) {
    const { pages } = parsePages(result);

    if (pages.length === 0) return null;

    return (
        <div className="thought-snapshot">
            <div className="snapshot-header">
                <Globe size={12} />
                <span className="snapshot-title">{pages.length} page{pages.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="chrome-page-list">
                {pages.map(page => (
                    <div key={page.id} className={`chrome-page-entry${page.selected ? ' selected' : ''}`}>
                        <span className="chrome-page-id">{page.id}</span>
                        <span className="chrome-page-url" title={page.url}>
                            {formatPageUrl(page.url)}
                        </span>
                        {page.selected && <span className="chrome-page-badge">active</span>}
                    </div>
                ))}
            </div>
        </div>
    );
}
