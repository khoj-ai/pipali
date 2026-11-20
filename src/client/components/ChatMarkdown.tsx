// Shared markdown renderer for chat content: final messages and trajectory
// intermediate messages. Owns the plugin config (GFM, math) so rendering
// behavior stays consistent across both surfaces.

import { memo, useMemo, type ElementType, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
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

const LINE_STAMPED_BLOCKS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'pre', 'blockquote', 'table'] as const;

// Each block carries the source line it starts on, for a link into a rendered file to find
function lineComponents(lineOffset: number): Components {
    const components: Record<string, unknown> = { ...baseComponents };
    for (const Block of LINE_STAMPED_BLOCKS) {
        const Stamped = ({ node, ...props }: Record<string, unknown> & ExtraProps) => {
            const Tag: ElementType = Block;
            return <Tag {...props} data-line={node?.position ? node.position.start.line + lineOffset : undefined} />;
        };
        components[Block] = Stamped;
    }
    return components as Components;
}

interface ChatMarkdownProps {
    children: string;
    /** Render at container scale for trajectory items: headings as bold text, tighter spacing. */
    compact?: boolean;
    /** Stamp blocks with their source line, counted from this many lines into the file the text was cut from */
    lineOffset?: number;
}

// Parsing runs synchronously in render and dwarfs everything else a message does, so it
// happens only when the text changes.
export const ChatMarkdown = memo(function ChatMarkdown({ children, compact = false, lineOffset }: ChatMarkdownProps) {
    const stamped = useMemo(() => lineOffset === undefined ? null : lineComponents(lineOffset), [lineOffset]);
    const markdown = (
        <ReactMarkdown
            remarkPlugins={[[remarkGfm, { singleTilde: false }], [remarkMath, { singleDollarTextMath: false }]]}
            rehypePlugins={[[rehypeKatex, { output: 'mathml' }]]}
            urlTransform={safeMarkdownUrlTransform}
            components={compact ? compactComponents : stamped ?? baseComponents}
        >
            {normalizeLatexDelimiters(children)}
        </ReactMarkdown>
    );
    return compact ? <div className="chat-markdown-compact">{markdown}</div> : markdown;
});
