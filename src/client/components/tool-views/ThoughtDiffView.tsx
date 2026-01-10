// Compact diff view for edit operations in thoughts section

import { Pencil } from 'lucide-react';
import { computeUnifiedDiff } from '../../utils/diff';

interface ThoughtDiffViewProps {
    oldText: string;
    newText: string;
    filePath?: string;
}

export function ThoughtDiffView({ oldText, newText, filePath }: ThoughtDiffViewProps) {
    const diffLines = computeUnifiedDiff(oldText, newText);

    // Get display filename from path
    const filename = filePath?.split('/').pop() || 'file';

    return (
        <div className="thought-diff">
            <div className="thought-diff-file-header"><Pencil size={12} /> {filename}</div>
            <div className="diff-file-content">
                {diffLines.map((line, idx) => (
                    <div key={idx} className={`thought-diff-line ${line.type}`}>
                        <span className="thought-diff-indicator">
                            {line.type === 'removed' ? '−' : line.type === 'added' ? '+' : ' '}
                        </span>
                        <span className="thought-diff-content">{line.content || ' '}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
