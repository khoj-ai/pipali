// How much of a routine's earlier runs each run is given. The recent-run count only
// applies to summarized, but is kept while another mode is chosen.

import { useTranslation } from 'react-i18next';
import { MAX_ROUTINE_HISTORY_RUNS, ROUTINE_HISTORY_MODES, type RoutineHistoryMode } from '../../../shared';

const RUN_COUNTS = Array.from({ length: MAX_ROUTINE_HISTORY_RUNS + 1 }, (_, count) => count);

export function useHistoryText() {
    const { t } = useTranslation();
    const label = (mode: RoutineHistoryMode) => ({
        all: t('automations.historyAll'),
        summarized: t('automations.historySummarized'),
        fresh: t('automations.historyFresh'),
    })[mode];
    const hint = (mode: RoutineHistoryMode, runs: number) => {
        if (mode === 'all') return t('automations.historyHintAll');
        if (mode === 'fresh') return t('automations.historyHintFresh');
        return runs === 0 ? t('automations.historyHintSummaryOnly') : t('automations.historyHintSummarized', { count: runs });
    };
    return { label, hint };
}

interface HistoryFieldProps {
    mode: RoutineHistoryMode;
    runs: number;
    onModeChange: (mode: RoutineHistoryMode) => void;
    onRunsChange: (runs: number) => void;
}

export function HistoryField({ mode, runs, onModeChange, onRunsChange }: HistoryFieldProps) {
    const { t } = useTranslation();
    const { label, hint } = useHistoryText();

    return (
        <div className="history-field">
            <select
                value={mode}
                onChange={(e) => onModeChange(e.target.value as RoutineHistoryMode)}
                className="automation-model-select"
                aria-label={t('automations.history')}
            >
                {ROUTINE_HISTORY_MODES.map(option => (
                    <option key={option} value={option}>{label(option)}</option>
                ))}
            </select>
            {mode === 'summarized' && (
                <label className="frequency-row">
                    <span className="frequency-label">{t('automations.historyRecentRuns')}</span>
                    <select value={runs} onChange={(e) => onRunsChange(Number(e.target.value))}>
                        {RUN_COUNTS.map(count => <option key={count} value={count}>{count}</option>)}
                    </select>
                </label>
            )}
            <p className="frequency-detail-label">{hint(mode, runs)}</p>
            <p className="frequency-detail-label">{t('automations.historyKept')}</p>
        </div>
    );
}
