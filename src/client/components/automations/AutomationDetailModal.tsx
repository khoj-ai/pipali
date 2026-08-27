// Modal for viewing, editing, and deleting an automation

import React, { useState, useEffect } from 'react';
import { X, Loader2, Trash2, Calendar, Clock, Pencil, Save, AlertCircle, Send, MessageSquare, Zap, ChevronDown, ChevronRight, Bot } from 'lucide-react';
import type { AutomationInfo, FrequencyType, DayOfWeek, AutomationPendingConfirmation } from '../../types/automations';
import { DAYS_OF_WEEK, TIME_OPTIONS, DAY_OF_MONTH_OPTIONS, MINUTE_OPTIONS } from '../../types/automations';
import { DiffView } from '../tool-views/DiffView';
import { shortenHomePath } from '../../utils/formatting';
import { apiFetch } from '../../utils/api';
import { useTranslation } from 'react-i18next';
import { useModels } from '../../hooks/useModels';
import type { TFunction } from 'i18next';
import { formatTime, formatDayOfWeek, formatDayOfMonth } from './utils';

interface AutomationDetailModalProps {
    automation: AutomationInfo;
    pendingConfirmation?: AutomationPendingConfirmation;
    onClose: () => void;
    onUpdated: () => void;
    onDeleted: () => void;
    onConfirmationRespond?: (confirmationId: string, optionId: string, guidance?: string) => void;
    onViewConversation?: (conversationId: string) => void;
}


// Parse cron schedule to UI state
function parseCronSchedule(schedule: string): {
    frequency: FrequencyType;
    daysOfWeek: DayOfWeek[];
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
    let parsedDaysOfWeek: DayOfWeek[] = ['monday'];
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
        // Parse comma-separated day indices (e.g., "1,3,5")
        parsedDaysOfWeek = dayOfWeek.split(',').map(d => {
            const dayIndex = parseInt(d.trim(), 10);
            return DAYS_OF_WEEK[dayIndex]?.value ?? 'monday';
        });
    }

    return {
        frequency,
        daysOfWeek: parsedDaysOfWeek,
        dayOfMonth: parsedDayOfMonth,
        minuteOfHour: parsedMinuteOfHour,
        time: timeFormatted,
    };
}

// Build cron schedule from UI state
function buildCronSchedule(
    frequency: FrequencyType,
    daysOfWeek: DayOfWeek[],
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
            const weekdayIndices = daysOfWeek
                .map(d => DAYS_OF_WEEK.findIndex(day => day.value === d))
                .sort((a, b) => a - b)
                .join(',');
            return `${timeMinute} ${hour} * * ${weekdayIndices}`;
        case 'month':
            return `${timeMinute} ${hour} ${dayOfMonth} * *`;
        default:
            return `${timeMinute} ${hour} * * *`;
    }
}

