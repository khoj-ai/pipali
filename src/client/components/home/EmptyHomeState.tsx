// Empty state when no active tasks on home page

import { Sparkles } from 'lucide-react';

export function EmptyHomeState() {
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const shortcutKey = isMac ? 'Cmd' : 'Ctrl';

    return (
        <div className="empty-state home-empty">
            <Sparkles className="empty-icon" size={32} strokeWidth={1.5} />
            <h2>Welcome to Pipali</h2>
            <p>Start a new task or research below.</p>
            <p className="empty-hint">
                Use <kbd>{shortcutKey}</kbd> + <kbd>Enter</kbd> to run tasks in the background.
            </p>
        </div>
    );
}
