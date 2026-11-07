import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, X } from 'lucide-react';
import type { RefusalInfo } from '../../../shared';

interface RunErrorMessageProps {
    message: string;
    refusal?: RefusalInfo;
    onDismiss?: () => void;
}

export function RunErrorMessage({ message, refusal, onDismiss }: RunErrorMessageProps) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const [showDetails, setShowDetails] = useState(false);

    const copyDetails = async () => {
        await navigator.clipboard.writeText(message);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="run-error-message">
            <div className="run-error-message-header">
                <span className="run-error-message-icon">
                    <AlertTriangle size={18} />
                </span>
                <span className="run-error-message-title">
                    {refusal ? t('refusal.title') : t('runError.title', 'This run stopped')}
                </span>
                {onDismiss && (
                    <button className="run-error-message-icon-button" onClick={onDismiss} title={t('common.dismiss')}>
                        <X size={16} />
                    </button>
                )}
            </div>
            <p className="run-error-message-text">
                {refusal
                    ? t(`refusal.${refusal.category ?? 'generic'}`)
                    : t('runError.message', 'Pipali hit a model provider error and stopped before completing this response.')}
            </p>
            <div className="run-error-message-actions">
                <button className="run-error-message-action" onClick={copyDetails} type="button">
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? t('errors.copied') : t('errors.copyErrorDetails')}
                </button>
                <button className="run-error-message-details-toggle" onClick={() => setShowDetails(value => !value)} type="button">
                    {showDetails ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {showDetails ? t('runError.hideDetails', 'Hide details') : t('runError.showDetails', 'Show details')}
                </button>
            </div>
            {showDetails && (
                <pre className="run-error-message-details">{message}</pre>
            )}
        </div>
    );
}
