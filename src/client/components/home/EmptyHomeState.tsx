// Empty state when no active tasks on home page

import React from 'react';
import { Sparkles } from 'lucide-react';

export function EmptyHomeState() {
    return (
        <div className="empty-state home-empty">
            <Sparkles className="empty-icon" size={32} strokeWidth={1.5} />
            <h2>Welcome to Panini</h2>
            <p>Start a new task or research below.</p>
            <p className="empty-hint">
                Use <kbd>Cmd</kbd> + <kbd>Enter</kbd> to run tasks in the background.
            </p>
        </div>
    );
}
