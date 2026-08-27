// Modal for creating a new automation

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2, Calendar, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import type { FrequencyType, DayOfWeek } from '../../types/automations';
import { DAYS_OF_WEEK, TIME_OPTIONS, DAY_OF_MONTH_OPTIONS, MINUTE_OPTIONS } from '../../types/automations';
import { apiFetch } from '../../utils/api';
import { useModels } from '../../hooks/useModels';

interface CreateAutomationModalProps {
    onClose: () => void;
    onCreated: () => void;
}

export function CreateAutomationModal({ onClose, onCreated }: CreateAutomationModalProps) {
    const { t } = useTranslation();
    const onTheLabel = t('automations.onThe');
    const atLabel = t('automations.at');

    const FREQUENCY_OPTIONS: { value: FrequencyType; label: string }[] = [
        { value: 'hour', label: t('automations.frequencyHour') },
        { value: 'day', label: t('automations.frequencyDay') },
        { value: 'week', label: t('automations.frequencyWeek') },
        { value: 'month', label: t('automations.frequencyMonth') },
    ];

    const INSTRUCTION_SUGGESTIONS = [
        { label: t('automations.suggestions.makePicture'), prefix: 'Make a picture of ' },
        { label: t('automations.suggestions.generateSummary'), prefix: 'Generate a summary of ' },
        { label: t('automations.suggestions.createNewsletter'), prefix: 'Create a newsletter of ' },
        { label: t('automations.suggestions.notifyWhen'), prefix: 'Notify me when ' },
    ];

    // Instructions state
    const [instructions, setInstructions] = useState('');

    // Schedule state (optional)
    const [hasSchedule, setHasSchedule] = useState(false);
    const [frequency, setFrequency] = useState<FrequencyType>('day');
    const [daysOfWeek, setDaysOfWeek] = useState<DayOfWeek[]>(['monday']);
    const [dayOfMonth, setDayOfMonth] = useState(1);
    const [minuteOfHour, setMinuteOfHour] = useState(0);
    const [time, setTime] = useState('12:00');

    // Form state
    const [chatModelId, setChatModelId] = useState<number | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const { models, defaultModel } = useModels();
    const defaultModelName = defaultModel?.friendlyName || defaultModel?.name;
    const defaultModelLabel = defaultModelName
        ? t('automations.defaultModel', { model: defaultModelName })
        : t('automations.defaultModelUnknown');

    const canSubmit = instructions.trim().length > 0 && !isCreating;

    // Convert UI state to cron schedule
    const buildCronSchedule = (): string => {
        const [hour, timeMinute] = time.split(':').map(Number);

        switch (frequency) {
            case 'hour':
                // Every hour at the specified minute
                return `${minuteOfHour} * * * *`;
            case 'day':
                // Every day at the specified time
                return `${timeMinute} ${hour} * * *`;
            case 'week':
                // Every week on the specified day(s)
                const weekdayIndices = daysOfWeek
                    .map(d => DAYS_OF_WEEK.findIndex(day => day.value === d))
                    .sort((a, b) => a - b)
                    .join(',');
                return `${timeMinute} ${hour} * * ${weekdayIndices}`;
            case 'month':
                // Every month on the specified day
                return `${timeMinute} ${hour} ${dayOfMonth} * *`;
            default:
                return `${timeMinute} ${hour} * * *`;
        }
    };

    const generateName = (): string => {
        return instructions.trim().slice(0, 100);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;

        setIsCreating(true);
        setError(null);

        try {
            const name = generateName();

            // Build request body - trigger is optional
            const body: Record<string, unknown> = {
                name,
                prompt: instructions,
                chatModelId,
            };

            // Only include trigger config if schedule is enabled
            if (hasSchedule) {
                const schedule = buildCronSchedule();
                body.triggerType = 'cron';
                body.triggerConfig = {
                    type: 'cron',
                    schedule,
                };
            }

            const res = await apiFetch('/api/automations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (res.ok) {
                onCreated();
            } else {
                const data = await res.json();
                setError(typeof data.error === 'string' ? data.error : t('automations.failedToCreate'));
            }
        } catch (e) {
            setError(t('automations.failedToCreate'));
        } finally {
            setIsCreating(false);
        }
    };

    const handleBackdropClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    };

    const handleSuggestionClick = (prefix: string) => {
        setInstructions(prefix);
    };

    return (
        <div className="modal-backdrop" onClick={handleBackdropClick}>
            <div className="modal automation-modal">
                <div className="modal-header">
                    <h2>{t('automations.createRoutine')}</h2>
                    <button onClick={onClose} className="modal-close">
                        <X size={18} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="automation-form">
                    {/* Instructions Section - First */}
                    <div className="form-section">
                        <div className="form-section-header">
                            <h3>{t('automations.instructions')}</h3>
                            <p className="form-section-subtitle">{t('automations.instructionsSubtitle')}</p>
                        </div>

                        <div className="instruction-suggestions">
                            {INSTRUCTION_SUGGESTIONS.map((suggestion, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    className="instruction-suggestion"
                                    onClick={() => handleSuggestionClick(suggestion.prefix)}
                                >
                                    {suggestion.label}
                                </button>
                            ))}
                        </div>

                        <textarea
                            value={instructions}
                            onChange={(e) => setInstructions(e.target.value)}
                            placeholder={t('automations.instructionsPlaceholder')}
                            rows={4}
                            className="instructions-textarea"
                        />
                    </div>

                    {/* Model Section - defaults to whichever model the user is on */}
                    <div className="form-section">
                        <div className="form-section-header">
                            <h3>{t('automations.model')}</h3>
                        </div>
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
                            onClick={() => setHasSchedule(!hasSchedule)}
                        >
                            {hasSchedule ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                            <span>{t('automations.schedule')}</span>
                            <span className="schedule-toggle-hint">
                                {hasSchedule ? '' : t('automations.scheduleHint')}
                            </span>
                        </button>

                        {hasSchedule && (
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
                                            <p className="frequency-detail-label">{t('automations.weekDayPrompt')}</p>
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
                                            <p className="frequency-detail-label">{t('automations.monthDayPrompt')}</p>
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
                                            <p className="frequency-detail-label">{t('automations.minutePrompt')}</p>
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
                                        <p className="frequency-detail-label">{t('automations.timePrompt')}</p>
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

                    {error && <div className="form-error">{error}</div>}

                    <div className="modal-actions">
                        <button type="button" onClick={onClose} className="btn-secondary">
                            {t('common.cancel')}
                        </button>
                        <button type="submit" disabled={!canSubmit} className="btn-primary btn-save">
                            {isCreating ? (
                                <>
                                    <Loader2 size={16} className="spinning" />
                                    <span>{t('automations.creating')}</span>
                                </>
                            ) : (
                                t('common.save')
                            )}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
