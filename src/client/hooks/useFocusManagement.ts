// Focus management hook for textarea input

import { useRef, useCallback } from 'react';

export function useFocusManagement() {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const focusTextarea = useCallback(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        if (textarea.disabled) return;
        // If the element isn't currently visible/layouted, focusing can be flaky.
        if (textarea.offsetParent === null) return;
        textarea.focus({ preventScroll: true });
    }, []);

    const scheduleTextareaFocus = useCallback(() => {
        // Schedule after React commits + browser paints to avoid focus being lost
        // due to re-renders/state transitions.
        requestAnimationFrame(() => {
            setTimeout(() => focusTextarea(), 0);
        });
    }, [focusTextarea]);

    return { textareaRef, focusTextarea, scheduleTextareaFocus };
}
