// Shared markdown renderer for chat content: final messages and trajectory
// intermediate messages. Owns the plugin config (GFM, math) so rendering
// behavior stays consistent across both surfaces.

import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { ExternalLink } from './ExternalLink';
import { safeMarkdownUrlTransform, localImageSrc, normalizeLatexDelimiters } from '../utils/markdown';
import { getApiBaseUrl } from '../utils/api';

const baseComponents: Components = {
    a: ExternalLink,
    img: ({ src, alt }) => {
        const resolvedSrc = localImageSrc(src, getApiBaseUrl());
        return resolvedSrc
            ? <img src={resolvedSrc} alt={alt || ''} className="message-inline-image" />
            : null;
    },
};

// Headings are the only markdown elements with intrinsic font scaling, so
// downgrading them to bold text keeps compact content at container scale.
function CompactHeading({ children }: { children?: ReactNode }) {
    return <p className="compact-heading"><strong>{children}</strong></p>;
}

const compactComponents: Components = {
    ...baseComponents,
    h1: CompactHeading,
    h2: CompactHeading,
    h3: CompactHeading,
    h4: CompactHeading,
    h5: CompactHeading,
    h6: CompactHeading,
};

interface ChatMarkdownProps {
    children: string;
    /** Render at container scale for trajectory items: headings as bold text, tighter spacing. */
    compact?: boolean;
}

// Parsing runs synchronously in render and dwarfs everything else a message does, so it
// happens only when the text changes.
export const ChatMarkdown = memo(function ChatMarkdown({ children, compact = false }: ChatMarkdownProps) {
    const markdown = (
        <ReactMarkdown
            remarkPlugins={[[remarkGfm, { singleTilde: false }], [remarkMath, { singleDollarTextMath: false }]]}
            rehypePlugins={[[rehypeKatex, { output: 'mathml' }]]}
            urlTransform={safeMarkdownUrlTransform}
            components={compact ? compactComponents : baseComponents}
        >
            {normalizeLatexDelimiters(children)}
        </ReactMarkdown>
    );
    return compact ? <div className="chat-markdown-compact">{markdown}</div> : markdown;
});
