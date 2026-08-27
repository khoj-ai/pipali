// Expandable thoughts section showing AI reasoning and tool calls
// Uses org-mode S-TAB style 3-level cycling: Collapsed → Outline → Full → Collapsed

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, Globe, FileSearch, Pencil, Lightbulb, Terminal, Wrench } from 'lucide-react';
import type { Thought } from '../../types';
import { ThoughtItem } from './ThoughtItem';
import { buildDelegatedTaskTitleMap, formatCharCount, getToolCategory, type ToolCategory } from '../../utils/formatting';
import { parseSnapshotUids } from '../../utils/snapshotParser';

const CATEGORY_ICONS: Record<ToolCategory, React.ComponentType<{ size?: number }>> = {
    web: Globe,
    read: FileSearch,
    write: Pencil,
    execute: Terminal,
    other: Wrench,
};

const CATEGORY_ORDER: ToolCategory[] = ['web', 'read', 'write', 'execute', 'other'];

// 0 = collapsed, 1 = outline (titles only), 2 = full (titles + results)
type ExpandLevel = 0 | 1 | 2;

const EXPAND_LEVEL_KEY = 'thoughts-expand-level';

function getStoredExpandLevel(): ExpandLevel {
    const stored = localStorage.getItem(EXPAND_LEVEL_KEY);
    if (stored === '1' || stored === '2') return Number(stored) as ExpandLevel;
    return 0;
}

const CHEVRON_ICONS: Record<ExpandLevel, React.ComponentType<{ size?: number; className?: string }>> = {
    0: ChevronRight,
    1: ChevronDown,
    2: ChevronUp,
};

interface ThoughtsSectionProps {
    thoughts: Thought[];
    isStreaming?: boolean;
}

// Split a thought with multiple **heading** sections into separate thoughts for display.
// e.g. "**Doing X**\nbody\n**Doing Y**\nbody2" → two thought items.
function splitMultiHeadingThoughts(thoughts: Thought[]): Thought[] {
    const result: Thought[] = [];
    for (const thought of thoughts) {
        if (thought.type !== 'thought' || !thought.content) {
            result.push(thought);
            continue;
        }

        const text = thought.content.trim();
        // Split on lines that start with **heading** (bold markdown)
        const sections = text.split(/(?=^\*\*[^*]+\*\*)/m);
        if (sections.length <= 1) {
            result.push(thought);
            continue;
        }

        for (let i = 0; i < sections.length; i++) {
            const section = sections[i]!.trim();
            if (!section) continue;
            result.push({
                ...thought,
                id: `${thought.id}-${i}`,
                content: section,
            });
        }
    }
    return result;
}

export function getCollapsedPreviewThoughts(thoughts: Thought[]): Thought[] {
    const latestToolCall = thoughts.findLast(thought => thought.type === 'tool_call');
    if (!latestToolCall) return [];

    const latestStepGroupId = latestToolCall.stepGroupId;
    const stepThoughts = latestStepGroupId
        ? thoughts.filter(thought => thought.stepGroupId === latestStepGroupId)
        : thoughts.slice(thoughts.findLastIndex(thought => thought.type === 'tool_call'));

    return stepThoughts
        .filter(thought => thought.type === 'tool_call' || (thought.type === 'thought' && !thought.isInternalThought))
        .map(thought => {
            if (thought.type === 'tool_call' && thought.toolResult !== undefined) {
                return {
                    ...thought,
                    toolResult: undefined,
                };
            }
            return thought;
        });
}

