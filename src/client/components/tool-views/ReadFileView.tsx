// Formatted read file view for the thoughts section
// Shows file content with line numbers in a scrollable box

import { FileText, Image } from 'lucide-react';

interface ReadFileViewProps {
    result: string;
    filePath?: string;
}

interface MultimodalContent {
    type: 'text' | 'image';
    text?: string;
    data?: string;
    mime_type?: string;
    source_type?: string;
}

function parseMultimodalContent(result: string): MultimodalContent[] | null {
    // Check if this is JSON array (multimodal content)
    if (!result.startsWith('[')) return null;
    try {
        const parsed = JSON.parse(result);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type) {
            return parsed as MultimodalContent[];
        }
    } catch {
        // Not valid JSON, treat as plain text
    }
    return null;
}

export function ReadFileView({ result, filePath }: ReadFileViewProps) {
    // Get display filename from path
    const filename = filePath?.split('/').pop() || 'file';

    // Check for multimodal content (images)
    const multimodal = parseMultimodalContent(result);

    if (multimodal) {
        const textContent = multimodal.find(c => c.type === 'text');
        const imageContent = multimodal.find(c => c.type === 'image');

        return (
            <div className="thought-read">
                <div className="read-file-header"><Image size={12} /> {filename}</div>
                {textContent?.text && (
                    <div className="read-file-meta">
                        {textContent.text.split('\n').map((line, idx) => (
                            <div key={idx}>{line}</div>
                        ))}
                    </div>
                )}
                {imageContent?.data && imageContent.mime_type && (
                    <div className="read-file-image">
                        <img
                            src={`data:${imageContent.mime_type};base64,${imageContent.data}`}
                            alt={filename}
                        />
                    </div>
                )}
            </div>
        );
    }

    // Standard text file content
    const lines = result.split('\n');

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
