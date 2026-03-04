// Individual task card for home page gallery

import React from 'react';
import { Loader2, AlertCircle, CheckCircle, Globe, FileSearch, Pencil, Terminal, Wrench, Pin, PinOff } from 'lucide-react';
import type { ActiveTask, TaskStatus } from '../../types';
import type { ToolCategory } from '../../utils/formatting';

const CATEGORY_ICONS: Record<ToolCategory, React.ComponentType<{ size?: number }>> = {
    web: Globe,
    read: FileSearch,
    write: Pencil,
    execute: Terminal,
    other: Wrench,
};

const CATEGORY_ORDER: ToolCategory[] = ['web', 'read', 'write', 'execute', 'other'];

const statusConfig: Record<TaskStatus, { label: string; className: string; Icon: typeof Loader2 }> = {
    running: { label: 'Running', className: 'running', Icon: Loader2 },
    needs_input: { label: 'Needs Input', className: 'needs-input', Icon: AlertCircle },
    completed: { label: 'Completed', className: 'completed', Icon: CheckCircle },
    stopped: { label: 'Stopped', className: 'stopped', Icon: AlertCircle },
    pinned: { label: 'Pinned', className: 'pinned', Icon: Pin },
};

interface TaskCardProps {
    task: ActiveTask;
    onClick: () => void;
}

export function TaskCard({ task, onClick }: TaskCardProps) {
    // Truncate reasoning to first line and limit length
    const reasoningPreview = task.reasoning
        ? task.reasoning.split('\n')[0]?.slice(0, 100) + (task.reasoning.length > 100 ? '...' : '')
        : undefined;

    const { label, className, Icon } = statusConfig[task.status];

    return (
        <div
            className={`task-card ${className}`}
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
                <Icon size={16} className={`task-status-icon ${className}`} />
                <span className={`task-status-text ${className}`}>
                    {label}
                </span>
                {task.toolCategories && Object.keys(task.toolCategories).length > 0 && (
                    <span className="thoughts-icon-trail task-icon-trail">
                        {CATEGORY_ORDER
                            .filter(cat => task.toolCategories![cat])
                            .map(cat => {
                                const CatIcon = CATEGORY_ICONS[cat];
                                return (
                                    <span key={cat} className="trail-group">
                                        <span className={`trail-icon trail-icon--${cat}`}>
                                            <CatIcon size={10} />
                                        </span>
                                        <span className="trail-group-count">{task.toolCategories![cat]}</span>
                                    </span>
                                );
                            })
                        }
                    </span>
                )}
            </div>

            <h3 className="task-card-title">{task.title}</h3>

            {reasoningPreview && (
                <p className="task-card-reasoning">{reasoningPreview}</p>
            )}

            <div className="task-card-footer">
                {task.onTogglePin && (
                    <button
                        className={`task-pin-btn ${task.isPinned ? 'active' : ''}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            task.onTogglePin!();
                        }}
                        aria-label={task.isPinned ? 'Unpin from home' : 'Pin to home'}
                        title={task.isPinned ? 'Unpin from home' : 'Pin to home'}
                    >
                        <PinOff size={14} className="pin-off-icon" />
                        <Pin size={14} className="pin-icon" />
                    </button>
                )}
            </div>
        </div>
    );
}
