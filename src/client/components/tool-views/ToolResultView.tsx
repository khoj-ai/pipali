// Generic tool result view for the thoughts section
// Shows tool output in a scrollable box for tools without specialized views

interface ToolResultViewProps {
    result: string;
    toolName?: string;
}

export function ToolResultView({ result, toolName }: ToolResultViewProps) {
    const lines = result.split('\n');

    // Get a display name for the header
    const headerText = toolName || 'Result';

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