// Format schedule for display
function formatSchedule(automation: AutomationInfo, t: TFunction): string {
    if (!automation.triggerType || !automation.triggerConfig) {
        return t('automations.manualOnly');
    }

    if (automation.triggerType !== 'cron') {
        return t('automations.fileWatchTrigger');
    }

    const config = automation.triggerConfig;
    if (config.type !== 'cron') return t('automations.unknownSchedule');

    const parts = config.schedule.split(' ');
    if (parts.length !== 5) return config.schedule;

    const minute = parts[0] ?? '0';
    const hour = parts[1] ?? '0';
    const dayOfMonth = parts[2] ?? '*';
    const dayOfWeek = parts[4] ?? '*';

    if (hour === '*') {
        return t('automations.everyHourAt', { minute: minute.padStart(2, '0') });
    }

    const hourNum = parseInt(hour, 10);
    const timeStr = formatTime(hourNum, minute, t);

    if (dayOfMonth === '*' && dayOfWeek === '*') {
        return t('automations.everyDayAt', { time: timeStr });
    }
    if (dayOfMonth === '*' && dayOfWeek !== '*') {
        return t('automations.everyDayOfWeekAt', { day: formatDayOfWeek(dayOfWeek, t), time: timeStr });
    }
    if (dayOfMonth !== '*') {
        return t('automations.everyDayOfMonthAt', { day: formatDayOfMonth(parseInt(dayOfMonth, 10)), time: timeStr });
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
    const { t } = useTranslation();
    const onTheLabel = t('automations.onThe');
    const atLabel = t('automations.at');

    const FREQUENCY_OPTIONS: { value: FrequencyType; label: string }[] = [
        { value: 'hour', label: t('automations.frequencyHour') },
        { value: 'day', label: t('automations.frequencyDay') },
        { value: 'week', label: t('automations.frequencyWeek') },
        { value: 'month', label: t('automations.frequencyMonth') },
    ];

    const [isEditing, setIsEditing] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isTriggering, setIsTriggering] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Confirmation guidance state
    const [showGuidanceInput, setShowGuidanceInput] = useState(false);
    const [guidanceText, setGuidanceText] = useState('');

    // Edit form state
    const initialParsed = automation.triggerConfig?.type === 'cron'
        ? parseCronSchedule(automation.triggerConfig.schedule)
        : { frequency: 'day' as FrequencyType, daysOfWeek: ['monday'] as DayOfWeek[], dayOfMonth: 1, minuteOfHour: 0, time: '12:00' };

    const [frequency, setFrequency] = useState<FrequencyType>(initialParsed.frequency);
    const [daysOfWeek, setDaysOfWeek] = useState<DayOfWeek[]>(initialParsed.daysOfWeek);
    const [dayOfMonth, setDayOfMonth] = useState(initialParsed.dayOfMonth);
    const [minuteOfHour, setMinuteOfHour] = useState(initialParsed.minuteOfHour);
    const [time, setTime] = useState(initialParsed.time);
    const [name, setName] = useState(automation.name);
    const [instructions, setInstructions] = useState(automation.prompt);
    const [chatModelId, setChatModelId] = useState<number | null>(automation.chatModelId ?? null);

    // Schedule toggle for edit mode (initialized from automation's current state)
    const [editHasSchedule, setEditHasSchedule] = useState(!!automation.triggerType && !!automation.triggerConfig);

    const { models, defaultModel } = useModels();
    const defaultModelName = defaultModel?.friendlyName || defaultModel?.name;
    const defaultModelLabel = defaultModelName
        ? t('automations.defaultModel', { model: defaultModelName })
        : t('automations.defaultModelUnknown');
    const pinnedModel = models.find(model => model.id === automation.chatModelId);
    const modelLabel = pinnedModel ? pinnedModel.friendlyName || pinnedModel.name : defaultModelLabel;

    const isActive = automation.status === 'active';
    const hasSchedule = automation.triggerType && automation.triggerConfig;

    const handleTrigger = async () => {
        setIsTriggering(true);
        setError(null);

        try {
            const res = await apiFetch(`/api/automations/${automation.id}/trigger`, {
                method: 'POST',
            });
            const data = await res.json();

            if (res.ok) {
                if (onViewConversation) {
                    onViewConversation(data.conversationId);
                }
            } else {
                setError(typeof data.error === 'string' ? data.error : t('automations.failedToTrigger'));
            }
        } catch (e) {
            setError(t('automations.failedToTrigger'));
        } finally {
            setIsTriggering(false);
        }
    };

    const handleSave = async () => {
        setIsSaving(true);
        setError(null);

        try {
            // Build request body - trigger is optional
            const body: Record<string, unknown> = {
                name: name.trim().slice(0, 100),
                prompt: instructions,
                chatModelId,
            };

            // Only include trigger config if schedule is enabled
            if (editHasSchedule) {
                const schedule = buildCronSchedule(frequency, daysOfWeek, dayOfMonth, minuteOfHour, time);
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

            const res = await apiFetch(`/api/automations/${automation.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (res.ok) {
                setIsEditing(false);
                onUpdated();
            } else {
                const data = await res.json();
                setError(typeof data.error === 'string' ? data.error : t('automations.failedToSave'));
            }
        } catch (e) {
            setError(t('automations.failedToSave'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async () => {
        setIsDeleting(true);
        setError(null);

        try {
            const res = await apiFetch(`/api/automations/${automation.id}`, {
                method: 'DELETE',
            });

            if (res.ok) {
                onDeleted();
            } else {
                const data = await res.json();
                setError(typeof data.error === 'string' ? data.error : t('automations.failedToDelete'));
                setShowDeleteConfirm(false);
            }
        } catch (e) {
            setError(t('automations.failedToDelete'));
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
                                {t('automations.needsApproval')}
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
                                <h3>{t('automations.actionRequired')}</h3>
                            </div>
                            <div className="confirmation-content">
                                <p className="confirmation-title">{pendingConfirmation.request.title}</p>
                                {(() => {
                                    const commandInfo = pendingConfirmation.request.context?.commandInfo;
                                    return (
                                        <>
                                            {commandInfo?.reason && (
                                                <p className="confirmation-reason">{commandInfo.reason}</p>
                                            )}
                                            {commandInfo?.command && (
                                                <div className="confirmation-command-section">
                                                    <div className="confirmation-command-header">
                                                        <span className="confirmation-command-label">{t('automations.command')}</span>
                                                        {commandInfo.workdir && (
                                                            <code className="confirmation-workdir">
                                                                {t('automations.in')} {shortenHomePath(commandInfo.workdir)}
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
                                        placeholder={t('automations.guidancePlaceholder')}
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
                                            {t('common.cancel')}
                                        </button>
                                        <button
                                            className="btn-confirmation primary"
                                            onClick={() => onConfirmationRespond(pendingConfirmation.id, 'guidance', guidanceText)}
                                            disabled={!guidanceText.trim()}
                                        >
                                            <Send size={14} />
                                            {t('automations.sendGuidance')}
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
                                <h3>{t('automations.instructions')}</h3>
                                <p className="automation-detail-instructions">{automation.prompt}</p>
                            </div>

                            <div className="automation-detail-section">
                                <h3>{t('automations.model')}</h3>
                                <div className="automation-detail-row automation-detail-model">
                                    <Bot size={16} />
                                    <span>{modelLabel}</span>
                                </div>
                            </div>

                            <div className="automation-detail-section">
                                <h3>{t('automations.schedule')}</h3>
                                <div className="automation-detail-row automation-detail-schedule">
                                    <Calendar size={16} />
                                    <span>{formatSchedule(automation, t)}</span>
                                </div>
                                {hasSchedule && automation.nextScheduledAt && isActive && !pendingConfirmation && (
                                    <div className="automation-detail-next-run">
                                        <Clock size={14} />
                                        <span>{t('automations.nextRun', { time: new Date(automation.nextScheduledAt).toLocaleString() })}</span>
                                    </div>
                                )}
                            </div>

                            {automation.lastExecutedAt && (
                                <div className="automation-detail-section">
                                    <h3>{t('automations.lastRun')}</h3>
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
                                <h3>{t('automations.name')}</h3>
                                <input
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    className="automation-name-input"
                                    maxLength={100}
                                />
                            </div>

                            <div className="automation-detail-section">
                                <h3>{t('automations.instructions')}</h3>
                                <textarea
                                    value={instructions}
                                    onChange={(e) => setInstructions(e.target.value)}
                                    rows={4}
                                    className="instructions-textarea"
                                />
                            </div>

                            <div className="automation-detail-section">
                                <h3>{t('automations.model')}</h3>
                                <select
                                    value={chatModelId ?? ''}
                                    onChange={(e) => setChatModelId(e.target.value ? Number(e.target.value) : null)}
                                    className="automation-model-select"
                                >
                                    <option value="">{defaultModelLabel}</option>
                                    {models.map(model => (
                                        <option key={model.id} value={model.id}>
                                            {model.friendlyName || model.name}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* Schedule Section - Optional, collapsible */}
                            <div className="form-section schedule-section">
                                <button
                                    type="button"
                                    className="schedule-toggle"
                                    onClick={() => setEditHasSchedule(!editHasSchedule)}
                                >
                                    {editHasSchedule ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                    <span>{t('automations.schedule')}</span>
                                    <span className="schedule-toggle-hint">
                                        {editHasSchedule ? '' : t('automations.scheduleHintInline')}
                                    </span>
                                </button>

                                {editHasSchedule && (
                                    <div className="schedule-content">
                                        <div className="frequency-selector">
                                            <div className="frequency-row">
                                                <Calendar size={16} className="frequency-icon" />
                                                <span className="frequency-label">{t('automations.every')}</span>
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
                                                    <p className="frequency-detail-label">{t('automations.weekDayPromptDetail')}</p>
                                                    <div className="day-toggle-group">
                                                        {DAYS_OF_WEEK.map(day => (
                                                            <button
                                                                key={day.value}
                                                                type="button"
                                                                className={`day-toggle${daysOfWeek.includes(day.value) ? ' active' : ''}`}
                                                                onClick={() => {
                                                                    setDaysOfWeek(prev => {
                                                                        if (prev.includes(day.value)) {
                                                                            if (prev.length === 1) return prev;
                                                                            return prev.filter(d => d !== day.value);
                                                                        }
                                                                        return [...prev, day.value];
                                                                    });
                                                                }}
                                                            >
                                                                {day.label.slice(0, 3)}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            {/* Day of Month selector for monthly */}
                                            {frequency === 'month' && (
                                                <div className="frequency-detail">
                                                    <p className="frequency-detail-label">{t('automations.monthDayPromptDetail')}</p>
                                                    <div className="frequency-row">
                                                        <Calendar size={16} className="frequency-icon" />
                                                        {onTheLabel ? <span className="frequency-label">{onTheLabel}</span> : null}
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
                                                    <p className="frequency-detail-label">{t('automations.minutePromptDetail')}</p>
                                                    <div className="frequency-row">
                                                        <Clock size={16} className="frequency-icon" />
                                                        <span className="frequency-label">{t('automations.atMinute')}</span>
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
                                                <p className="frequency-detail-label">{t('automations.timePromptDetail')}</p>
                                                <div className="frequency-row">
                                                    <Clock size={16} className="frequency-icon" />
                                                    {atLabel ? <span className="frequency-label">{atLabel}</span> : null}
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
                            <span className="delete-confirm-text">{t('automations.deleteRoutineConfirm')}</span>
                            <button
                                type="button"
                                onClick={() => setShowDeleteConfirm(false)}
                                className="btn-secondary"
                                disabled={isDeleting}
                            >
                                {t('common.cancel')}
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
                                        <span>{t('automations.deleting')}</span>
                                    </>
                                ) : (
                                    <>
                                        <Trash2 size={16} />
                                        <span>{t('common.delete')}</span>
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
                                {t('common.cancel')}
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
                                        <span>{t('automations.saving')}</span>
                                    </>
                                ) : (
                                    <>
                                        <Save size={16} />
                                        <span>{t('automations.save')}</span>
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
                                    <span>{t('automations.view')}</span>
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => setIsEditing(true)}
                                className="btn-secondary"
                            >
                                <Pencil size={16} />
                                <span>{t('automations.edit')}</span>
                            </button>
                            <button
                                type="button"
                                onClick={handleTrigger}
                                className="btn-primary btn-run-now"
                                disabled={isTriggering || pendingConfirmation !== undefined}
                                title={pendingConfirmation ? t('automations.resolveConfirmationFirst') : t('automations.runRoutineNow')}
                            >
                                {isTriggering ? (
                                    <>
                                        <Loader2 size={16} className="spinning" />
                                        <span>{t('automations.running')}</span>
                                    </>
                                ) : (
                                    <>
                                        <Zap size={16} />
                                        <span>{t('automations.runNow')}</span>
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
