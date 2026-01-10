// Scrollable content preview for write operations in thoughts section

import { FilePlus } from 'lucide-react';

interface ThoughtWriteViewProps {
    content: string;
    filePath?: string;
}

export function ThoughtWriteView({ content, filePath }: ThoughtWriteViewProps) {
    const lines = content.split('\n');

    // Get display filename from path
    const filename = filePath?.split('/').pop() || 'new file';

    return (
        <div className="thought-write">
            <div className="write-file-header"><FilePlus size={12} /> {filename}</div>
            <div className="write-file-content">
                {lines.map((line, idx) => (
                    <div key={idx} className="write-file-line">
                        <span className="write-line-num">{idx + 1}</span>
                        <span className="write-line-text">{line || ' '}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
