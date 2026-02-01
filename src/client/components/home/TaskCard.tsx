// Individual task card for home page gallery

import { Loader2, AlertCircle, CheckCircle, ChevronRight } from 'lucide-react';
import type { ActiveTask, TaskStatus } from '../../types';

const statusConfig: Record<TaskStatus, { label: string; className: string; Icon: typeof Loader2 }> = {
    running: { label: 'Running', className: 'running', Icon: Loader2 },
    needs_input: { label: 'Needs Input', className: 'needs-input', Icon: AlertCircle },
    completed: { label: 'Completed', className: 'completed', Icon: CheckCircle },
    stopped: { label: 'Stopped', className: 'stopped', Icon: AlertCircle },
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
