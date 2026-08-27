// Individual thought/tool_call rendering

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Thought } from '../../types';
import { formatCharCount, formatDelegationToolResult, formatToolArgs, getFriendlyToolName, formatToolArgsRich, getToolCategory, getDelegatedConversationId } from '../../utils/formatting';
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
    runStreaming?: boolean; // The run this thought belongs to is still in flight
}

// Clear markdown markers for the single-line outline view, where the
// nowrap/ellipsis truncation needs plain inline text instead of rendered markdown
function formatPlainText(text: string): string {
    // Remove bold markers to start with; can expand to clear other formatting later
    return text.replace(/\*\*([^*]+)\*\*/g, '$1');
}

/**
 * Reasoning is generated far faster than it can be read, so an outline row samples
 * it at this cadence instead of following every delta. Long enough to read a short
 * sentence; short enough that the row still reads as live.
 */
const REASONING_SAMPLE_MS = 1200;

/**
 * Reasoning has gone quiet once no delta has extended it for this long, and the row
 * refreshes early rather than waiting out the sample interval. Comfortably above 50ms
 * the bus flushes reasoning deltas at, so a live stream never looks quiet: a bursty
 * model that trips it early only repeats the refresh the interval would have made.
 */
const REASONING_SETTLE_MS = 250;

/**
 * A run of text this short did not end a sentence: a list marker, an ordinal or an
 * abbreviation put a period there. Models that number their reasoning steps produce
 * these constantly, and splitting on them strands a row showing "2." or "e.g.".
 */
const MIN_SENTENCE_CHARS = 12;

/**
 * Newest sentence the model has finished writing, else the line so far. Sampling
 * mid-sentence gives a fragment starting mid-word, which is what makes a fast
 * stream unreadable in the first place.
 */
export function newestSentence(text: string): string {
    const line = text.split('\n').at(-1)?.trim() || text;

    const sentences: string[] = [];
    for (const part of line.split(/(?<=[.!?])\s+/).filter(Boolean)) {
        const previous = sentences.at(-1);
        if (previous !== undefined && previous.length < MIN_SENTENCE_CHARS) {
            sentences[sentences.length - 1] = `${previous} ${part}`;
        } else {
            sentences.push(part);
        }
    }

    if (sentences.length < 2) return line;
    // The final entry is still being written unless the line closes on a terminator
    const finished = /[.!?]["')\]]?$/.test(line) ? sentences.at(-1) : sentences.at(-2);
    return finished ?? line;
}

/**
 * Hold one sentence of streaming text still long enough to read, then jump to the
 * newest. Sampling on a timer rather than on each delta keeps the cadence steady
 * whatever rate the model writes at.
 */
function useSampledText(text: string, active: boolean): string {
    const [sampled, setSampled] = useState('');
    const latest = useRef(text);
    latest.current = text;

    useEffect(() => {
        if (!active) return;
        // No sample up front: at mount only the first few characters have arrived, and
        // holding those for a full interval shows a stray word. Callers fall back to the
        // live text until the first interval lands, by which point a sentence exists.
        const timer = setInterval(() => setSampled(newestSentence(latest.current)), REASONING_SAMPLE_MS);
        return () => clearInterval(timer);
    }, [active]);

    // Refresh early when reasoning goes quiet, so a sentence from mid-thought does not
    // sit on screen for the rest of the interval after the model has moved on.
    useEffect(() => {
        if (!active) return;
        const settle = setTimeout(() => setSampled(newestSentence(latest.current)), REASONING_SETTLE_MS);
        return () => clearTimeout(settle);
    }, [text, active]);

    return sampled;
}

export function ThoughtItem({ thought, stepNumber, isPreview = false, showResult = true, onToggle, uidMap, delegatedTaskTitles, runStreaming = false }: ThoughtItemProps) {
    const { t } = useTranslation();
    const navigateToConversation = useConversationNavigation();
    // Internal reasoning collapses to one line outside the detailed view. While the run is
    // live that line tracks where the model got to; at run end every row reverts to its
    // first line at once, so nothing above the step being read shifts mid-run.
    const isOutline = thought.type === 'thought' && !!thought.isInternalThought && !showResult;
    // Only the live thought needs a timer. A settled one is static text already, and
    // newestSentence over it returns the same line every render.
    const sampledReasoning = useSampledText(thought.content, isOutline && !!thought.isStreaming);
    // Track whether the reasoning text is overflowing (truncated by ellipsis)
    const [isOverflowing, setIsOverflowing] = useState(false);
    const reasoningRef = useCallback((el: HTMLDivElement | null) => {
        if (el) setIsOverflowing(el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
    }, [thought.content, showResult]);

    if (thought.type === 'thought' && thought.content.trim()) {
        const text = thought.content.trim();
        const isInternal = !!thought.isInternalThought;
        // Where the model got to while the run is live, where it started once it is done
        const outlineText = runStreaming
            ? (sampledReasoning || newestSentence(text))
            : (text.split('\n')[0] ?? text);
        const displayText = isOutline ? outlineText : text;
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
                        {/* A call opens at 0 chars, so any count above that means arguments are streaming */}
                        {thought.isStreaming && (thought.argChars ?? 0) > 0 && (
                            <span className="thought-args thought-args-secondary">
                                {' '}
                                {t('thoughts.streamedArgs', { chars: formatCharCount(thought.argChars!) })}
                            </span>
                        )}
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
