// Individual thought/tool_call rendering

import React from 'react';
import type { Thought } from '../../types';
import { formatToolArgs, getFriendlyToolName, formatToolArgsRich } from '../../utils/formatting';
import { getToolResultStatus } from '../../utils/toolStatus';
import { MessageCircleMoreIcon } from 'lucide-react';
import { ThoughtDiffView } from '../tool-views/ThoughtDiffView';
import { ThoughtWriteView } from '../tool-views/ThoughtWriteView';
import { GrepResultView } from '../tool-views/GrepResultView';
import { ListResultView } from '../tool-views/ListResultView';
import { BashCommandView } from '../tool-views/BashCommandView';
import { ReadFileView } from '../tool-views/ReadFileView';
import { WebSearchView } from '../tool-views/WebSearchView';
import { WebpageView } from '../tool-views/WebpageView';
import { ToolResultView } from '../tool-views/ToolResultView';

interface ThoughtItemProps {
    thought: Thought;
    stepNumber: number; // Position among tool_call thoughts
    isPreview?: boolean;
}

// Parse markdown bold (**text**) into React elements
function formatBoldText(text: string): React.ReactNode[] {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
            return <b key={i}>{part.slice(2, -2)}</b>;
        }
        return part;
    });
}

export function ThoughtItem({ thought, stepNumber, isPreview = false }: ThoughtItemProps) {
    if (thought.type === 'thought' && thought.content) {
        return (
            <div className={`thought-item reasoning ${thought.isInternalThought ? 'internal' : ''} ${isPreview ? 'preview' : ''}`}>
                <div className="thought-step"><MessageCircleMoreIcon size={12} /></div>
                <div className="thought-content">
                    <div className={`thought-reasoning ${thought.isInternalThought ? 'italic' : ''}`}>
                        {formatBoldText(thought.content.trim())}
                    </div>
                </div>
            </div>
        );
    }

    if (thought.type === 'tool_call') {
        const toolName = thought.toolName || '';
        const formattedArgs = formatToolArgs(toolName, thought.toolArgs);
        const richArgs = formatToolArgsRich(toolName, thought.toolArgs);
        const friendlyToolName = getFriendlyToolName(toolName);
        const isInterrupted = thought.toolResult?.trim() === '[interrupted]';

        // Check if this is a specific tool operation with special rendering
        const isEditOp = toolName === 'edit_file' && thought.toolArgs?.old_string && thought.toolArgs?.new_string;
        const isWriteOp = toolName === 'write_file' && thought.toolArgs?.content;
        const isGrepOp = toolName === 'grep_files' && thought.toolResult && !isInterrupted;
        const isListOp = toolName === 'list_files' && thought.toolResult && !isInterrupted;
        const isShellOp = toolName === 'shell_command' && thought.toolArgs?.command;
        const isReadOp = toolName === 'view_file' && thought.toolResult && !isInterrupted;
        const isWebSearchOp = toolName === 'search_web' && thought.toolResult && !isInterrupted;
        const isWebpageOp = toolName === 'read_webpage' && thought.toolResult && !isInterrupted;

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
                        {richArgs ? (
                            <span className="thought-args" title={richArgs.hoverText}>
                                {' '}
                                {richArgs.url ? (
                                    <a href={richArgs.url} target="_blank" rel="noopener noreferrer" className="thought-args-link">
                                        {richArgs.text}
                                    </a>
                                ) : (
                                    richArgs.text
                                )}
                            </span>
                        ) : formattedArgs ? (
                            <span className="thought-args"> {formattedArgs}</span>
                        ) : null}
                    </div>
                    {/* Show diff view for edit operations */}
                    {isEditOp && (
                        <ThoughtDiffView
                            oldText={thought.toolArgs.old_string}
                            newText={thought.toolArgs.new_string}
                            filePath={thought.toolArgs.file_path}
                        />
                    )}
                    {/* Show content preview for write operations */}
                    {isWriteOp && (
                        <ThoughtWriteView
                            content={thought.toolArgs.content}
                            filePath={thought.toolArgs.file_path}
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
                    {/* Show formatted read file results */}
                    {isReadOp && thought.toolResult && (
                        <ReadFileView
                            result={thought.toolResult}
                            filePath={thought.toolArgs?.path}
                        />
                    )}
                    {/* Show formatted web search results */}
                    {isWebSearchOp && thought.toolResult && (
                        <WebSearchView
                            result={thought.toolResult}
                            query={thought.toolArgs?.query}
                        />
                    )}
                    {/* Show formatted webpage content */}
                    {isWebpageOp && thought.toolResult && (
                        <WebpageView
                            result={thought.toolResult}
                            url={thought.toolArgs?.url}
                        />
                    )}
                    {/* Always show interrupted tool output in a generic view */}
                    {isInterrupted && thought.toolResult && (
                        <ToolResultView
                            result={thought.toolResult}
                            toolName={friendlyToolName}
                        />
                    )}
                    {/* Show regular result for other tools */}
                    {!isInterrupted && !isEditOp && !isWriteOp && !isGrepOp && !isListOp && !isShellOp && !isReadOp && !isWebSearchOp && !isWebpageOp && thought.toolResult && (
                        <ToolResultView
                            result={thought.toolResult}
                            toolName={friendlyToolName}
                        />
                    )}
                </div>
            </div>
        );
    }

    return null;
}
