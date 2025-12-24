// Modal for viewing, editing, and deleting an automation

import React, { useState, useEffect } from 'react';
import { X, Loader2, Trash2, Play, Pause, Calendar, Clock, Pencil, Save, AlertCircle, Send, MessageSquare, Zap, ChevronDown, ChevronRight } from 'lucide-react';
import type { AutomationInfo, FrequencyType, DayOfWeek, AutomationPendingConfirmation } from '../../types/automations';
import { DAYS_OF_WEEK, TIME_OPTIONS, DAY_OF_MONTH_OPTIONS, MINUTE_OPTIONS } from '../../types/automations';
import { DiffView } from '../tool-views/DiffView';
import { parseCommandMessage, shortenHomePath } from '../../utils/parseCommand';

interface AutomationDetailModalProps {
    automation: AutomationInfo;
    pendingConfirmation?: AutomationPendingConfirmation;
    onClose: () => void;
    onUpdated: () => void;
    onDeleted: () => void;
    onConfirmationRespond?: (confirmationId: string, optionId: string, guidance?: string) => void;
    onViewConversation?: (conversationId: string) => void;
}

const FREQUENCY_OPTIONS: { value: FrequencyType; label: string }[] = [
    { value: 'hour', label: 'Hour' },
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
];

// Parse cron schedule to UI state
function parseCronSchedule(schedule: string): {
    frequency: FrequencyType;
    dayOfWeek: DayOfWeek;
    dayOfMonth: number;
    minuteOfHour: number;
    time: string;
} {
    const parts = schedule.split(' ');
    const minute = parts[0] ?? '0';
    const hour = parts[1] ?? '12';
    const dayOfMonth = parts[2] ?? '*';
    const dayOfWeek = parts[4] ?? '*';

    const minuteNum = parseInt(minute, 10);
    const hourNum = parseInt(hour, 10);
    const timeFormatted = `${hourNum}:${minute.padStart(2, '0')}`;

    let frequency: FrequencyType = 'day';
    let parsedDayOfWeek: DayOfWeek = 'monday';
    let parsedDayOfMonth = 1;
    let parsedMinuteOfHour = minuteNum;

    // Check for hourly (hour field is *)
    if (hour === '*') {
        frequency = 'hour';
    } else if (dayOfMonth !== '*') {
        frequency = 'month';
        parsedDayOfMonth = parseInt(dayOfMonth, 10);
    } else if (dayOfWeek !== '*') {
        frequency = 'week';
        const dayIndex = parseInt(dayOfWeek, 10);
        parsedDayOfWeek = DAYS_OF_WEEK[dayIndex]?.value ?? 'monday';
    }

    return {
        frequency,
        dayOfWeek: parsedDayOfWeek,
        dayOfMonth: parsedDayOfMonth,
        minuteOfHour: parsedMinuteOfHour,
        time: timeFormatted,
    };
}

// Build cron schedule from UI state
function buildCronSchedule(
    frequency: FrequencyType,
    dayOfWeek: DayOfWeek,
    dayOfMonth: number,
    minuteOfHour: number,
    time: string
): string {
    const [hour, timeMinute] = time.split(':').map(Number);

    switch (frequency) {
        case 'hour':
            return `${minuteOfHour} * * * *`;
        case 'day':
            return `${timeMinute} ${hour} * * *`;
        case 'week':
            const weekdayIndex = DAYS_OF_WEEK.findIndex(d => d.value === dayOfWeek);
            return `${timeMinute} ${hour} * * ${weekdayIndex}`;
        case 'month':
            return `${timeMinute} ${hour} ${dayOfMonth} * *`;
        default:
            return `${timeMinute} ${hour} * * *`;
    }
}

// Format schedule for display
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

    // Handle hourly schedule
    if (hour === '*') {
        return `Every hour at :${minute.padStart(2, '0')}`;
    }

    const hourNum = parseInt(hour, 10);
    const hour12 = hourNum % 12 || 12;
    const period = hourNum < 12 ? 'AM' : 'PM';
    const timeStr = `${hour12}:${minute.padStart(2, '0')} ${period}`;

    if (dayOfMonth === '*' && dayOfWeek === '*') {
        return `Every day at ${timeStr}`;
    }

    if (dayOfMonth === '*' && dayOfWeek !== '*') {
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayName = days[parseInt(dayOfWeek, 10)] ?? dayOfWeek;
        return `Every ${dayName} at ${timeStr}`;
    }

    if (dayOfMonth !== '*') {
        const suffix = ['th', 'st', 'nd', 'rd'];
        const dom = parseInt(dayOfMonth, 10);
        const s = suffix[(dom % 10 <= 3 && Math.floor(dom / 10) !== 1) ? dom % 10 : 0];
        return `Every ${dom}${s} of the month at ${timeStr}`;
    }

    return config.schedule;
}

