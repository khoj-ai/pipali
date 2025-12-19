// Expandable thoughts section showing AI reasoning and tool calls

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Thought } from '../../types';
import { ThoughtItem } from './ThoughtItem';

interface ThoughtsSectionProps {
    thoughts: Thought[];
    isStreaming?: boolean;
}

export function ThoughtsSection({ thoughts, isStreaming }: ThoughtsSectionProps) {
    const [isExpanded, setIsExpanded] = useState(false);

    if (thoughts.length === 0) return null;

    const toolCallCount = thoughts.filter(t => t.type === 'tool_call').length;
    const thoughtCount = thoughts.filter(t => t.type === 'thought').length;

    // Get the most recent thought/tool_call for streaming preview
    const latestThought = thoughts.length > 0 ? thoughts[thoughts.length - 1] : null;

    // Build summary text
    const getSummary = () => {
        if (toolCallCount > 0) {
            return `${toolCallCount} step${toolCallCount > 1 ? 's' : ''} taken`;
        } else if (thoughtCount > 0) {
            return 'Reasoning';
        }
        return '';
    };

    // Calculate the step number for a thought (position among tool_call thoughts)
    const getStepNumber = (idx: number): number => {
        return thoughts.slice(0, idx).filter(t => t.type === 'tool_call').length + 1;
    };

    return (
        <div className="thoughts-section">
            <button
                className="thoughts-toggle"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <span className="thoughts-summary">
                    {getSummary()}
                </span>
                <ChevronDown
                    size={14}
                    className={`thoughts-chevron ${isExpanded ? 'expanded' : ''}`}
                />
            </button>

            {/* Show streaming preview of latest thought when not expanded */}
            {isStreaming && !isExpanded && latestThought && (
                <div className="thoughts-preview">
                    <ThoughtItem
                        thought={latestThought}
                        stepNumber={getStepNumber(thoughts.length - 1)}
                        isPreview={true}
                    />
                </div>
            )}

            {isExpanded && (
                <div className="thoughts-list">
                    {/* Render thoughts in the order they appear */}
                    {thoughts.map((thought, idx) => (
                        <ThoughtItem
                            key={thought.id}
                            thought={thought}
                            stepNumber={getStepNumber(idx)}
                            isPreview={false}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
