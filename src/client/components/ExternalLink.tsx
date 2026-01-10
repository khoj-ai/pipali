/**
 * Custom link component that opens external URLs in the system's default browser.
 * Used with ReactMarkdown to ensure links don't navigate within the WebView.
 */

import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { openInBrowser } from '../utils/tauri';

type ExternalLinkProps = AnchorHTMLAttributes<HTMLAnchorElement>;

/**
 * Link component that opens URLs externally (in system browser) when in desktop mode.
 * For use as a custom component in ReactMarkdown.
 */
export function ExternalLink({ href, children, ...props }: ExternalLinkProps) {
    const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
        // Only intercept external links (http/https)
        if (href?.startsWith('http://') || href?.startsWith('https://')) {
            e.preventDefault();
            openInBrowser(href);
        }
        // Let other links (like anchors) work normally
    };

    return (
        <a href={href} onClick={handleClick} {...props}>
            {children}
        </a>
    );
}
