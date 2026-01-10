// Individual thought/tool_call rendering

import React from 'react';
import type { Thought } from '../../types';
import { formatToolArgs, getFriendlyToolName } from '../../utils/formatting';
import { getToolResultStatus } from '../../utils/toolStatus';
import { ThoughtDiffView } from '../tool-views/ThoughtDiffView';
import { ThoughtWriteView } from '../tool-views/ThoughtWriteView';
import { GrepResultView } from '../tool-views/GrepResultView';
import { ListResultView } from '../tool-views/ListResultView';
import { BashCommandView } from '../tool-views/BashCommandView';

interface ThoughtItemProps {
    thought: Thought;
    stepNumber: number; // Position among tool_call thoughts
    isPreview?: boolean;
}

export function ThoughtItem({ thought, stepNumber, isPreview = false }: ThoughtItemProps) {
    if (thought.type === 'thought' && thought.content) {
        return (
            <div className={`thought-item reasoning ${thought.isInternalThought ? 'internal' : ''} ${isPreview ? 'preview' : ''}`}>
                <div className="thought-step">💭</div>
                <div className="thought-content">
                    <div className={`thought-reasoning ${thought.isInternalThought ? 'italic' : ''}`}>
                        {thought.content.trim()}
                    </div>
                </div>
            </div>
        );
    }

    if (thought.type === 'tool_call') {
        const toolName = thought.toolName || '';
        const formattedArgs = formatToolArgs(toolName, thought.toolArgs);
        const friendlyToolName = getFriendlyToolName(toolName);

        // Check if this is a specific tool operation with special rendering
        const isEditOp = toolName === 'edit_file' && thought.toolArgs?.old_string && thought.toolArgs?.new_string;
        const isWriteOp = toolName === 'write_file' && thought.toolArgs?.content;
        const isGrepOp = toolName === 'grep_files' && thought.toolResult;
        const isListOp = toolName === 'list_files' && thought.toolResult;
        const isShellOp = toolName === 'shell_command' && thought.toolArgs?.command;

        // Determine success/error status for step indicator (pending takes precedence)
        const stepStatus = thought.isPending ? 'pending' : getToolResultStatus(thought.toolResult, toolName);

        return (
            <div className={`thought-item ${isPreview ? 'preview' : ''} ${thought.isPending ? 'pending' : ''}`}>
                <div className={`thought-step ${stepStatus}`}>
                    {stepNumber}
                </div>
                <div className="thought-content">
                    <div className="thought-tool">
                        {friendlyToolName}
                        {formattedArgs && (
                            <span className="thought-args"> {formattedArgs}</span>
                        )}
                    </div>
                    {/* Show diff view for edit operations */}
                    {isEditOp && (
                        <ThoughtDiffView
                            oldText={thought.toolArgs.old_string}
                            newText={thought.toolArgs.new_string}
                        />
                    )}
                    {/* Show content preview for write operations */}
                    {isWriteOp && (
                        <ThoughtWriteView
                            content={thought.toolArgs.content}
                        />
                    )}
                    {/* Show formatted grep results */}
                    {isGrepOp && thought.toolResult && (
                        <GrepResultView result={thought.toolResult} />
                    )}
                    {/* Show formatted list results */}
                    {isListOp && thought.toolResult && (
                        <ListResultView result={thought.toolResult} />
                    )}
                    {/* Show bash command view */}
                    {isShellOp && (
                        <BashCommandView
                            command={thought.toolArgs.command}
                            justification={thought.toolArgs.justification}
                            cwd={thought.toolArgs.cwd}
                            result={thought.toolResult}
                        />
                    )}
                    {/* Show regular result for other tools */}
                    {!isEditOp && !isWriteOp && !isGrepOp && !isListOp && !isShellOp && thought.toolResult && (
                        <pre className="thought-result">
                            {thought.toolResult.slice(0, 200)}
                            {thought.toolResult.length > 200 && '...'}
                        </pre>
                    )}
                </div>
            </div>
        );
    }

    return null;
}
