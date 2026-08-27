// Modal for viewing and editing skill details, with delete and reset-to-default options

import React, { useState, useEffect } from 'react';
import { X, Loader2, Trash2, FileText, Save, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SkillInfo } from '../../types/skills';
import { apiFetch } from '../../utils/api';

interface SkillDetailModalProps {
    skill: SkillInfo;
    onClose: () => void;
    onDeleted: () => void;
    onUpdated?: () => void;
}

export function SkillDetailModal({ skill, onClose, onDeleted, onUpdated }: SkillDetailModalProps) {
    const { t } = useTranslation();
    const [isDeleting, setIsDeleting] = useState(false);
    const [isResetting, setIsResetting] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    // Both destructive actions confirm in the footer, so one at a time can be pending
    const [confirming, setConfirming] = useState<'delete' | 'reset' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoadingInstructions, setIsLoadingInstructions] = useState(true);

    // Editable fields
    const [description, setDescription] = useState(skill.description);
    const [instructions, setInstructions] = useState('');
    const [originalDescription, setOriginalDescription] = useState(skill.description);
    const [originalInstructions, setOriginalInstructions] = useState('');

    // Check if there are unsaved changes
    const hasChanges = description !== originalDescription || instructions !== originalInstructions;
    const canSave = hasChanges && description.length > 0 && !isSaving;

    // Load skill instructions on mount
    useEffect(() => {
        const loadInstructions = async () => {
            try {
                const res = await apiFetch(`/api/skills/${encodeURIComponent(skill.name)}`);
                if (res.ok) {
                    const data = await res.json();
                    const loadedInstructions = data.instructions || '';
                    setInstructions(loadedInstructions);
                    setOriginalInstructions(loadedInstructions);
                }
            } catch (e) {
                console.error('Failed to load skill instructions', e);
            } finally {
                setIsLoadingInstructions(false);
            }
        };
        loadInstructions();
    }, [skill.name]);

    const handleSave = async () => {
        if (!canSave) return;

        setIsSaving(true);
        setError(null);

        try {
            const res = await apiFetch(`/api/skills/${encodeURIComponent(skill.name)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description, instructions }),
            });

            if (res.ok) {
                setOriginalDescription(description);
                setOriginalInstructions(instructions);
                onUpdated?.();
                onClose();
            } else {
                const data = await res.json();
                setError(data.error || t('skills.failedToSave'));
            }
        } catch (e) {
            setError(t('skills.failedToSave'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async () => {
        setIsDeleting(true);
        setError(null);

        try {
            const res = await apiFetch(`/api/skills/${encodeURIComponent(skill.name)}`, {
                method: 'DELETE',
            });

            if (res.ok) {
                onDeleted();
            } else {
                const data = await res.json();
                setError(data.error || t('skills.failedToDelete'));
                setConfirming(null);
            }
        } catch (e) {
            setError(t('skills.failedToDelete'));
            setConfirming(null);
        } finally {
            setIsDeleting(false);
        }
    };

    const handleReset = async () => {
        setIsResetting(true);
        setError(null);

        try {
            const res = await apiFetch(`/api/skills/${encodeURIComponent(skill.name)}/reset`, {
                method: 'POST',
            });

            if (res.ok) {
                onUpdated?.();
                onClose();
            } else {
                const data = await res.json();
                setError(data.error || t('skills.failedToReset'));
                setConfirming(null);
            }
        } catch (e) {
            setError(t('skills.failedToReset'));
            setConfirming(null);
        } finally {
            setIsResetting(false);
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
                if (confirming) {
                    setConfirming(null);
                } else {
                    onClose();
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose, confirming]);

    return (
        <div className="modal-backdrop" onClick={handleBackdropClick}>
            <div className="modal skill-detail-modal">
                <div className="modal-header">
                    <div className="skill-detail-header-content">
                        <h2>{skill.name}</h2>
                    </div>
                    <button onClick={onClose} className="modal-close">
                        <X size={18} />
                    </button>
                </div>

                <div className="skill-detail-content">
                    <div className="skill-detail-section">
                        <label htmlFor="skill-description" className="skill-detail-label">{t('skills.description')}</label>
                        <textarea
                            id="skill-description"
                            className="skill-detail-textarea skill-detail-description-input"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder={t('skills.descriptionPlaceholder')}
                            rows={2}
                        />
                    </div>

                    <div className="skill-detail-section">
                        <label htmlFor="skill-instructions" className="skill-detail-label">{t('skills.instructions')}</label>
                        {isLoadingInstructions ? (
                            <div className="skill-detail-loading">
                                <Loader2 size={16} className="spinning" />
                                <span>{t('common.loading')}</span>
                            </div>
                        ) : (
                            <textarea
                                id="skill-instructions"
                                className="skill-detail-textarea skill-detail-instructions-input"
                                value={instructions}
                                onChange={(e) => setInstructions(e.target.value)}
                                placeholder={t('skills.instructionsPlaceholder')}
                                rows={10}
                            />
                        )}
                    </div>

                    <div className="skill-detail-section">
                        <span className="skill-detail-label">{t('skills.location')}</span>
                        <div className="skill-detail-location">
                            <FileText size={14} />
                            <code>{skill.location}</code>
                        </div>
                    </div>

                    {error && <div className="form-error">{error}</div>}
                </div>

                <div className="modal-actions skill-detail-actions">
                    {confirming ? (
                        <>
                            <span className="delete-confirm-text">
                                {confirming === 'delete' ? t('skills.deleteSkillConfirm') : t('skills.resetSkillConfirm')}
                            </span>
                            <button
                                type="button"
                                onClick={() => setConfirming(null)}
                                className="btn-secondary"
                                disabled={isDeleting || isResetting}
                            >
                                {t('common.cancel')}
                            </button>
                            {confirming === 'delete' ? (
                                <button
                                    type="button"
                                    onClick={handleDelete}
                                    className="btn-danger"
                                    disabled={isDeleting}
                                >
                                    {isDeleting ? (
                                        <>
                                            <Loader2 size={16} className="spinning" />
                                            <span>{t('skills.deleting')}</span>
                                        </>
                                    ) : (
                                        <>
                                            <Trash2 size={16} />
                                            <span>{t('common.delete')}</span>
                                        </>
                                    )}
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={handleReset}
                                    className="btn-danger"
                                    disabled={isResetting}
                                >
                                    {isResetting ? (
                                        <>
                                            <Loader2 size={16} className="spinning" />
                                            <span>{t('skills.resetting')}</span>
                                        </>
                                    ) : (
                                        <>
                                            <RotateCcw size={16} />
                                            <span>{t('skills.resetToDefault')}</span>
                                        </>
                                    )}
                                </button>
                            )}
                        </>
                    ) : (
                        <>
                            <button
                                type="button"
                                onClick={() => setConfirming('delete')}
                                className="btn-danger-outline"
                            >
                                <Trash2 size={16} />
                                <span>{t('common.delete')}</span>
                            </button>
                            {skill.modified && (
                                <button
                                    type="button"
                                    onClick={() => setConfirming('reset')}
                                    className="btn-secondary"
                                >
                                    <RotateCcw size={16} />
                                    <span>{t('skills.resetToDefault')}</span>
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={!canSave}
                                className="btn-primary"
                            >
                                {isSaving ? (
                                    <>
                                        <Loader2 size={16} className="spinning" />
                                        <span>{t('skills.saving')}</span>
                                    </>
                                ) : (
                                    <>
                                        <Save size={16} />
                                        <span>{t('skills.save')}</span>
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
