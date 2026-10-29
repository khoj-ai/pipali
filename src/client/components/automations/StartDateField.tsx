// Optional date a routine's schedule starts firing from. Empty starts it right away.

import { useTranslation } from 'react-i18next';
import { CalendarClock, X } from 'lucide-react';
import { toDateInputValue } from './utils';

interface StartDateFieldProps {
    value: string;
    onChange: (value: string) => void;
    /** The routine's timezone, whose today is the earliest start */
    timeZone?: string;
}

export function StartDateField({ value, onChange, timeZone }: StartDateFieldProps) {
    const { t } = useTranslation();
    const prompt = t('automations.startDatePrompt');

    return (
        <div className="start-date-selector">
            <p className="frequency-detail-label">{prompt}</p>
            <div className="frequency-row">
                <CalendarClock size={16} className="frequency-icon" />
                <input
                    type="date"
                    value={value}
                    min={toDateInputValue(new Date(), timeZone)}
                    onChange={(e) => onChange(e.target.value)}
                    className="start-date-input"
                    aria-label={prompt}
                />
                {value && (
                    <button
                        type="button"
                        onClick={() => onChange('')}
                        className="start-date-clear"
                        title={t('automations.clearStartDate')}
                        aria-label={t('automations.clearStartDate')}
                    >
                        <X size={14} />
                    </button>
                )}
            </div>
        </div>
    );
}
