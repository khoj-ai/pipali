// A Word document as the HTML the server made of it, on a white page like the one it came
// from. Mammoth emits bare markup, so the sheet here supplies the typography.

import { HtmlFileView } from './HtmlFileView';

const PAGE_STYLE = `
    body { max-width: 720px; margin: 0 auto; padding: 32px 40px 48px; color: #1f2328;
           font: 15px/1.6 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; margin: 12px 0; }
    td, th { padding: 4px 10px; border: 1px solid #d0d7de; vertical-align: top; }
    td > p, th > p { margin: 0; }
    a { color: #0969da; }
`;

interface DocxFileViewProps {
    html: string;
    title: string;
    onOpenLink: (href: string) => void;
    onDocumentLoad?: (doc: Document) => void;
}

export function DocxFileView({ html, title, onOpenLink, onDocumentLoad }: DocxFileViewProps) {
    const page = `<!doctype html><html><head><style>${PAGE_STYLE}</style></head><body>${html}</body></html>`;
    return <HtmlFileView html={page} title={title} onOpenLink={onOpenLink} onDocumentLoad={onDocumentLoad} />;
}
