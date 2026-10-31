// The composer's text, kept outside React state. Only what shows the draft subscribes,
// so a keystroke redraws those components alone rather than App and the whole
// conversation below it.

import { useSyncExternalStore } from 'react';

export interface ComposerDraft {
    get: () => string;
    set: (text: string) => void;
    subscribe: (listener: () => void) => () => void;
}

export function createComposerDraft(): ComposerDraft {
    let text = '';
    const listeners = new Set<() => void>();

    return {
        get: () => text,
        set: (next) => {
            if (next === text) return;
            text = next;
            for (const listener of listeners) listener();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

export function useDraftText(draft: ComposerDraft): string {
    return useSyncExternalStore(draft.subscribe, draft.get);
}

/** Changes only as the draft empties or fills, not on every keystroke. */
export function useHasDraft(draft: ComposerDraft): boolean {
    return useSyncExternalStore(draft.subscribe, () => draft.get().trim().length > 0);
}
