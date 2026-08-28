// A stopwatch for a run: counts up while the agent works, then holds the total.

import { useEffect, useState } from 'react';
import { formatRunDuration } from '../../utils/formatting';

interface RunTimerProps {
    startedAt: string;
    endedAt?: string;
    isRunning?: boolean;
}

export function RunTimer({ startedAt, endedAt, isRunning }: RunTimerProps) {
    // Held here rather than by the message, so a tick redraws this alone.
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!isRunning) return;
        setNow(Date.now());
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(tick);
    }, [isRunning]);

    const start = Date.parse(startedAt);
    // A run still going is measured against the clock; a finished one against its end.
    const end = isRunning ? now : Date.parse(endedAt ?? '');
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;

    return <span className="run-timer">{formatRunDuration(end - start)}</span>;
}
