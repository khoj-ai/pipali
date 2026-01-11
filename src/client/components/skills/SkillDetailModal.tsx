// Modal for viewing and editing skill details with delete option

import React, { useState, useEffect } from 'react';
import { X, Loader2, Globe, FolderOpen, Trash2, FileText, Save } from 'lucide-react';
import type { SkillInfo } from '../../types/skills';
import { apiFetch } from '../../utils/api';

interface SkillDetailModalProps {
    skill: SkillInfo;
    onClose: () => void;
    onDeleted: () => void;
    onUpdated?: () => void;
}

export function SkillDetailModal({ skill, onClose, onDeleted, onUpdated }: SkillDetailModalProps) {
    const [isDeleting, setIsDeleting] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isLoadingInstructions, setIsLoadingInstructions] = useState(true);

    // Editable fields
    const [description, setDescription] = useState(skill.description);
    const [instructions, setInstructions] = useState('');
    const [originalDescription, setOriginalDescription] = useState(skill.description);
    const [originalInstructions, setOriginalInstructions] = useState('');

    const SourceIcon = skill.source === 'global' ? Globe : FolderOpen;

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
                setError(data.error || 'Failed to save skill');
            }
        } catch (e) {
            setError('Failed to save skill');
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
                setError(data.error || 'Failed to delete skill');
                setShowDeleteConfirm(false);
            }
        } catch (e) {
            setError('Failed to delete skill');
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
                } else {
                    onClose();
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose, showDeleteConfirm]);

    return (
        <div className="modal-backdrop" onClick={handleBackdropClick}>
            <div className="modal skill-detail-modal">
                <div className="modal-header">
                    <div className="skill-detail-header-content">
                        <SourceIcon size={18} className="skill-detail-source-icon" />
                        <h2>{skill.name}</h2>
                        <span className={`skill-detail-source-badge ${skill.source}`}>
                            {skill.source}
                        </span>
                    </div>
                    <button onClick={onClose} className="modal-close">
                        <X size={18} />
                    </button>
                </div>

                <div className="skill-detail-content">
                    <div className="skill-detail-section">
                        <label htmlFor="skill-description" className="skill-detail-label">Description</label>
                        <textarea
                            id="skill-description"
                            className="skill-detail-textarea skill-detail-description-input"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="What this skill does..."
                            rows={2}
                        />
                    </div>

                    <div className="skill-detail-section">
                        <label htmlFor="skill-instructions" className="skill-detail-label">Instructions</label>
                        {isLoadingInstructions ? (
                            <div className="skill-detail-loading">
                                <Loader2 size={16} className="spinning" />
                                <span>Loading...</span>
                            </div>
                        ) : (
                            <textarea
                                id="skill-instructions"
                                className="skill-detail-textarea skill-detail-instructions-input"
                                value={instructions}
                                onChange={(e) => setInstructions(e.target.value)}
                                placeholder="Detailed instructions for how to use this skill..."
                                rows={10}
                            />
                        )}
                    </div>

                    <div className="skill-detail-section">
                        <span className="skill-detail-label">Location</span>
                        <div className="skill-detail-location">
                            <FileText size={14} />
                            <code>{skill.location}</code>
                        </div>
                    </div>

                    {error && <div className="form-error">{error}</div>}
                </div>

                <div className="modal-actions skill-detail-actions">
                    {showDeleteConfirm ? (
                        <>
                            <span className="delete-confirm-text">Delete this skill?</span>
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
                    ) : (
                        <>
                            <button
                                type="button"
                                onClick={() => setShowDeleteConfirm(true)}
                                className="btn-danger-outline"
                            >
                                <Trash2 size={16} />
                                <span>Delete</span>
                            </button>
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={!canSave}
                                className="btn-primary"
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
                    )}
                </div>
            </div>
        </div>
    );
}
