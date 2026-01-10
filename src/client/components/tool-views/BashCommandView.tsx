// Bash command view for the thoughts section
// Shows command, justification, working directory, and output

import React, { useState } from 'react';

interface BashCommandViewProps {
    command: string;
    justification?: string;
    cwd?: string;
    result?: string;
}

export function BashCommandView({ command, cwd, result }: BashCommandViewProps) {
    const hasOutput = result && result.length > 0;
    const isError = result?.toLowerCase().includes('error') ||
                    result?.toLowerCase().includes('cancelled') ||
                    result?.includes('[Exit code:');

    // Shorten home directory path for display
    const displayCwd = cwd?.replace(/^\/Users\/[^/]+/, '~') || '~';

    return (
        <div className="thought-bash">
            <div className="bash-command-block">
                <div className="bash-command-header">
                    <code className="bash-cwd">{displayCwd}</code>
                    <span className="bash-prompt">$</span>
                </div>
                <pre className="bash-command-text"><code>{command}</code></pre>
            </div>
            {hasOutput && (
                <div className={`bash-output ${isError ? 'error' : 'success'}`}>
                    <div
                        className="bash-output-header"
                        style={{ cursor: 'default' }}
                    >
                        <span className="bash-label">Output</span>
                    </div>
                    <pre className="bash-output-text">
                        {result}
                    </pre>
                </div>
            )}
        </div>
    );
}
