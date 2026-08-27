// Individual thought/tool_call rendering

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Thought } from '../../types';
import { formatDelegationToolResult, formatToolArgs, getFriendlyToolName, formatToolArgsRich, getToolCategory, getDelegatedConversationId } from '../../utils/formatting';
import { getToolResultStatus } from '../../utils/toolStatus';
import { useConversationNavigation } from '../../hooks/useConversationNavigation';
import { ExternalLink } from '../ExternalLink';
import { ChatMarkdown } from '../ChatMarkdown';
import { ThoughtDiffView } from '../tool-views/ThoughtDiffView';
import { ThoughtWriteView } from '../tool-views/ThoughtWriteView';
import { GrepResultView } from '../tool-views/GrepResultView';
import { ListResultView } from '../tool-views/ListResultView';
import { BashCommandView } from '../tool-views/BashCommandView';
import { ReadFileView } from '../tool-views/ReadFileView';
import { WebSearchView } from '../tool-views/WebSearchView';
import { WebpageView } from '../tool-views/WebpageView';
import { GenerateImageView } from '../tool-views/GenerateImageView';
import { ChromeSnapshotView } from '../tool-views/ChromeSnapshotView';
import { ChromePageView } from '../tool-views/ChromePageView';
import { ToolResultView } from '../tool-views/ToolResultView';

/** Chrome tools that show page lists in their results */
const CHROME_PAGE_TOOLS = new Set([
    'chrome-browser__list_pages',
    'chrome-browser__navigate_page',
    'chrome-browser__new_page',
    'chrome-browser__select_page',
    'chrome-browser__close_page',
]);

/** All tools with specialized result views (suppresses generic ToolResultView) */
const TOOLS_WITH_CUSTOM_VIEWS = new Set([
    'edit_file', 'write_file', 'grep_files', 'list_files',
    'shell_command', 'view_file', 'search_web', 'read_webpage',
    'generate_image', 'chrome-browser__take_snapshot',
    // Chrome page tools rendered by ChromePageView
    ...CHROME_PAGE_TOOLS,
    // Chrome tools with confirmation-only results (args already convey what happened)
    'chrome-browser__click', 'chrome-browser__hover', 'chrome-browser__fill',
    'chrome-browser__fill_form', 'chrome-browser__press_key',
    'chrome-browser__handle_dialog', 'chrome-browser__emulate',
    'chrome-browser__resize_page', 'chrome-browser__wait_for',
]);

/** Tools whose custom views already render error output — skip the generic error fallback */
const TOOLS_WITH_ERROR_HANDLING_VIEWS = new Set(['shell_command']);

interface ThoughtItemProps {
    thought: Thought;
    stepNumber: number; // Position among tool_call thoughts
    isPreview?: boolean;
    showResult?: boolean; // false = outline (title only), true = full (title + result)
    onToggle?: () => void; // Toggle this item's detail level individually
    uidMap?: Map<string, { role: string; label: string }>; // Chrome snapshot uid→label map
    delegatedTaskTitles?: Map<string, string>;
}

// Clear markdown markers for the single-line outline view, where the
// nowrap/ellipsis truncation needs plain inline text instead of rendered markdown
function formatPlainText(text: string): string {
    // Remove bold markers to start with; can expand to clear other formatting later
    return text.replace(/\*\*([^*]+)\*\*/g, '$1');
}

