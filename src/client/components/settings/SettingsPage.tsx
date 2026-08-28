// Settings page component

import React, { useState, useEffect } from 'react';
import { Save, Loader2, Check, AlertCircle, Shield, User, FolderLock, Headphones } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../utils/api';
import { SUPPORTED_LANGUAGES } from '../../i18n';
import { PathListEditor } from './PathListEditor';
import { MemorySettingsSection } from './MemorySettingsSection';
import { NotificationsSection } from './NotificationsSection';
import { useVoiceSettings } from '../../hooks/useVoiceSettings';

type SettingsTab = 'profile' | 'permissions';

interface UserContext {
    name?: string;
    location?: string;
    instructions?: string;
}

interface SandboxConfig {
    enabled: boolean;
    allowedWritePaths: string[];
    deniedWritePaths: string[];
    deniedReadPaths: string[];
    allowedDomains: string[];
    allowLocalBinding: boolean;
}

interface DefaultPaths {
    allowedWritePaths: string[];
    deniedReadPaths: string[];
}

interface SandboxStatus {
    enabled: boolean;
    supported: boolean;
    platform: string;
}

/** Filter out system-managed default paths for display */
function getUserPaths(paths: string[], defaultPaths: string[]): string[] {
    const defaults = new Set(defaultPaths);
    return paths.filter(p => !defaults.has(p));
}

