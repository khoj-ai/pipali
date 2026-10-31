import { useCallback, useRef } from 'react';

/**
 * A function whose identity never changes and that always calls the latest `fn`. Lets a
 * parent that rebuilds its handlers on every render pass them to memoized children
 * without either defeating the memo or leaving them holding a stale closure.
 */
export function useStableCallback<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result {
    const latest = useRef(fn);
    latest.current = fn;
    return useCallback((...args: Args) => latest.current(...args), []);
}
