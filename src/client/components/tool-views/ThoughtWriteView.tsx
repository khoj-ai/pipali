// Compact content preview for write operations in thoughts section

import React from 'react';

interface ThoughtWriteViewProps {
    content: string;
}

export function ThoughtWriteView({ content }: ThoughtWriteViewProps) {
    const lines = content.split('\n');
    const maxLines = 8;
    const truncated = lines.length > maxLines;
    const displayLines = truncated ? lines.slice(0, maxLines) : lines;

    return (
        <div className="thought-diff">
            {displayLines.map((line, idx) => (
                <div key={idx} className="thought-diff-line added">
                    <span className="thought-diff-indicator">+</span>
                    <span className="thought-diff-content">{line || ' '}</span>
                </div>
            ))}
            {truncated && (
                <div className="thought-diff-truncated">
                    ... {lines.length - maxLines} more lines
                </div>
            )}
        </div>
    );
}
