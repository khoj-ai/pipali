// Individual automation card for automations page gallery

import React from 'react';
import { ChevronRight, Clock, Calendar, AlertCircle } from 'lucide-react';
import type { AutomationInfo, AutomationPendingConfirmation } from '../../types/automations';

interface AutomationCardProps {
    automation: AutomationInfo;
    pendingConfirmation?: AutomationPendingConfirmation;
    onClick?: () => void;
}

// Parse cron schedule to human-readable format
function formatSchedule(automation: AutomationInfo): string {
    if (!automation.triggerType || !automation.triggerConfig) {
        return 'Manual only';
    }

    if (automation.triggerType !== 'cron') {
        return 'File watch trigger';
    }

    const config = automation.triggerConfig;
    if (config.type !== 'cron') return 'Unknown schedule';

    const parts = config.schedule.split(' ');
    if (parts.length !== 5) return config.schedule;

    const minute = parts[0] ?? '0';
    const hour = parts[1] ?? '0';
    const dayOfMonth = parts[2] ?? '*';
    const dayOfWeek = parts[4] ?? '*';

    const hourNum = parseInt(hour, 10);
    const hour12 = hourNum % 12 || 12;
    const period = hourNum < 12 ? 'AM' : 'PM';
    const timeStr = `${hour12}:${minute.padStart(2, '0')} ${period}`;

    // Hourly
    if (hour === '*') {
        const suffix = ['th', 'st', 'nd', 'rd'];
        const minuteNum = parseInt(minute, 10);
        const s = suffix[(minuteNum % 10 <= 3 && Math.floor(minuteNum / 10) !== 1) ? minuteNum % 10 : 0];
        return `Every hour at ${minuteNum}${s} minute`;
    }

    // Daily
    if (dayOfMonth === '*' && dayOfWeek === '*') {
        return `Every day at ${timeStr}`;
    }

    // Weekly
    if (dayOfMonth === '*' && dayOfWeek !== '*') {
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayName = days[parseInt(dayOfWeek, 10)] ?? dayOfWeek;
        return `Every ${dayName} at ${timeStr}`;
    }

    // Monthly
    if (dayOfMonth !== '*') {
        const suffix = ['th', 'st', 'nd', 'rd'];
        const dom = parseInt(dayOfMonth, 10);
        const s = suffix[(dom % 10 <= 3 && Math.floor(dom / 10) !== 1) ? dom % 10 : 0];
        return `Every ${dom}${s} of the month at ${timeStr}`;
    }

    return config.schedule;
}

// Format next scheduled time
function formatNextRun(nextScheduledAt?: string): string | null {
    if (!nextScheduledAt) return null;

    const next = new Date(nextScheduledAt);
    const now = new Date();
    const diffMs = next.getTime() - now.getTime();

    if (diffMs < 0) return 'Overdue';

    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
        return `in ${diffDays} day${diffDays > 1 ? 's' : ''}`;
    }
    if (diffHours > 0) {
        return `in ${diffHours} hour${diffHours > 1 ? 's' : ''}`;
    }

    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    if (diffMinutes > 0) {
        return `in ${diffMinutes} minute${diffMinutes > 1 ? 's' : ''}`;
    }

    return 'soon';
}

export function AutomationCard({ automation, pendingConfirmation, onClick }: AutomationCardProps) {
    const isActive = automation.status === 'active';
    const isPaused = automation.status === 'paused';
    const hasConfirmation = !!pendingConfirmation;
    const hasSchedule = automation.triggerType && automation.triggerConfig;
    const schedule = formatSchedule(automation);
    const nextRun = hasSchedule ? formatNextRun(automation.nextScheduledAt) : null;

    // Determine card classes
    const cardClasses = [
        'automation-card',
        isPaused ? 'paused' : '',
        hasConfirmation ? 'awaiting-confirmation' : '',
    ].filter(Boolean).join(' ');

    return (
        <div
            className={cardClasses}
            onClick={onClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClick?.();
                }
            }}
        >
            <div className="automation-card-header">
                {hasConfirmation ? (
                    <div className="automation-status-badge awaiting-confirmation">
                        <AlertCircle size={10} />
                        needs approval
                    </div>
                ) : (
                    <div className={`automation-status-badge ${automation.status}`}>
                        {automation.status}
                    </div>
                )}
            </div>

            <h3 className="automation-card-title">{automation.name}</h3>

            {automation.description && (
                <p className="automation-card-description">{automation.description}</p>
            )}

            <p className="automation-card-prompt">{automation.prompt}</p>

            <div className="automation-card-footer">
                <div className="automation-schedule">
                    <Calendar size={12} />
                    <span>{schedule}</span>
                </div>
                {nextRun && isActive && !hasConfirmation && (
                    <div className="automation-next-run">
                        <Clock size={12} />
                        <span>Next: {nextRun}</span>
                    </div>
                )}
                <ChevronRight size={14} className="automation-chevron" />
            </div>
        </div>
    );
}
