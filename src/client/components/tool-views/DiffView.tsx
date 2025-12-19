// Diff View Component
// Shows unified inline diff of changes that will be made to a file

import React from 'react';
import type { DiffInfo } from '../../types';
import { computeUnifiedDiff } from '../../utils/diff';

interface DiffViewProps {
    diff: DiffInfo;
}

export function DiffView({ diff }: DiffViewProps) {
    // For edit operations, show unified inline diff with file path
    if (diff.oldText !== undefined && diff.newText !== undefined) {
        const diffLines = computeUnifiedDiff(diff.oldText, diff.newText);

        return (
            <div className="diff-container">
                <div className="diff-file-header">
                    <span className="diff-file-path">{diff.filePath}</span>
                </div>
                <div className="diff-inline">
                    {diffLines.map((line, idx) => (
                        <div key={idx} className={`diff-line ${line.type}`}>
                            <span className="diff-line-indicator">
                                {line.type === 'removed' ? '−' : line.type === 'added' ? '+' : ' '}
                            </span>
                            <span className="diff-line-content">{line.content || ' '}</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    // For write operations, show the content (truncated if too long)
    if (diff.newText !== undefined) {
        const lines = diff.newText.split('\n');
        const maxLines = 20;
        const truncated = lines.length > maxLines;
        const displayLines = truncated ? lines.slice(0, maxLines) : lines;

        return (
            <div className="diff-container">
                <div className="diff-file-header">
                    <span className="diff-file-path">{diff.filePath}</span>
                    <span className="diff-meta">
                        {diff.isNewFile ? '(new file)' : '(overwrite)'} • {lines.length} lines
                    </span>
                </div>
                <div className="diff-inline">
                    {displayLines.map((line, idx) => (
                        <div key={idx} className="diff-line added">
                            <span className="diff-line-indicator">+</span>
                            <span className="diff-line-content">{line || ' '}</span>
                        </div>
                    ))}
                </div>
                {truncated && (
                    <div className="diff-meta">
                        ... {lines.length - maxLines} more lines
                    </div>
                )}
            </div>
        );
    }

    return null;
}