export function ThoughtItem({ thought, stepNumber, isPreview = false, showResult = true, onToggle, uidMap, delegatedTaskTitles }: ThoughtItemProps) {
    const { t } = useTranslation();
    const navigateToConversation = useConversationNavigation();
    // Track whether the reasoning text is overflowing (truncated by ellipsis)
    const [isOverflowing, setIsOverflowing] = useState(false);
    const reasoningRef = useCallback((el: HTMLDivElement | null) => {
        if (el) setIsOverflowing(el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
    }, [thought.content, showResult]);

    if (thought.type === 'thought' && thought.content) {
        const text = thought.content.trim();
        const isInternal = !!thought.isInternalThought;
        // Truncate internal reasoning in outline mode; show non-internal text in full
        const isOutline = !showResult && isInternal;
        const displayText = isOutline ? (text.split('\n')[0] ?? text) : text;
        const isTruncated = isOutline && (text.includes('\n') || isOverflowing);
        const canToggle = onToggle && isInternal && (isTruncated || showResult);
        return (
            <div
                className={`thought-item reasoning ${isInternal ? 'internal' : ''} ${isPreview ? 'preview' : ''}${canToggle ? ' clickable' : ''}`}
                onClick={canToggle ? onToggle : undefined}
            >
                <div className="thought-step"><span className="thought-reasoning-dot" /></div>
                <div className="thought-content">
                    <div
                        ref={isInternal ? reasoningRef : undefined}
                        className={`thought-reasoning ${isInternal ? 'italic' : ''} ${isOutline ? 'outline' : ''}`}
                        title={isTruncated ? text : undefined}
                    >
                        {isOutline ? formatPlainText(displayText) : <ChatMarkdown compact>{displayText}</ChatMarkdown>}
                    </div>
                </div>
            </div>
        );
    }

    if (thought.type === 'tool_call') {
        const toolName = thought.toolName || '';
        const delegationText = {
            background: t('thoughts.delegationBackground'),
            modelTier: (tier: string) => {
                const tierLabels: Record<string, string> = {
                    flagship: t('inputArea.tierFlagship'),
                    balanced: t('inputArea.tierBalanced'),
                    lite: t('inputArea.tierLite'),
                };
                return t('thoughts.delegationModel', { tier: tierLabels[tier] ?? tier });
            },
            waitForTasks: (tasks: string) => t('thoughts.waitForTasks', { tasks }),
            noRunInProgress: t('thoughts.noRunInProgress'),
        };
        const richArgs = formatToolArgsRich(
            toolName,
            thought.toolArgs,
            !showResult,
            uidMap,
            delegatedTaskTitles,
            delegationText,
        );
        const formattedArgs = richArgs ? '' : formatToolArgs(toolName, thought.toolArgs);
        const friendlyToolName = getFriendlyToolName(toolName);
        const isInterrupted = thought.toolResult?.trim() === '[interrupted]';
        const displayToolResult = formatDelegationToolResult(
            toolName,
            thought.toolResult,
            delegationText.noRunInProgress,
        );
        const category = getToolCategory(toolName);
        const operationType = toolName.includes('__') ? thought.toolArgs?.operation_type : undefined;

        // Determine success/error status for step indicator (pending takes precedence)
        const stepStatus = thought.isPending ? 'pending' : getToolResultStatus(thought.toolResult, toolName);
        const canToggle = !!onToggle;
        // Delegated conversations are kept out of the sidebar, so this step is the way in
        const delegatedConversationId = getDelegatedConversationId(toolName, thought.toolResult);

        return (
            <div className={`thought-item ${isPreview ? 'preview' : ''} ${thought.isPending ? 'pending' : ''}`}>
                <div className={`thought-step ${showResult ? stepStatus : ''}${canToggle ? ' clickable' : ''}`} onClick={canToggle ? onToggle : undefined}>
                    {showResult ? stepNumber : (
                        <span className={`thought-category-dot thought-category-dot--${category}${thought.isPending ? ' thought-category-dot--pending' : ''}`} />
                    )}
                </div>
                <div className="thought-content">
                    <div className={`thought-tool${canToggle ? ' clickable' : ''}`} onClick={canToggle ? onToggle : undefined}>
                        {friendlyToolName}
                        {operationType === 'unsafe' && (
                            <span className="thought-op-badge thought-op-badge--unsafe" title="This action may have lasting side effects">unsafe</span>
                        )}
                        {richArgs ? (
                            <span className="thought-args" title={richArgs.hoverText}>
                                {' '}
                                {richArgs.url ? (
                                    <ExternalLink href={richArgs.url} className="thought-args-link">
                                        {richArgs.text}
                                    </ExternalLink>
                                ) : delegatedConversationId && navigateToConversation ? (
                                    <button
                                        type="button"
                                        className="thought-args-link thought-args-button"
                                        onClick={(e) => { e.stopPropagation(); navigateToConversation(delegatedConversationId); }}
                                    >
                                        {richArgs.text}
                                    </button>
                                ) : (
                                    <span className="thought-args-primary">{richArgs.text}</span>
                                )}
                                {richArgs.secondary && (
                                    <span className="thought-args-secondary"> {richArgs.secondary}</span>
                                )}
                            </span>
                        ) : formattedArgs ? (
                            <span className="thought-args"> {formattedArgs}</span>
                        ) : null}
                    </div>
                    {showResult && (
                        <>
                            {/* Show diff view for edit operations */}
                            {toolName === 'edit_file' && thought.toolArgs?.old_string && thought.toolArgs?.new_string && (
                                <ThoughtDiffView
                                    oldText={thought.toolArgs.old_string}
                                    newText={thought.toolArgs.new_string}
                                    filePath={thought.toolArgs.file_path}
                                />
                            )}
                            {/* Show content preview for write operations */}
                            {toolName === 'write_file' && thought.toolArgs?.content && (
                                <ThoughtWriteView
                                    content={thought.toolArgs.content}
                                    filePath={thought.toolArgs.file_path}
                                />
                            )}
                            {/* Show formatted grep results */}
                            {toolName === 'grep_files' && thought.toolResult && !isInterrupted && (
                                <GrepResultView result={thought.toolResult} />
                            )}
                            {/* Show formatted list results */}
                            {toolName === 'list_files' && thought.toolResult && !isInterrupted && (
                                <ListResultView result={thought.toolResult} />
                            )}
                            {/* Show bash command view */}
                            {toolName === 'shell_command' && thought.toolArgs?.command && !isInterrupted && (
                                <BashCommandView
                                    command={thought.toolArgs.command}
                                    justification={thought.toolArgs.justification}
                                    cwd={thought.toolArgs.cwd}
                                    result={thought.toolResult}
                                />
                            )}
                            {/* Show formatted read file results */}
                            {toolName === 'view_file' && thought.toolResult && !isInterrupted && (
                                <ReadFileView
                                    result={thought.toolResult}
                                    filePath={thought.toolArgs?.path}
                                />
                            )}
                            {/* Show formatted web search results */}
                            {toolName === 'search_web' && thought.toolResult && !isInterrupted && (
                                <WebSearchView
                                    result={thought.toolResult}
                                    query={thought.toolArgs?.query}
                                />
                            )}
                            {/* Show formatted webpage content */}
                            {toolName === 'read_webpage' && thought.toolResult && !isInterrupted && (
                                <WebpageView
                                    result={thought.toolResult}
                                    url={thought.toolArgs?.url}
                                />
                            )}
                            {/* Show generated image result */}
                            {toolName === 'generate_image' && thought.toolResult && !isInterrupted && (
                                <GenerateImageView result={thought.toolResult} />
                            )}
                            {/* Show chrome browser snapshot as visual page outline */}
                            {toolName === 'chrome-browser__take_snapshot' && thought.toolResult && !isInterrupted && (
                                <ChromeSnapshotView result={thought.toolResult} />
                            )}
                            {/* Show chrome page list for page-related tools */}
                            {CHROME_PAGE_TOOLS.has(toolName) && thought.toolResult && !isInterrupted && (
                                <ChromePageView result={thought.toolResult} />
                            )}
                            {/* Show interrupted tool output */}
                            {isInterrupted && thought.toolResult && (
                                <ToolResultView
                                    result={thought.toolResult}
                                    toolName={friendlyToolName}
                                />
                            )}
                            {/* Show regular result for other tools, or error output for tools with suppressed results */}
                            {!isInterrupted && displayToolResult && (
                                !TOOLS_WITH_CUSTOM_VIEWS.has(toolName) ||
                                (stepStatus === 'error' && !TOOLS_WITH_ERROR_HANDLING_VIEWS.has(toolName))
                            ) && (
                                <ToolResultView
                                    result={displayToolResult}
                                    toolName={friendlyToolName}
                                />
                            )}
                        </>
                    )}
                </div>
            </div>
        );
    }

    return null;
}