export function AutomationDetailModal({
    automation,
    pendingConfirmation,
    onClose,
    onUpdated,
    onDeleted,
    onConfirmationRespond,
    onViewConversation,
}: AutomationDetailModalProps) {
    const [isEditing, setIsEditing] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isToggling, setIsToggling] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isTriggering, setIsTriggering] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [triggerSuccess, setTriggerSuccess] = useState(false);

    // Confirmation guidance state
    const [showGuidanceInput, setShowGuidanceInput] = useState(false);
    const [guidanceText, setGuidanceText] = useState('');

    // Edit form state
    const initialParsed = automation.triggerConfig?.type === 'cron'
        ? parseCronSchedule(automation.triggerConfig.schedule)
        : { frequency: 'day' as FrequencyType, dayOfWeek: 'monday' as DayOfWeek, dayOfMonth: 1, minuteOfHour: 0, time: '12:00' };

    const [frequency, setFrequency] = useState<FrequencyType>(initialParsed.frequency);
    const [dayOfWeek, setDayOfWeek] = useState<DayOfWeek>(initialParsed.dayOfWeek);
    const [dayOfMonth, setDayOfMonth] = useState(initialParsed.dayOfMonth);
    const [minuteOfHour, setMinuteOfHour] = useState(initialParsed.minuteOfHour);
    const [time, setTime] = useState(initialParsed.time);
    const [instructions, setInstructions] = useState(automation.prompt);

    // Schedule toggle for edit mode (initialized from automation's current state)
    const [editHasSchedule, setEditHasSchedule] = useState(!!automation.triggerType && !!automation.triggerConfig);

    const isActive = automation.status === 'active';
    const hasSchedule = automation.triggerType && automation.triggerConfig;

    const handleToggleStatus = async () => {
        setIsToggling(true);
        setError(null);

        try {
            const endpoint = isActive
                ? `/api/automations/${automation.id}/pause`
                : `/api/automations/${automation.id}/resume`;

            const res = await fetch(endpoint, { method: 'POST' });
            if (res.ok) {
                onUpdated();
            } else {
                const data = await res.json();
                setError(data.error || 'Failed to update status');
            }
        } catch (e) {
            setError('Failed to update status');
        } finally {
            setIsToggling(false);
        }
    };

    const handleTrigger = async () => {
        setIsTriggering(true);
        setError(null);
        setTriggerSuccess(false);

        try {
            const res = await fetch(`/api/automations/${automation.id}/trigger`, {
                method: 'POST',
            });

            if (res.ok) {
                setTriggerSuccess(true);
                onUpdated();
                // Clear success message after 3 seconds
                setTimeout(() => setTriggerSuccess(false), 3000);
            } else {
                const data = await res.json();
                setError(data.error || 'Failed to trigger automation');
            }
        } catch (e) {
            setError('Failed to trigger automation');
        } finally {
            setIsTriggering(false);
        }
    };

    // Generate automation name from instructions (same as CreateAutomationModal)
    const generateName = (text: string): string => {
        const trimmed = text.trim();
        if (trimmed.length <= 50) return trimmed;
        return trimmed.slice(0, 47) + '...';
    };

    const handleSave = async () => {
        setIsSaving(true);
        setError(null);

        try {
            // Build request body - trigger is optional
            const body: Record<string, unknown> = {
                name: generateName(instructions),
                prompt: instructions,
            };

            // Only include trigger config if schedule is enabled
            if (editHasSchedule) {
                const schedule = buildCronSchedule(frequency, dayOfWeek, dayOfMonth, minuteOfHour, time);
                body.triggerType = 'cron';
                body.triggerConfig = {
                    type: 'cron',
                    schedule,
                };
            } else {
                // Explicitly set to null to remove schedule
                body.triggerType = null;
                body.triggerConfig = null;
            }

            const res = await fetch(`/api/automations/${automation.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (res.ok) {
                setIsEditing(false);
                onUpdated();
            } else {
                const data = await res.json();
                setError(data.error || 'Failed to save changes');
            }
        } catch (e) {
            setError('Failed to save changes');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async () => {
        setIsDeleting(true);
        setError(null);

        try {
            const res = await fetch(`/api/automations/${automation.id}`, {
                method: 'DELETE',
            });

            if (res.ok) {
                onDeleted();
            } else {
                const data = await res.json();
                setError(data.error || 'Failed to delete automation');
                setShowDeleteConfirm(false);
            }
        } catch (e) {
            setError('Failed to delete automation');
            setShowDeleteConfirm(false);
        } finally {
            setIsDeleting(false);
        }
    };

    const handleBackdropClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    };

    // Handle escape key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (showDeleteConfirm) {
                    setShowDeleteConfirm(false);
                } else if (isEditing) {
                    setIsEditing(false);
                } else {
                    onClose();
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose, showDeleteConfirm, isEditing]);

    return (
        <div className="modal-backdrop" onClick={handleBackdropClick}>
            <div className="modal automation-detail-modal">
                <div className="modal-header">
                    <div className="automation-detail-header-content">
                        <h2>{automation.name}</h2>
                        {pendingConfirmation ? (
                            <span className="automation-status-badge awaiting-confirmation">
                                <AlertCircle size={10} />
                                needs approval
                            </span>
                        ) : (
                            <span className={`automation-status-badge ${automation.status}`}>
                                {automation.status}
                            </span>
                        )}
                    </div>
                    <button onClick={onClose} className="modal-close">
                        <X size={18} />
                    </button>
                </div>

                <div className="automation-detail-content">
                    {/* Pending confirmation section - shown at top when there's a confirmation */}
                    {pendingConfirmation && onConfirmationRespond && (
                        <div className="automation-confirmation-section">
                            <div className="confirmation-header">
                                <AlertCircle size={16} />
                                <h3>Action Required</h3>
                            </div>
                            <div className="confirmation-content">
                                <p className="confirmation-title">{pendingConfirmation.request.title}</p>
                                {(() => {
                                    const commandInfo = pendingConfirmation.request.message
                                        ? parseCommandMessage(pendingConfirmation.request.message)
                                        : null;
                                    return (
                                        <>
                                            {commandInfo?.reason && (
                                                <p className="confirmation-reason">{commandInfo.reason}</p>
                                            )}
                                            {commandInfo?.command && (
                                                <div className="confirmation-command-section">
                                                    <div className="confirmation-command-header">
                                                        <span className="confirmation-command-label">Command</span>
                                                        {commandInfo.workdir && (
                                                            <code className="confirmation-workdir">
                                                                in {shortenHomePath(commandInfo.workdir)}
                                                            </code>
                                                        )}
                                                    </div>
                                                    <pre className="confirmation-command-code">
                                                        <code>{commandInfo.command}</code>
                                                    </pre>
                                                </div>
                                            )}
                                            {!commandInfo && pendingConfirmation.request.message && (
                                                <p className="confirmation-message">{pendingConfirmation.request.message}</p>
                                            )}
                                        </>
                                    );
                                })()}
                                {pendingConfirmation.request.diff && (
                                    <DiffView diff={pendingConfirmation.request.diff} />
                                )}
                            </div>
                            {showGuidanceInput ? (
                                <div className="confirmation-guidance-section">
                                    <textarea
                                        className="confirmation-guidance-input"
                                        placeholder="Provide guidance for a different approach..."
                                        value={guidanceText}
                                        onChange={(e) => setGuidanceText(e.target.value)}
                                        autoFocus
                                        rows={3}
                                    />
                                    <div className="confirmation-guidance-actions">
                                        <button
                                            className="btn-confirmation secondary"
                                            onClick={() => {
                                                setShowGuidanceInput(false);
                                                setGuidanceText('');
                                            }}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            className="btn-confirmation primary"
                                            onClick={() => onConfirmationRespond(pendingConfirmation.id, 'guidance', guidanceText)}
                                            disabled={!guidanceText.trim()}
                                        >
                                            <Send size={14} />
                                            Send Guidance
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div className="confirmation-actions">
                                    {pendingConfirmation.request.options.map((option) => (
                                        <button
                                            key={option.id}
                                            className={`btn-confirmation ${option.style === 'primary' ? 'primary' : option.style === 'danger' ? 'danger' : option.style === 'warning' ? 'warning' : 'secondary'}`}
                                            onClick={() => {
                                                if (option.id === 'guidance') {
                                                    setShowGuidanceInput(true);
                                                } else {
                                                    onConfirmationRespond(pendingConfirmation.id, option.id);
                                                }
                                            }}
                                            title={option.description}
                                        >
                                            {option.label}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {!isEditing ? (
                        // View mode
                        <>
                            <div className="automation-detail-section">
                                <h3>Instructions</h3>
                                <p className="automation-detail-instructions">{automation.prompt}</p>
                            </div>

                            <div className="automation-detail-section">
                                <h3>Schedule</h3>
                                <div className="automation-detail-schedule">
                                    <Calendar size={16} />
                                    <span>{formatSchedule(automation)}</span>
                                </div>
                                {hasSchedule && automation.nextScheduledAt && isActive && !pendingConfirmation && (
                                    <div className="automation-detail-next-run">
                                        <Clock size={14} />
                                        <span>Next run: {new Date(automation.nextScheduledAt).toLocaleString()}</span>
                                    </div>
                                )}
                            </div>

                            {automation.lastExecutedAt && (
                                <div className="automation-detail-section">
                                    <h3>Last Run</h3>
                                    <p className="automation-detail-meta">
                                        {new Date(automation.lastExecutedAt).toLocaleString()}
                                    </p>
                                </div>
                            )}
                        </>
                    ) : (
                        // Edit mode
                        <>
                            <div className="automation-detail-section">
                                <h3>Instructions</h3>
                                <textarea
                                    value={instructions}
                                    onChange={(e) => setInstructions(e.target.value)}
                                    rows={4}
                                    className="instructions-textarea"
                                />
                            </div>

                            {/* Schedule Section - Optional, collapsible */}
                            <div className="form-section schedule-section">
                                <button
                                    type="button"
                                    className="schedule-toggle"
                                    onClick={() => setEditHasSchedule(!editHasSchedule)}
                                >
                                    {editHasSchedule ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                    <span>Schedule</span>
                                    <span className="schedule-toggle-hint">
                                        {editHasSchedule ? '' : '(Optional - run on a recurring schedule)'}
                                    </span>
                                </button>

                                {editHasSchedule && (
                                    <div className="schedule-content">
                                        <div className="frequency-selector">
                                            <div className="frequency-row">
                                                <Calendar size={16} className="frequency-icon" />
                                                <span className="frequency-label">Every</span>
                                                <select
                                                    value={frequency}
                                                    onChange={(e) => setFrequency(e.target.value as FrequencyType)}
                                                    className="frequency-select"
                                                >
                                                    {FREQUENCY_OPTIONS.map(opt => (
                                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                                    ))}
                                                </select>
                                            </div>

                                            {/* Day of Week selector for weekly */}
                                            {frequency === 'week' && (
                                                <div className="frequency-detail">
                                                    <p className="frequency-detail-label">Every week, on which day should the automation run?</p>
                                                    <div className="frequency-row">
                                                        <Calendar size={16} className="frequency-icon" />
                                                        <span className="frequency-label">On</span>
                                                        <select
                                                            value={dayOfWeek}
                                                            onChange={(e) => setDayOfWeek(e.target.value as DayOfWeek)}
                                                            className="frequency-select"
                                                        >
                                                            {DAYS_OF_WEEK.map(day => (
                                                                <option key={day.value} value={day.value}>{day.label}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                </div>
                                            )}

                                            {/* Day of Month selector for monthly */}
                                            {frequency === 'month' && (
                                                <div className="frequency-detail">
                                                    <p className="frequency-detail-label">Every month, on which day should the automation run?</p>
                                                    <div className="frequency-row">
                                                        <Calendar size={16} className="frequency-icon" />
                                                        <span className="frequency-label">On the</span>
                                                        <select
                                                            value={dayOfMonth}
                                                            onChange={(e) => setDayOfMonth(Number(e.target.value))}
                                                            className="frequency-select"
                                                        >
                                                            {DAY_OF_MONTH_OPTIONS.map(day => (
                                                                <option key={day.value} value={day.value}>{day.label}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                </div>
                                            )}

                                            {/* Minute selector for hourly */}
                                            {frequency === 'hour' && (
                                                <div className="frequency-detail">
                                                    <p className="frequency-detail-label">Every hour, at which minute should the automation run?</p>
                                                    <div className="frequency-row">
                                                        <Clock size={16} className="frequency-icon" />
                                                        <span className="frequency-label">At minute</span>
                                                        <select
                                                            value={minuteOfHour}
                                                            onChange={(e) => setMinuteOfHour(Number(e.target.value))}
                                                            className="frequency-select"
                                                        >
                                                            {MINUTE_OPTIONS.map(opt => (
                                                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        {/* Time Section - only show for non-hourly frequencies */}
                                        {frequency !== 'hour' && (
                                            <div className="time-selector">
                                                <p className="frequency-detail-label">At what time should the automation run?</p>
                                                <div className="frequency-row">
                                                    <Clock size={16} className="frequency-icon" />
                                                    <span className="frequency-label">At</span>
                                                    <select
                                                        value={time}
                                                        onChange={(e) => setTime(e.target.value)}
                                                        className="frequency-select time-select"
                                                    >
                                                        {TIME_OPTIONS.map(opt => (
                                                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </>
                    )}

                    {error && <div className="form-error">{error}</div>}
                </div>

                <div className="modal-actions automation-detail-actions">
                    {showDeleteConfirm ? (
                        <>
                            <span className="delete-confirm-text">Delete this automation?</span>
                            <button
                                type="button"
                                onClick={() => setShowDeleteConfirm(false)}
                                className="btn-secondary"
                                disabled={isDeleting}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleDelete}
                                className="btn-danger"
                                disabled={isDeleting}
                            >
                                {isDeleting ? (
                                    <>
                                        <Loader2 size={16} className="spinning" />
                                        <span>Deleting...</span>
                                    </>
                                ) : (
                                    <>
                                        <Trash2 size={16} />
                                        <span>Delete</span>
                                    </>
                                )}
                            </button>
                        </>
                    ) : isEditing ? (
                        <>
                            <button
                                type="button"
                                onClick={() => setShowDeleteConfirm(true)}
                                className="btn-danger-outline"
                            >
                                <Trash2 size={16} />
                            </button>
                            <div className="action-spacer" />
                            <button
                                type="button"
                                onClick={() => setIsEditing(false)}
                                className="btn-secondary"
                                disabled={isSaving}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleSave}
                                className="btn-primary btn-save"
                                disabled={isSaving || !instructions.trim()}
                            >
                                {isSaving ? (
                                    <>
                                        <Loader2 size={16} className="spinning" />
                                        <span>Saving...</span>
                                    </>
                                ) : (
                                    <>
                                        <Save size={16} />
                                        <span>Save</span>
                                    </>
                                )}
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                type="button"
                                onClick={() => setShowDeleteConfirm(true)}
                                className="btn-danger-outline"
                            >
                                <Trash2 size={16} />
                            </button>
                            <div className="action-spacer" />
                            {automation.conversationId && onViewConversation && (
                                <button
                                    type="button"
                                    onClick={() => onViewConversation(automation.conversationId!)}
                                    className="btn-secondary"
                                >
                                    <MessageSquare size={16} />
                                    <span>View History</span>
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={handleToggleStatus}
                                className={`btn-secondary ${isActive ? 'btn-pause' : 'btn-play'}`}
                                disabled={isToggling}
                            >
                                {isToggling ? (
                                    <Loader2 size={16} className="spinning" />
                                ) : isActive ? (
                                    <>
                                        <Pause size={16} />
                                        <span>Pause</span>
                                    </>
                                ) : (
                                    <>
                                        <Play size={16} />
                                        <span>Resume</span>
                                    </>
                                )}
                            </button>
                            <button
                                type="button"
                                onClick={() => setIsEditing(true)}
                                className="btn-secondary"
                            >
                                <Pencil size={16} />
                                <span>Edit</span>
                            </button>
                            <button
                                type="button"
                                onClick={handleTrigger}
                                className="btn-primary btn-run-now"
                                disabled={isTriggering || pendingConfirmation !== undefined}
                                title={pendingConfirmation ? 'Resolve pending confirmation first' : 'Run automation now'}
                            >
                                {isTriggering ? (
                                    <>
                                        <Loader2 size={16} className="spinning" />
                                        <span>Running...</span>
                                    </>
                                ) : triggerSuccess ? (
                                    <>
                                        <Zap size={16} />
                                        <span>Started!</span>
                                    </>
                                ) : (
                                    <>
                                        <Zap size={16} />
                                        <span>Run Now</span>
                                    </>
                                )}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
