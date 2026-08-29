/**
 * Pull down from the top of a page to reload the app.
 *
 * An installed app on a phone has no browser chrome, so the page itself has to offer the
 * refresh that a tab gets from its toolbar. The gesture only runs on finger-first
 * devices; a desktop keeps its keyboard shortcut and its own refresh control.
 */

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { createPullTracker, TRIGGER_DISTANCE } from '../../utils/pull-to-refresh';
import { IS_COARSE_POINTER } from '../../utils/platform';
import { isTauri } from '../../utils/tauri';

interface PullToRefreshProps {
    /** Reloads the app. Called once, when a pull is released past the trigger distance. */
    onRefresh: () => void;
}

/** Something the browser would scroll, as opposed to a label that merely clips its text. */
function isScrollContainer(el: Element, style: CSSStyleDeclaration): boolean {
    const { overflowY } = style;
    if (overflowY === 'auto' || overflowY === 'scroll') return true;
    return overflowY === 'hidden' && el.scrollHeight > el.clientHeight;
}

/**
 * The pull belongs to the page only when the touch lands on the page's own scroller,
 * already at its top. A dialog, the composer or a scrollable code block is a scroller in
 * its own right and claims the touch first, and anything floating above the page is not
 * the page at all. Between them that is what keeps a pull elsewhere on the screen from
 * reloading the app underneath it.
 */
function startsAtPageTop(target: EventTarget | null): boolean {
    let el = target instanceof Element ? target : null;
    while (el) {
        const style = getComputedStyle(el);
        if (style.position === 'fixed') return false;
        if (isScrollContainer(el, style)) return el.classList.contains('main-content') && el.scrollTop <= 0;
        el = el.parentElement;
    }
    return false;
}

export function PullToRefresh({ onRefresh }: PullToRefreshProps) {
    const indicatorRef = useRef<HTMLDivElement>(null);
    const [refreshing, setRefreshing] = useState(false);
    const refreshRef = useRef(onRefresh);
    refreshRef.current = onRefresh;

    useEffect(() => {
        if (!IS_COARSE_POINTER || isTauri()) return;

        const tracker = createPullTracker();
        let refreshingNow = false;

        /** Follows the finger while pulling, then eases home once it lets go. */
        const paint = (distance: number, settle: boolean) => {
            const node = indicatorRef.current;
            if (!node) return;
            node.style.transition = settle ? 'transform var(--transition-normal), opacity var(--transition-normal)' : 'none';
            node.style.transform = `translate(-50%, ${distance}px)`;
            node.style.setProperty('--pull-progress', `${Math.min(1, distance / TRIGGER_DISTANCE)}`);
        };

        // A non-passive move listener makes every scroll wait on the main thread, so the
        // listeners below live only from a touch that could be a pull until it resolves.
        // Every other scroll never leaves the compositor.
        const detach = () => {
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('touchend', onTouchEnd);
            document.removeEventListener('touchcancel', abandon);
        };

        const abandon = () => {
            tracker.cancel();
            detach();
            paint(0, true);
        };

        const onTouchStart = (e: TouchEvent) => {
            if (refreshingNow) return;
            const touch = e.touches[0];
            if (e.touches.length !== 1 || !touch || !startsAtPageTop(e.target)) return;
            tracker.start(touch.clientX, touch.clientY);
            document.addEventListener('touchmove', onTouchMove, { passive: false });
            document.addEventListener('touchend', onTouchEnd, { passive: true });
            document.addEventListener('touchcancel', abandon, { passive: true });
        };

        const onTouchMove = (e: TouchEvent) => {
            const touch = e.touches[0];
            // A second finger means a pinch, and the zoom is not ours to swallow.
            if (e.touches.length !== 1 || !touch) return abandon();

            const phase = tracker.move(touch.clientX, touch.clientY);
            // A scroll or a swipe: the touch is no longer a pull, so stop watching it.
            if (phase === 'idle') return detach();
            if (phase !== 'pulling') return;
            // Own the gesture, so nothing rubber bands underneath the indicator and no
            // browser runs its own refresh alongside this one.
            if (e.cancelable) e.preventDefault();
            paint(tracker.distance, false);
        };

        const onTouchEnd = () => {
            detach();
            if (!tracker.end()) return paint(0, true);

            refreshingNow = true;
            setRefreshing(true);
            paint(TRIGGER_DISTANCE, true);
            // Let the spinner reach the screen before the document goes away.
            requestAnimationFrame(() => requestAnimationFrame(() => refreshRef.current()));
        };

        document.addEventListener('touchstart', onTouchStart, { passive: true });

        return () => {
            document.removeEventListener('touchstart', onTouchStart);
            detach();
        };
    }, []);

    return (
        // A screen reader owns the touchscreen, so this gesture is never its user's to make.
        <div className="pull-refresh-rail" aria-hidden="true">
            <div className={`pull-refresh-indicator${refreshing ? ' refreshing' : ''}`} ref={indicatorRef}>
                <RefreshCw size={18} className="pull-refresh-icon" />
            </div>
        </div>
    );
}
