// Source text with a line-number gutter. The gutter is one text node of numbers aligned to
// the source by a shared line-height, so a long file costs two nodes rather than one per line.

import { useMemo } from 'react';
import { highlightLanguage, highlightSource } from '../../utils/file-viewer';

interface TextFileViewProps {
    text: string;
    path: string;
}

export function TextFileView({ text, path }: TextFileViewProps) {
    const language = highlightLanguage(path);
    const highlighted = useMemo(() => highlightSource(text, language), [text, language]);
    const lineNumbers = useMemo(() => {
        const count = text.replace(/\n$/, '').split('\n').length;
        return Array.from({ length: count }, (_, i) => i + 1).join('\n');
    }, [text]);

    return (
        <div className="file-viewer-code">
            <pre className="file-viewer-gutter" aria-hidden="true">{lineNumbers}</pre>
            <pre className="file-viewer-source">
                {highlighted !== null
                    // Highlight.js escapes the source; the only markup here is its own spans
                    ? <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
                    : <code>{text}</code>}
            </pre>
        </div>
    );
}
