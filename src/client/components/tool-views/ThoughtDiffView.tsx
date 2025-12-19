// Compact diff view for edit operations in thoughts section

import React from 'react';
import { computeUnifiedDiff } from '../../utils/diff';

interface ThoughtDiffViewProps {
    oldText: string;
    newText: string;
}

export function ThoughtDiffView({ oldText, newText }: ThoughtDiffViewProps) {
    const diffLines = computeUnifiedDiff(oldText, newText);
    const maxLines = 10;
    const truncated = diffLines.length > maxLines;
    const displayLines = truncated ? diffLines.slice(0, maxLines) : diffLines;

    return (
        <div className="thought-diff">
            {displayLines.map((line, idx) => (
                <div key={idx} className={`thought-diff-line ${line.type}`}>
                    <span className="thought-diff-indicator">
                        {line.type === 'removed' ? '−' : line.type === 'added' ? '+' : ' '}
                    </span>
                    <span className="thought-diff-content">{line.content || ' '}</span>
                </div>
            ))}
            {truncated && (
                <div className="thought-diff-truncated">
                    ... {diffLines.length - maxLines} more lines
                </div>
            )}
        </div>
    );
}
