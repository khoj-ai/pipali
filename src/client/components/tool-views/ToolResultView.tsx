// Generic tool result view for the thoughts section
// Shows tool output in a scrollable box for tools without specialized views

interface ToolResultViewProps {
    result: string;
    toolName?: string;
}

interface MultimodalItem {
    type: string;
    text?: string;
    data?: string;
    mime_type?: string;
    source_type?: string;
}

function parseMultimodalContent(result: string): MultimodalItem[] | null {
    if (!result.startsWith('[')) return null;
    try {
        const parsed = JSON.parse(result);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type) {
            return parsed as MultimodalItem[];
        }
    } catch {
        // Not valid JSON, treat as plain text
    }
    return null;
}

export function ToolResultView({ result, toolName }: ToolResultViewProps) {
    // Get a display name for the header
    const headerText = toolName || 'Result';

    // Check for multimodal content (e.g. screenshots from browser tools)
    const multimodal = parseMultimodalContent(result);
    if (multimodal) {
        const textItems = multimodal.filter(c => c.type === 'text');
        const imageItems = multimodal.filter(c => c.type === 'image' && c.data && c.mime_type);
        const textContent = textItems.map(c => c.text).filter(Boolean).join('\n');

        return (
            <div className="thought-tool-result">
                <div className="tool-result-header">{headerText}</div>
                {textContent && (
                    <div className="tool-result-content">
                        {textContent.split('\n').map((line, idx) => (
                            <div key={idx} className="tool-result-line">
                                {line || '\u00A0'}
                            </div>
                        ))}
                    </div>
                )}
                {imageItems.map((img, idx) => (
                    <div key={idx} className="read-file-image">
                        <img
                            src={`data:${img.mime_type};base64,${img.data}`}
                            alt={`${headerText} image`}
                        />
                    </div>
                ))}
            </div>
        );
    }

    const lines = result.split('\n');

    return (
        <div className="thought-tool-result">
            <div className="tool-result-header">{headerText}</div>
            <div className="tool-result-content">
                {lines.map((line, idx) => (
                    <div key={idx} className="tool-result-line">
                        {line || '\u00A0'}
                    </div>
                ))}
            </div>
        </div>
    );
}
