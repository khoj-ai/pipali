// Formatted webpage content view for the thoughts section
// Shows extracted webpage content in a scrollable box with markdown rendering

import { Globe } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface WebpageViewProps {
    result: string;
    url?: string;
}

export function WebpageView({ result, url }: WebpageViewProps) {
    // Extract domain from URL for display
    const getDomain = (urlString?: string): string => {
        if (!urlString) return 'Webpage';
        try {
            const parsed = new URL(urlString);
            return parsed.hostname;
        } catch {
            return urlString.slice(0, 30);
        }
    };

    const domain = getDomain(url);

    // Check for errors. Mark as false until we have better error detection.
    const isError = false;

    return (
        <div className={`thought-webpage ${isError ? 'error' : ''}`}>
            <div className="webpage-header">
                <Globe size={12} />
                <span className="webpage-domain">{domain}</span>
            </div>
            <div className="webpage-content webpage-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {result}
                </ReactMarkdown>
            </div>
        </div>
    );
}