/** Merge user-edited paths back with defaults for saving */
function mergeWithDefaults(userPaths: string[], defaultPaths: string[]): string[] {
    return [...defaultPaths, ...userPaths.filter(p => !defaultPaths.includes(p))];
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface SettingsPageProps {
    onUserContextSaved?: () => void;
}

export function SettingsPage({ onUserContextSaved }: SettingsPageProps) {
    const { t, i18n } = useTranslation();
    const [activeTab, setActiveTab] = useState<SettingsTab>('profile');
    const [name, setName] = useState('');
    const [location, setLocation] = useState('');
    const [instructions, setInstructions] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    // Voice feature flag (beta, per-device). Session mode lives in the chat-input menu.
    const { enabled: voiceFeatureEnabled, setEnabled: setVoiceEnabled } = useVoiceSettings();

    // Sandbox state
    const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | null>(null);
    const [sandboxConfig, setSandboxConfig] = useState<SandboxConfig | null>(null);
    const [defaultPaths, setDefaultPaths] = useState<DefaultPaths | null>(null);
    const [sandboxError, setSandboxError] = useState<string | null>(null);

    // Track if form has unsaved changes
    const [originalValues, setOriginalValues] = useState<UserContext>({});
    const hasChanges =
        name !== (originalValues.name || '') ||
        location !== (originalValues.location || '') ||
        instructions !== (originalValues.instructions || '');

    useEffect(() => {
        fetchUserContext();
        fetchSandboxData();
    }, []);

    const fetchUserContext = async () => {
        try {
            const res = await apiFetch('/api/user/context');
            if (res.ok) {
                const data: UserContext = await res.json();
                setName(data.name || '');
                setLocation(data.location || '');
                setInstructions(data.instructions || '');
                setOriginalValues(data);
            }
        } catch (e) {
            console.error('Failed to fetch user context', e);
            setError(t('settings.failedToLoad'));
        } finally {
            setIsLoading(false);
        }
    };

    const fetchSandboxData = async () => {
        try {
            // Fetch sandbox status and config in parallel
            const [statusRes, configRes] = await Promise.all([
                apiFetch('/api/sandbox/status'),
                apiFetch('/api/user/sandbox'),
            ]);

            if (statusRes.ok) {
                const status: SandboxStatus = await statusRes.json();
                setSandboxStatus(status);
            }

            if (configRes.ok) {
                const data = await configRes.json();
                const { defaults, ...config } = data as SandboxConfig & { defaults: DefaultPaths };
                setSandboxConfig(config);
                setDefaultPaths(defaults);
            }
        } catch (e) {
            console.error('Failed to fetch sandbox data', e);
            setSandboxError(t('settings.failedToLoadSandbox'));
        }
    };

    const handleSave = async () => {
        setSaveStatus('saving');
        setError(null);

        try {
            const res = await apiFetch('/api/user/context', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name || undefined,
                    location: location || undefined,
                    instructions: instructions || undefined,
                }),
            });

            if (res.ok) {
                setSaveStatus('saved');
                setOriginalValues({ name, location, instructions });
                onUserContextSaved?.();
                // Reset status after a delay
                setTimeout(() => setSaveStatus('idle'), 2000);
            } else {
                const data = await res.json();
                throw new Error(data.error || t('settings.failedToSave'));
            }
        } catch (e) {
            console.error('Failed to save user context', e);
            setSaveStatus('error');
            setError(e instanceof Error ? e.message : t('settings.failedToSave'));
        }
    };

    /** Toggle sandbox on/off — saves immediately without requiring the Save button. */
    const handleToggleSandbox = async (enabled: boolean) => {
        if (!sandboxConfig) return;
        setSandboxConfig({ ...sandboxConfig, enabled });
        setSandboxError(null);
        try {
            const res = await apiFetch('/api/user/sandbox', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
            });
            if (res.ok) {
                const statusRes = await apiFetch('/api/sandbox/status');
                if (statusRes.ok) setSandboxStatus(await statusRes.json());
            } else {
                // Revert on failure
                setSandboxConfig(prev => prev ? { ...prev, enabled: !enabled } : prev);
                const data = await res.json();
                throw new Error(data.error || t('settings.failedToSave'));
            }
        } catch (e) {
            console.error('Failed to toggle sandbox', e);
            setSandboxError(e instanceof Error ? e.message : t('settings.failedToToggleSandbox'));
        }
    };

    /** Update paths and save immediately. */
    const savePaths = async (updates: Partial<SandboxConfig>) => {
        if (!sandboxConfig) return;
        const updated = { ...sandboxConfig, ...updates };
        setSandboxConfig(updated);
        setSandboxError(null);
        try {
            const res = await apiFetch('/api/user/sandbox', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    allowedWritePaths: updated.allowedWritePaths,
                    deniedReadPaths: updated.deniedReadPaths,
                }),
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || t('settings.failedToSave'));
            }
        } catch (e) {
            console.error('Failed to save file permissions', e);
            setSandboxConfig(sandboxConfig); // revert
            setSandboxError(e instanceof Error ? e.message : t('settings.failedToSavePermissions'));
        }
    };

    if (isLoading) {
        return (
            <main className="main-content">
                <div className="messages-container">
                    <div className="settings-page">
                        <div className="settings-loading">{t('settings.loading')}</div>
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main className="main-content">
            <div className="messages-container">
                <div className="settings-page">
                    <div className="settings-header">
                        <h2>{t('settings.title')}</h2>
                        <div className="settings-tabs">
                            <button
                                className={`settings-tab ${activeTab === 'profile' ? 'active' : ''}`}
                                onClick={() => setActiveTab('profile')}
                            >
                                <User size={16} />
                                <span>{t('settings.tabProfile')}</span>
                            </button>
                            <button
                                className={`settings-tab ${activeTab === 'permissions' ? 'active' : ''}`}
                                onClick={() => setActiveTab('permissions')}
                            >
                                <Shield size={16} />
                                <span>{t('settings.tabPermissions')}</span>
                            </button>
                        </div>
                    </div>

                    {error && (
                        <div className="settings-error">
                            <AlertCircle size={14} />
                            <span>{error}</span>
                        </div>
                    )}

                    {activeTab === 'profile' && (
                      <>
                        <div className="settings-section">
                            <h3 className="settings-section-title">
                                <User size={18} />
                                {t('settings.aboutYou')}
                            </h3>
                            <p className="settings-section-description">
                                {t('settings.aboutYouDescription')}
                            </p>

                            <div className="settings-form">
                                <div className="settings-field">
                                    <label htmlFor="name">{t('settings.labelName')}</label>
                                    <input
                                        id="name"
                                        type="text"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        placeholder={t('settings.placeholderName')}
                                    />
                                </div>

                                <div className="settings-field">
                                    <label htmlFor="location">{t('settings.labelLocation')}</label>
                                    <input
                                        id="location"
                                        type="text"
                                        value={location}
                                        onChange={(e) => setLocation(e.target.value)}
                                        placeholder={t('settings.placeholderLocation')}
                                    />
                                </div>

                                {SUPPORTED_LANGUAGES.length > 1 && (
                                    <div className="settings-field">
                                        <label htmlFor="language">{t('settings.language')}</label>
                                        <p className="settings-field-hint">
                                            {t('settings.languageHint')}
                                        </p>
                                        <select
                                            id="language"
                                            value={i18n.language.slice(0, 2)}
                                            onChange={(e) => {
                                                const lang = e.target.value;
                                                i18n.changeLanguage(lang);
                                                apiFetch('/api/user/context', {
                                                    method: 'PUT',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ language: lang }),
                                                }).catch(() => {});
                                            }}
                                        >
                                            {SUPPORTED_LANGUAGES.map(lang => (
                                                <option key={lang.code} value={lang.code}>
                                                    {lang.label}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}

                                <div className="settings-field">
                                    <label htmlFor="instructions">{t('settings.labelInstructions')}</label>
                                    <p className="settings-field-hint">
                                        {t('settings.instructionsHint')}
                                    </p>
                                    <textarea
                                        id="instructions"
                                        value={instructions}
                                        onChange={(e) => setInstructions(e.target.value)}
                                        placeholder={t('settings.instructionsPlaceholder')}
                                        rows={10}
                                    />
                                </div>

                                <div className="settings-actions">
                                    <button
                                        onClick={handleSave}
                                        disabled={saveStatus === 'saving' || !hasChanges}
                                        className={`settings-save-btn ${saveStatus === 'saved' ? 'saved' : ''}`}
                                    >
                                        {saveStatus === 'saving' ? (
                                            <>
                                                <Loader2 size={16} className="spinning" />
                                                <span>{t('settings.saving')}</span>
                                            </>
                                        ) : saveStatus === 'saved' ? (
                                            <>
                                                <Check size={16} />
                                                <span>{t('settings.saved')}</span>
                                            </>
                                        ) : (
                                            <>
                                                <Save size={16} />
                                                <span>{t('settings.saveChanges')}</span>
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                      </>
                    )}

                    {activeTab === 'permissions' && (
                    <>
                        {sandboxError && (
                            <div className="settings-error">
                                <AlertCircle size={14} />
                                <span>{sandboxError}</span>
                            </div>
                        )}

                        <MemorySettingsSection />

                        <NotificationsSection />

                        {/* Voice mode (beta) — gates all voice UI and the mic session */}
                        <div className="settings-section">
                            <div className="settings-section-header">
                                <div>
                                    <h3 className="settings-section-title">
                                        <Headphones size={18} />
                                        {t('voice.title')}
                                        <span className="settings-beta-badge">{t('voice.beta')}</span>
                                    </h3>
                                    <p className="settings-section-description">
                                        {t('voice.description')}
                                    </p>
                                </div>
                                <label className="toggle-switch">
                                    <input
                                        id="voice-enabled"
                                        type="checkbox"
                                        checked={voiceFeatureEnabled}
                                        onChange={(e) => setVoiceEnabled(e.target.checked)}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>
                            <p className="settings-field-hint">{t('voice.betaHint')}</p>
                            <p className="settings-field-hint">{t('voice.enabledHint')}</p>
                        </div>

                        {/* Sandbox toggle */}
                        {sandboxStatus?.supported && <div className="settings-section">
                            <div className="settings-section-header">
                                <div>
                                    <h3 className="settings-section-title">
                                        <Shield size={18} />
                                        {t('settings.sandbox')}
                                    </h3>
                                    <p className="settings-section-description">
                                        {t('settings.sandboxDescription')}
                                    </p>
                                </div>
                                {sandboxConfig && (
                                    <label className="toggle-switch">
                                        <input
                                            id="sandbox-enabled"
                                            type="checkbox"
                                            checked={sandboxConfig.enabled}
                                            onChange={(e) => handleToggleSandbox(e.target.checked)}
                                        />
                                        <span className="toggle-slider"></span>
                                    </label>
                                )}
                            </div>
                        </div>}

                        {/* File permissions */}
                        {sandboxStatus?.supported && sandboxConfig && (
                        <div className="settings-section">
                            <h3 className="settings-section-title">
                                <FolderLock size={18} />
                                {t('settings.filePermissions')}
                            </h3>
                            <p className="settings-section-description">
                                {t('settings.filePermissionsDescription')}
                            </p>

                            <div className="settings-form">
                                <div className="settings-field">
                                    <label>{t('settings.allowedWriteDirectories')}</label>
                                    <p className="settings-field-hint">
                                        {t('settings.allowedWriteHint')}
                                    </p>
                                    <PathListEditor
                                        paths={getUserPaths(sandboxConfig.allowedWritePaths, defaultPaths?.allowedWritePaths ?? [])}
                                        onChange={(paths) => savePaths({ allowedWritePaths: mergeWithDefaults(paths, defaultPaths?.allowedWritePaths ?? []) })}
                                        placeholder={t('settings.allowedWritePlaceholder')}
                                    />
                                </div>

                                <div className="settings-field">
                                    <label>{t('settings.protectedReadPaths')}</label>
                                    <p className="settings-field-hint">
                                        {t('settings.protectedReadHint')}
                                    </p>
                                    <PathListEditor
                                        paths={getUserPaths(sandboxConfig.deniedReadPaths, defaultPaths?.deniedReadPaths ?? [])}
                                        onChange={(paths) => savePaths({ deniedReadPaths: mergeWithDefaults(paths, defaultPaths?.deniedReadPaths ?? []) })}
                                        placeholder={t('settings.protectedReadPlaceholder')}
                                        mode="any"
                                    />
                                </div>

                            </div>
                        </div>
                        )}
                    </>
                    )}
                </div>
            </div>
        </main>
    );
}
