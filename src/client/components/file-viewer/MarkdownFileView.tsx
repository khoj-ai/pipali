// Markdown with any leading frontmatter shown as the YAML it is. Left in the body, the
// fences and keys would render as a rule and a setext heading.

import { parseFrontmatter } from '../../../shared/frontmatter';
import { ChatMarkdown } from '../ChatMarkdown';
import { highlightSource } from '../../utils/file-viewer';

export function MarkdownFileView({ text }: { text: string }) {
    const parsed = parseFrontmatter(text);
    const yaml = parsed?.yaml.trim();
    const highlighted = yaml ? highlightSource(yaml, 'yaml') : null;

    return (
        <div className="file-viewer-markdown message-content">
            {yaml && (
                <pre className="file-viewer-frontmatter">
                    {highlighted !== null
                        ? <code dangerouslySetInnerHTML={{ __html: highlighted }} />
                        : <code>{yaml}</code>}
                </pre>
            )}
            <ChatMarkdown>{parsed ? parsed.body : text}</ChatMarkdown>
        </div>
    );
}
