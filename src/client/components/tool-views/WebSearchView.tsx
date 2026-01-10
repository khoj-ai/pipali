// Formatted web search results view for the thoughts section
// Shows search results with titles, links, and snippets in a scrollable box

import { Search } from 'lucide-react';

interface WebSearchViewProps {
    result: string;
    query?: string;
}

interface SearchResult {
    title: string;
    link: string;
    snippet?: string;
}

export function WebSearchView({ result, query }: WebSearchViewProps) {
    // Parse search results from the markdown-formatted output
    const parseResults = (text: string): SearchResult[] => {
        const results: SearchResult[] = [];

        // Match numbered results like "1. **Title**\n   link\n   snippet"
        const resultPattern = /^\d+\.\s+\*\*(.+?)\*\*\n\s+(\S+)(?:\n\s+(.+))?/gm;
        let match;

        while ((match = resultPattern.exec(text)) !== null) {
            results.push({
                title: match[1] || '',
                link: match[2] || '',
                snippet: match[3]?.trim(),
            });
        }

        return results;
    };

    const results = parseResults(result);

    // Check for errors or empty results
    if (result.toLowerCase().includes('error') || results.length === 0) {
        // Show as plain text if parsing failed
        return (
            <div className="thought-web-search error">
                <div className="web-search-content">{result}</div>
            </div>
        );
    }

    return (
        <div className="thought-web-search">
            <div className="web-search-header">
                <Search size={12} />
                <span className="web-search-query">{query ? `${query.slice(0, 50)}${query.length > 50 ? '...' : ''}` : 'Search Results'}</span>
            </div>
            <div className="web-search-results">
                {results.map((result, idx) => (
                    <div key={idx} className="web-search-result">
                        <div className="web-search-title">{result.title}</div>
                        <div className="web-search-link">{result.link}</div>
                        {result.snippet && (
                            <div className="web-search-snippet">{result.snippet}</div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
