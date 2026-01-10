// Formatted read file view for the thoughts section
// Shows file content with line numbers in a scrollable box

import { FileText } from 'lucide-react';

interface ReadFileViewProps {
    result: string;
    filePath?: string;
}

export function ReadFileView({ result, filePath }: ReadFileViewProps) {
    const lines = result.split('\n');

    // Get display filename from path
    const filename = filePath?.split('/').pop() || 'file';

    return (
        <div className="thought-read">
            <div className="read-file-header"><FileText size={12} /> {filename}</div>
            <div className="read-file-content">
                {lines.map((line, idx) => (
                    <div key={idx} className="read-file-line">
                        <span className="read-line-num">{idx + 1}</span>
                        <span className="read-line-text">{line}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
