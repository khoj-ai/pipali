// A generated HTML document rendered inertly. The sandbox runs no scripts, submits no forms
// and opens no popups; allow-same-origin only lets this parent reach into the frame.

import { useCallback, useRef } from 'react';

interface HtmlFileViewProps {
    html: string;
    title: string;
    onOpenLink: (href: string) => void;
}

export function HtmlFileView({ html, title, onOpenLink }: HtmlFileViewProps) {
    const frameRef = useRef<HTMLIFrameElement>(null);
    const onOpenLinkRef = useRef(onOpenLink);
    onOpenLinkRef.current = onOpenLink;

    // Every srcdoc change loads a fresh document, so the listener is attached on each load
    const handleLoad = useCallback(() => {
        const doc = frameRef.current?.contentDocument;
        if (!doc) return;
        doc.addEventListener('click', (event) => {
            const anchor = (event.target as Element | null)?.closest?.('a[href]');
            const href = anchor?.getAttribute('href');
            // In-document anchors keep working natively
            if (!href || href.startsWith('#')) return;
            event.preventDefault();
            onOpenLinkRef.current(href);
        });
    }, []);

    return (
        <iframe
            ref={frameRef}
            className="file-viewer-frame"
            title={title}
            sandbox="allow-same-origin"
            srcDoc={html}
            onLoad={handleLoad}
        />
    );
}
