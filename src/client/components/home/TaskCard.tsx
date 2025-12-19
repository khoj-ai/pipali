// Individual task card for home page gallery

import React from 'react';
import { Loader2, Pause, ChevronRight } from 'lucide-react';
import type { ActiveTask } from '../../types';

interface TaskCardProps {
    task: ActiveTask;
    onClick: () => void;
}

export function TaskCard({ task, onClick }: TaskCardProps) {
    // Truncate reasoning to first line and limit length
    const reasoningPreview = task.reasoning
        ? task.reasoning.split('\n')[0]?.slice(0, 100) + (task.reasoning.length > 100 ? '...' : '')
        : undefined;

    return (
        <div
            className={`task-card ${task.isPaused ? 'paused' : ''}`}
            onClick={onClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClick();
                }
            }}
        >
            <div className="task-card-header">
                {task.isPaused ? (
                    <Pause size={16} className="task-status-icon paused" />
                ) : (
                    <Loader2 size={16} className="task-status-icon spinning" />
                )}
                <span className="task-status-text">
                    {task.isPaused ? 'Paused' : 'Running'}
                </span>
                {task.stepCount !== undefined && task.stepCount > 0 && (
                    <span className="task-step-count">{task.stepCount} steps</span>
                )}
            </div>

            <h3 className="task-card-title">{task.title}</h3>

            {reasoningPreview && (
                <p className="task-card-reasoning">{reasoningPreview}</p>
            )}

            <div className="task-card-footer">
                <span className="view-details">View details</span>
                <ChevronRight size={14} />
            </div>
        </div>
    );
}
