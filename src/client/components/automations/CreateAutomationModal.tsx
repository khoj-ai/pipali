// Modal for creating a new automation

import React, { useState } from 'react';
import { X, Loader2, Calendar, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import type { FrequencyType, DayOfWeek } from '../../types/automations';
import { DAYS_OF_WEEK, TIME_OPTIONS, DAY_OF_MONTH_OPTIONS, MINUTE_OPTIONS } from '../../types/automations';
import { apiFetch } from '../../utils/api';

interface CreateAutomationModalProps {
    onClose: () => void;
    onCreated: () => void;
}

const FREQUENCY_OPTIONS: { value: FrequencyType; label: string }[] = [
    { value: 'hour', label: 'Hour' },
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
];

const INSTRUCTION_SUGGESTIONS = [
    { label: 'Make a picture of...', prefix: 'Make a picture of ' },
    { label: 'Generate a summary of...', prefix: 'Generate a summary of ' },
    { label: 'Create a newsletter of...', prefix: 'Create a newsletter of ' },
    { label: 'Notify me when...', prefix: 'Notify me when ' },
];

export function CreateAutomationModal({ onClose, onCreated }: CreateAutomationModalProps) {
    // Instructions state
    const [instructions, setInstructions] = useState('');

    // Schedule state (optional)
    const [hasSchedule, setHasSchedule] = useState(false);
    const [frequency, setFrequency] = useState<FrequencyType>('day');
    const [dayOfWeek, setDayOfWeek] = useState<DayOfWeek>('monday');
    const [dayOfMonth, setDayOfMonth] = useState(1);
    const [minuteOfHour, setMinuteOfHour] = useState(0);
    const [time, setTime] = useState('12:00');

    // Form state
    const [isCreating, setIsCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
                // Every week on the specified day
                const weekdayIndex = DAYS_OF_WEEK.findIndex(d => d.value === dayOfWeek);
                return `${timeMinute} ${hour} * * ${weekdayIndex}`;
            case 'month':
                // Every month on the specified day
                return `${timeMinute} ${hour} ${dayOfMonth} * *`;
            default:
                return `${timeMinute} ${hour} * * *`;
        }
    };

    // Generate automation name from instructions
    const generateName = (): string => {
        const trimmed = instructions.trim();
        if (trimmed.length <= 50) return trimmed;
        return trimmed.slice(0, 47) + '...';
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
                setError(data.error || 'Failed to create automation');
            }
        } catch (e) {
            setError('Failed to create automation');
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
                    <h2>Create Automation</h2>
                    <button onClick={onClose} className="modal-close">
                        <X size={18} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="automation-form">
                    {/* Instructions Section - First */}
                    <div className="form-section">
                        <div className="form-section-header">
                            <h3>Instructions</h3>
                            <p className="form-section-subtitle">What do you want Pipali to do?</p>
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
                            placeholder="Create a summary of the latest news about AI in healthcare."
                            rows={4}
                            className="instructions-textarea"
                        />
                    </div>

                    {/* Schedule Section - Optional, collapsible */}
                    <div className="form-section schedule-section">
                        <button
                            type="button"
                            className="schedule-toggle"
                            onClick={() => setHasSchedule(!hasSchedule)}
                        >
                            {hasSchedule ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                            <span>Schedule</span>
                            <span className="schedule-toggle-hint">
                                {hasSchedule ? '' : '(Optional - run on a recurring schedule)'}
                            </span>
                        </button>

                        {hasSchedule && (
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

                    {error && <div className="form-error">{error}</div>}

                    <div className="modal-actions">
                        <button type="button" onClick={onClose} className="btn-secondary">
                            Cancel
                        </button>
                        <button type="submit" disabled={!canSubmit} className="btn-primary btn-save">
                            {isCreating ? (
                                <>
                                    <Loader2 size={16} className="spinning" />
                                    <span>Creating...</span>
                                </>
                            ) : (
                                'Save'
                            )}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
