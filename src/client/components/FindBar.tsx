// The find bar itself: query box, match count, previous/next and close. What it searches is the caller's.

import { useEffect, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';

interface FindBarProps {
    query: string;
    onQueryChange: (query: string) => void;
    placeholder: string;
    /** Zero-based position of the active match */
    current: number;
    total: number;
    onNext: () => void;
    onPrevious: () => void;
    onClose: () => void;
    inputRef?: RefObject<HTMLInputElement | null>;
}

export function FindBar({ query, onQueryChange, placeholder, current, total, onNext, onPrevious, onClose, inputRef }: FindBarProps) {
    const { t } = useTranslation();
    const ownRef = useRef<HTMLInputElement>(null);
    const input = inputRef ?? ownRef;

    useEffect(() => {
        input.current?.focus();
        input.current?.select();
    }, [input]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            // Escape also stops a running task at the app level; closing the bar must not
            e.stopPropagation();
            onClose();
        } else if (e.key === 'Enter' || e.key === 'F3' || (e.key === 'g' && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            if (e.shiftKey) onPrevious(); else onNext();
        }
    };

    return (
        <div className="find-in-page-bar">
            <div className="find-input-wrapper">
                <Search size={16} className="find-icon" />
                <input
                    ref={input}
                    type="text"
                    value={query}
                    onChange={(e) => onQueryChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    className="find-input"
                    autoComplete="off"
                    spellCheck={false}
                />
                {query && (
                    <span className="find-count">
                        {total > 0
                            ? t('findInPage.matchCount', { current: current + 1, total })
                            : t('findInPage.noResults')}
                    </span>
                )}
            </div>
            <div className="find-actions">
                <button
                    onClick={onPrevious}
                    disabled={total === 0}
                    className="find-nav-button"
                    title={t('findInPage.previousMatch')}
                    aria-label={t('findInPage.previousMatchLabel')}
                >
                    <ChevronUp size={18} />
                </button>
                <button
                    onClick={onNext}
                    disabled={total === 0}
                    className="find-nav-button"
                    title={t('findInPage.nextMatch')}
                    aria-label={t('findInPage.nextMatchLabel')}
                >
                    <ChevronDown size={18} />
                </button>
                <button
                    onClick={onClose}
                    className="find-close-button"
                    title={t('findInPage.closeFind')}
                    aria-label={t('findInPage.closeFindLabel')}
                >
                    <X size={18} />
                </button>
            </div>
        </div>
    );
}
