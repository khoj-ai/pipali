// Gallery layout for active task cards

import React from 'react';
import type { ActiveTask } from '../../types';
import { TaskCard } from './TaskCard';

interface TaskCardGalleryProps {
    tasks: ActiveTask[];
    onSelectTask: (conversationId: string) => void;
}

export function TaskCardGallery({ tasks, onSelectTask }: TaskCardGalleryProps) {
    return (
        <div className="task-gallery">
            <div className="task-gallery-header">
                <h2>Active Tasks</h2>
                <span className="task-count">
                    {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} running
                </span>
            </div>
            <div className="task-cards">
                {tasks.map(task => (
                    <TaskCard
                        key={task.conversationId}
                        task={task}
                        onClick={() => onSelectTask(task.conversationId)}
                    />
                ))}
            </div>
        </div>
    );
}