export function ThoughtsSection({ thoughts, isStreaming }: ThoughtsSectionProps) {
    const [expandLevel, setExpandLevel] = useState<ExpandLevel>(getStoredExpandLevel);
    // Per-item overrides: at level 1, toggled items show full; at level 2, toggled items show outline
    const [toggledItems, setToggledItems] = useState<Set<string>>(new Set());
    const previewRef = useRef<HTMLDivElement>(null);

    const toggleItem = useCallback((id: string) => {
        setToggledItems(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    if (thoughts.length === 0) return null;

    const toolCalls = thoughts.filter(t => t.type === 'tool_call');
    // Collapsed hides reasoning itself, so its size is the only sign the model is
    // thinking. Its own trail category marks the count as reasoning, not as another tool.
    const internalThoughts = thoughts.filter(t => t.type === 'thought' && t.isInternalThought);
    const reasoningChars = internalThoughts.reduce((total, t) => total + t.content.trim().length, 0);
    const isThinking = internalThoughts.some(t => t.isStreaming);
    const reasoningTrailEntry = reasoningChars > 0 && (
        <span className="trail-group">
            <span className={`trail-icon trail-icon--reasoning${isThinking ? ' trail-icon--pending' : ''}`}>
                <Lightbulb size={10} />
            </span>
            <span className="trail-group-count">{formatCharCount(reasoningChars)}</span>
        </span>
    );

    // Build uid→label map from chrome snapshot results for resolving interaction tool args
    const uidMap = useMemo(() => {
        const map = new Map<string, { role: string; label: string }>();
        for (const t of thoughts) {
            if (t.type === 'tool_call' && t.toolName === 'chrome-browser__take_snapshot' && t.toolResult) {
                for (const [uid, info] of parseSnapshotUids(t.toolResult)) {
                    map.set(uid, info); // Later snapshots overwrite earlier ones (uid numbers change)
                }
            }
        }
        return map.size > 0 ? map : undefined;
    }, [thoughts]);

    const delegatedTaskTitles = useMemo(() => buildDelegatedTaskTitleMap(thoughts), [thoughts]);

    const collapsedPreviewThoughts = useMemo(() => (
        isStreaming && expandLevel === 0
            ? getCollapsedPreviewThoughts(splitMultiHeadingThoughts(thoughts))
            : []
    ), [expandLevel, isStreaming, thoughts]);

    // Which step the preview is showing, keyed the way the preview itself selects one.
    const previewStepKey = collapsedPreviewThoughts[0]?.stepGroupId ?? collapsedPreviewThoughts[0]?.id;

    // Open each step on its first row. Within a step the reader is left where they are:
    // the preview redraws on every streamed character, and following that would both
    // fight anyone scrolling back and hold the view on the step's last row.
    useEffect(() => {
        const preview = previewRef.current;
        if (preview) preview.scrollTop = 0;
    }, [previewStepKey]);

    // Cycle: 0 → 1 → 2 → 0
    const cycleExpand = () => {
        setExpandLevel(prev => {
            const next = ((prev + 1) % 3) as ExpandLevel;
            localStorage.setItem(EXPAND_LEVEL_KEY, String(next));
            return next;
        });
        // clear per-item overrides on global change
        setToggledItems(new Set());
    };

    // Render grouped category icons with counts for the toggle button
    const renderSummary = () => {
        if (toolCalls.length === 0) {
            return reasoningTrailEntry ? <span className="thoughts-icon-trail">{reasoningTrailEntry}</span> : null;
        }

        // Count tool calls by category
        const counts = new Map<ToolCategory, number>();
        for (const tc of toolCalls) {
            const cat = getToolCategory(tc.toolName || '');
            counts.set(cat, (counts.get(cat) || 0) + 1);
        }

        // Find which category is currently pending (if any)
        const pendingToolCall = toolCalls.findLast(tc => tc.isPending);
        const pendingCategory = pendingToolCall
            ? getToolCategory(pendingToolCall.toolName || '')
            : null;

        return (
            <span className="thoughts-icon-trail">
                {CATEGORY_ORDER
                    .filter(cat => counts.has(cat))
                    .map(cat => {
                        const Icon = CATEGORY_ICONS[cat];
                        const count = counts.get(cat)!;
                        const isPending = cat === pendingCategory;
                        return (
                            <span key={cat} className="trail-group">
                                <span className={`trail-icon trail-icon--${cat}${isPending ? ' trail-icon--pending' : ''}`}>
                                    <Icon size={10} />
                                </span>
                                <span className="trail-group-count">{count}</span>
                            </span>
                        );
                    })}
                {reasoningTrailEntry}
            </span>
        );
    };

    const Chevron = CHEVRON_ICONS[expandLevel];

    return (
        <div className="thoughts-section">
            <div className="thoughts-header">
                <button
                    className="thoughts-toggle"
                    onClick={cycleExpand}
                >
                    <span className="thoughts-summary">
                        {renderSummary()}
                    </span>
                    <Chevron size={14} className="thoughts-chevron" />
                </button>
            </div>

            {/* Show assistant-visible messages and tool calls while collapsed, without tool results */}
            {collapsedPreviewThoughts.length > 0 && (() => {
                let toolCallIndex = 0;
                return (
                    <div className="thoughts-preview" ref={previewRef}>
                        {collapsedPreviewThoughts.map((thought) => {
                            const stepNumber = thought.type === 'tool_call' ? ++toolCallIndex : 0;
                            return (
                                <ThoughtItem
                                    key={thought.id}
                                    thought={thought}
                                    stepNumber={stepNumber}
                                    isPreview={true}
                                    showResult={false}
                                    uidMap={uidMap}
                                    delegatedTaskTitles={delegatedTaskTitles}
                                    runStreaming={isStreaming}
                                />
                            );
                        })}
                    </div>
                );
            })()}

            {/* Level 1: Outline - titles with category dots, no results */}
            {/* Level 2: Full - titles with category dots + tool results */}
            {expandLevel > 0 && (() => {
                const displayThoughts = splitMultiHeadingThoughts(thoughts);
                let toolCallIndex = 0;
                return (
                    <div className="thoughts-list">
                        {displayThoughts.map((thought) => {
                            const stepNumber = thought.type === 'tool_call' ? ++toolCallIndex : 0;
                            const isToggled = toggledItems.has(thought.id);
                            // Level 1: default outline, toggled → full. Level 2: default full, toggled → outline.
                            const showResult = expandLevel === 2 ? !isToggled : isToggled;
                            return (
                                <ThoughtItem
                                    key={thought.id}
                                    thought={thought}
                                    stepNumber={stepNumber}
                                    isPreview={false}
                                    showResult={showResult}
                                    onToggle={() => toggleItem(thought.id)}
                                    uidMap={uidMap}
                                    delegatedTaskTitles={delegatedTaskTitles}
                                    runStreaming={isStreaming}
                                />
                            );
                        })}
                    </div>
                );
            })()}
        </div>
    );
}
