import React, { useEffect, useState } from 'react';
import { Brain, ChevronDown, Loader2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../utils/api';

interface MemorySettings {
    memoriesEnabled: boolean;
}

interface MemorySummary {
    file: string;
    description?: string;
    type?: string;
    modified: string;
}

interface StoredMemory extends MemorySummary {
    content: string;
}

const ALL_MEMORIES = '*';

export function MemorySettingsSection() {
    const { t, i18n } = useTranslation();
    const [memoriesEnabled, setMemoriesEnabled] = useState<boolean | null>(null);
    const [memories, setMemories] = useState<MemorySummary[]>([]);
    const [memoryContents, setMemoryContents] = useState<Record<string, string>>({});
    const [isManagerExpanded, setIsManagerExpanded] = useState(false);
    const [expandedFile, setExpandedFile] = useState<string | null>(null);
    const [loadingFiles, setLoadingFiles] = useState<Set<string>>(() => new Set());
    const [isLoadingMemories, setIsLoadingMemories] = useState(true);
    const [isSavingMemories, setIsSavingMemories] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void fetchMemorySettings();
        void fetchMemories();
    }, []);

    const fetchMemorySettings = async () => {
        try {
            const res = await apiFetch('/api/memory/settings');
            if (!res.ok) throw new Error(t('settings.failedToLoad'));
            const settings: MemorySettings = await res.json();
            setMemoriesEnabled(settings.memoriesEnabled);
        } catch (err) {
            console.error('Failed to fetch memory settings', err);
            setMemoriesEnabled(true);
            setError(err instanceof Error ? err.message : t('settings.failedToLoad'));
        }
    };

    const fetchMemories = async () => {
        try {
            const res = await apiFetch('/api/memory');
            if (!res.ok) throw new Error(t('settings.failedToLoadMemories'));
            const data: { memories: MemorySummary[] } = await res.json();
            setMemories(data.memories);
        } catch (err) {
            console.error('Failed to fetch memories', err);
            setError(err instanceof Error ? err.message : t('settings.failedToLoadMemories'));
        } finally {
            setIsLoadingMemories(false);
        }
    };

    const handleToggleMemories = async (enabled: boolean) => {
        if (memoriesEnabled === null) return;
        const previous = memoriesEnabled;
        setMemoriesEnabled(enabled);
        setIsSavingMemories(true);
        setError(null);

        try {
            const res = await apiFetch('/api/memory/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ memoriesEnabled: enabled }),
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || t('settings.failedToSaveMemories'));
            }
        } catch (err) {
            setMemoriesEnabled(previous);
            console.error('Failed to toggle memories', err);
            setError(err instanceof Error ? err.message : t('settings.failedToSaveMemories'));
        } finally {
            setIsSavingMemories(false);
        }
    };

    const handleExpand = async (file: string) => {
        if (expandedFile === file) {
            setExpandedFile(null);
            return;
        }

        setExpandedFile(file);
        if (memoryContents[file] !== undefined) return;

        setLoadingFiles(current => new Set(current).add(file));
        setError(null);
        try {
            const res = await apiFetch(`/api/memory/${encodeURIComponent(file)}`);
            if (!res.ok) throw new Error(t('settings.failedToLoadMemories'));
            const data: { memory: StoredMemory } = await res.json();
            setMemoryContents(current => ({ ...current, [file]: data.memory.content }));
        } catch (err) {
            console.error('Failed to load memory', err);
            setError(err instanceof Error ? err.message : t('settings.failedToLoadMemories'));
            setExpandedFile(current => current === file ? null : current);
        } finally {
            setLoadingFiles(current => {
                const next = new Set(current);
                next.delete(file);
                return next;
            });
        }
    };

    const handleDelete = async (file: string) => {
        setDeleting(file);
        setError(null);
        try {
            const res = await apiFetch(`/api/memory/${encodeURIComponent(file)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(t('settings.failedToDeleteMemories'));

            setMemories(current => current.filter(memory => memory.file !== file));
            setMemoryContents(current => {
                const next = { ...current };
                delete next[file];
                return next;
            });
            if (expandedFile === file) setExpandedFile(null);
            setPendingDelete(null);
        } catch (err) {
            console.error('Failed to delete memory', err);
            setError(err instanceof Error ? err.message : t('settings.failedToDeleteMemories'));
        } finally {
            setDeleting(null);
        }
    };

    const handleDeleteAll = async () => {
        setDeleting(ALL_MEMORIES);
        setError(null);
        try {
            const res = await apiFetch('/api/memory', { method: 'DELETE' });
            if (!res.ok) throw new Error(t('settings.failedToDeleteMemories'));

            setMemories([]);
            setMemoryContents({});
            setExpandedFile(null);
            setPendingDelete(null);
        } catch (err) {
            console.error('Failed to delete memories', err);
            setError(err instanceof Error ? err.message : t('settings.failedToDeleteMemories'));
        } finally {
            setDeleting(null);
        }
    };

    const memoryMeta = (memory: MemorySummary): string => {
        const date = new Date(memory.modified);
        const modified = Number.isNaN(date.getTime())
            ? undefined
            : new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(date);
        return [memory.file, memory.type, modified].filter(Boolean).join(' · ');
    };

    const handleManagerToggle = () => {
        if (isManagerExpanded) {
            setExpandedFile(null);
            setPendingDelete(null);
        }
        setIsManagerExpanded(!isManagerExpanded);
    };

    return (
        <div className="settings-section">
            <div className="settings-section-header">
                <div>
                    <h3 className="settings-section-title">
                        <Brain size={18} />
                        {t('settings.memories')}
                    </h3>
                    <p className="settings-section-description">
                        {t('settings.memoriesDescription')}
                    </p>
                </div>
                <label className="toggle-switch">
                    <input
                        id="memories-enabled"
                        type="checkbox"
                        checked={memoriesEnabled ?? true}
                        disabled={isSavingMemories || memoriesEnabled === null}
                        onChange={(event) => void handleToggleMemories(event.target.checked)}
                        aria-label={t('settings.memories')}
                    />
                    <span className="toggle-slider"></span>
                </label>
            </div>

            <div className="memory-manager">
                <div className="memory-manager-header">
                    <button
                        type="button"
                        className="memory-manager-toggle"
                        onClick={handleManagerToggle}
                        aria-expanded={isManagerExpanded}
                    >
                        <ChevronDown size={14} className={isManagerExpanded ? 'expanded' : ''} />
                        <span>{t('settings.storedMemories', { count: memories.length })}</span>
                    </button>
                    {isManagerExpanded && memories.length > 0 && pendingDelete !== ALL_MEMORIES && (
                        <button
                            type="button"
                            className="memory-delete-all"
                            onClick={() => setPendingDelete(ALL_MEMORIES)}
                        >
                            <Trash2 size={13} />
                            {t('settings.deleteAllMemories')}
                        </button>
                    )}
                </div>

                {isManagerExpanded && pendingDelete === ALL_MEMORIES && (
                    <div className="memory-delete-confirm">
                        <span>{t('settings.deleteAllMemoriesConfirm')}</span>
                        <button type="button" onClick={() => setPendingDelete(null)} disabled={deleting !== null}>
                            {t('common.cancel')}
                        </button>
                        <button type="button" className="danger" onClick={() => void handleDeleteAll()} disabled={deleting !== null}>
                            {deleting === ALL_MEMORIES ? <Loader2 size={13} className="spinning" /> : t('settings.deleteAllMemories')}
                        </button>
                    </div>
                )}

                {error && <div className="memory-manager-error">{error}</div>}

                {isManagerExpanded && (isLoadingMemories ? (
                    <div className="memory-manager-empty">
                        <Loader2 size={14} className="spinning" />
                        {t('settings.loadingMemories')}
                    </div>
                ) : memories.length === 0 ? (
                    <div className="memory-manager-empty">{t('settings.noMemories')}</div>
                ) : (
                    <div className="memory-list">
                        {memories.map(memory => {
                            const isExpanded = expandedFile === memory.file;
                            const isDeleting = deleting === memory.file;
                            return (
                                <div className="memory-item" key={memory.file}>
                                    <div className="memory-item-row">
                                        <button
                                            type="button"
                                            className="memory-expand"
                                            onClick={() => void handleExpand(memory.file)}
                                            aria-expanded={isExpanded}
                                            aria-label={t('settings.viewMemory', { name: memory.description || memory.file })}
                                        >
                                            <ChevronDown size={15} className={isExpanded ? 'expanded' : ''} />
                                            <span className="memory-item-labels">
                                                <span className="memory-item-description">{memory.description || memory.file}</span>
                                                <span className="memory-item-meta">{memoryMeta(memory)}</span>
                                            </span>
                                        </button>
                                        <button
                                            type="button"
                                            className="memory-delete"
                                            onClick={() => setPendingDelete(memory.file)}
                                            disabled={deleting !== null}
                                            aria-label={t('settings.deleteMemory', { name: memory.description || memory.file })}
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>

                                    {pendingDelete === memory.file && (
                                        <div className="memory-delete-confirm">
                                            <span>{t('settings.deleteMemoryConfirm')}</span>
                                            <button type="button" onClick={() => setPendingDelete(null)} disabled={isDeleting}>
                                                {t('common.cancel')}
                                            </button>
                                            <button type="button" className="danger" onClick={() => void handleDelete(memory.file)} disabled={isDeleting}>
                                                {isDeleting ? <Loader2 size={13} className="spinning" /> : t('common.delete')}
                                            </button>
                                        </div>
                                    )}

                                    {isExpanded && (
                                        <pre className="memory-content">
                                            {loadingFiles.has(memory.file)
                                                ? t('settings.loadingMemory')
                                                : memoryContents[memory.file] || t('settings.emptyMemory')}
                                        </pre>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
        </div>
    );
}
