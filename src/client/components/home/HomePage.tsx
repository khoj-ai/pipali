// Main home page component

import React from 'react';
import type { ActiveTask } from '../../types';
import type { ComposerDraft } from '../../hooks/useComposerDraft';
import { TaskCardGallery } from './TaskCardGallery';
import { EmptyHomeState } from './EmptyHomeState';

interface HomePageProps {
    activeTasks: ActiveTask[];
    onSelectTask: (conversationId: string) => void;
    onClearFinished: () => void;
    userFirstName?: string;
    draft: ComposerDraft;
}

export function HomePage({ activeTasks, onSelectTask, onClearFinished, userFirstName, draft }: HomePageProps) {
    return (
        <main className="main-content">
            <div className="messages-container">
                {activeTasks.length === 0 ? (
                    <EmptyHomeState userFirstName={userFirstName} draft={draft} />
                ) : (
                    <TaskCardGallery
                        tasks={activeTasks}
                        onSelectTask={onSelectTask}
                        onClearFinished={onClearFinished}
                    />
                )}
            </div>
        </main>
    );
}
