/**
 * Custom link component that opens external URLs in the system's default browser
 * and file:// URLs in the viewer panel, or with the system's default application
 * when the viewer cannot show them.
 * Used with ReactMarkdown to ensure links don't navigate within the WebView.
 */

import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { openInBrowser, openFile, isTauri } from '../utils/tauri';
import { useFileViewer } from '../hooks/useFileViewer';
import { fileViewKind } from '../utils/file-viewer';
import { parseFileLink } from '../utils/formatting';
import { isDeepLink, dispatchInAppDeepLink } from '../utils/deep-link';

type ExternalLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
    node?: unknown;
};

/**
 * Link component that opens URLs externally (in system browser) when in desktop mode,
 * and opens file:// URLs in the viewer panel or with the system's default application.
 * For use as a custom component in ReactMarkdown.
 */
export function ExternalLink({ href, children, node: _node, ...props }: ExternalLinkProps) {
    const { t } = useTranslation();
    const openInViewer = useFileViewer();
    const isFileHref = href?.startsWith('file://');
    const isHttpHref = href?.startsWith('http://') || href?.startsWith('https://');
    const inTauri = isTauri();
    const link = isFileHref && href ? parseFileLink(href) : null;
    const viewable = !!link && !!openInViewer && fileViewKind(link.path) !== null;

    const handleMouseDown = (e: MouseEvent<HTMLAnchorElement>) => {
        if (!isFileHref) return;
        if (!inTauri && !viewable) return;
        e.preventDefault();
        e.stopPropagation();
    };

    const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
        // Handle file:// URLs - show in the viewer, else open with system default app
        if (isFileHref && href && (viewable || inTauri)) {
            e.preventDefault();
            e.stopPropagation();
            // Ensure nothing else in the page reacts to this click.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (e.nativeEvent as any)?.stopImmediatePropagation?.();

            if (viewable) openInViewer!(link!.path, link!.target);
            else void openFile(href);
            return;
        }

        // Handle Pipali deep links (pipali://) - route within the app. Letting
        // the webview navigate to our own scheme leaves the page blank.
        if (isDeepLink(href)) {
            e.preventDefault();
            e.stopPropagation();
            dispatchInAppDeepLink(href);
            return;
        }

        // Handle external links (http/https) - open in browser
        if (isHttpHref && href) {
            e.preventDefault();
            e.stopPropagation();
            void openInBrowser(href);
            return;
        }
        // Let other links (like anchors) work normally
    };

    // For file:// URLs, show a visual cue that it's a file link
    const linkProps = viewable
        ? { ...props, title: props.title || t('fileViewer.openInViewer') }
        : isFileHref && inTauri
            ? { ...props, title: props.title || 'Open with default application' }
            : props;

    return (
        <a {...linkProps} href={href} onMouseDown={handleMouseDown} onClick={handleClick}>
            {children}
        </a>
    );
}
