// Settings page component

import React, { useState, useEffect } from 'react';
import { Save, Loader2, Check, AlertCircle, CheckCircle, Shield, ShieldOff, User } from 'lucide-react';
import { apiFetch } from '../../utils/api';
import { PathListEditor } from './PathListEditor';

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

interface SandboxStatus {
    enabled: boolean;
    supported: boolean;
    platform: string;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function SettingsPage() {
    const [activeTab, setActiveTab] = useState<SettingsTab>('profile');
    const [name, setName] = useState('');
    const [location, setLocation] = useState('');
    const [instructions, setInstructions] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
    const [error, setError] = useState<string | null>(null);

    // Sandbox state
    const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | null>(null);
    const [sandboxConfig, setSandboxConfig] = useState<SandboxConfig | null>(null);
    const [originalSandboxConfig, setOriginalSandboxConfig] = useState<SandboxConfig | null>(null);
    const [sandboxSaveStatus, setSandboxSaveStatus] = useState<SaveStatus>('idle');
    const [sandboxError, setSandboxError] = useState<string | null>(null);

    // Track if form has unsaved changes
    const [originalValues, setOriginalValues] = useState<UserContext>({});
    const hasChanges =
        name !== (originalValues.name || '') ||
        location !== (originalValues.location || '') ||
        instructions !== (originalValues.instructions || '');

    // Track sandbox changes
    const hasSandboxChanges = sandboxConfig && originalSandboxConfig
        ? JSON.stringify(sandboxConfig) !== JSON.stringify(originalSandboxConfig)
        : false;

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
            setError('Failed to load settings');
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
                const config: SandboxConfig = await configRes.json();
                setSandboxConfig(config);
                setOriginalSandboxConfig(config);
            }
        } catch (e) {
            console.error('Failed to fetch sandbox data', e);
            setSandboxError('Failed to load sandbox settings');
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
                // Reset status after a delay
                setTimeout(() => setSaveStatus('idle'), 2000);
            } else {
                const data = await res.json();
                throw new Error(data.error || 'Failed to save');
            }
        } catch (e) {
            console.error('Failed to save user context', e);
            setSaveStatus('error');
            setError(e instanceof Error ? e.message : 'Failed to save settings');
        }
    };

    const handleSaveSandbox = async () => {
        if (!sandboxConfig) return;

        setSandboxSaveStatus('saving');
        setSandboxError(null);

        try {
            const res = await apiFetch('/api/user/sandbox', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sandboxConfig),
            });

            if (res.ok) {
                setSandboxSaveStatus('saved');
                setOriginalSandboxConfig({ ...sandboxConfig });
                // Refresh status to get updated enabled state
                const statusRes = await apiFetch('/api/sandbox/status');
                if (statusRes.ok) {
                    setSandboxStatus(await statusRes.json());
                }
                setTimeout(() => setSandboxSaveStatus('idle'), 2000);
            } else {
                const data = await res.json();
                throw new Error(data.error || 'Failed to save');
            }
        } catch (e) {
            console.error('Failed to save sandbox settings', e);
            setSandboxSaveStatus('error');
            setSandboxError(e instanceof Error ? e.message : 'Failed to save sandbox settings');
        }
    };

    const updateSandboxConfig = (updates: Partial<SandboxConfig>) => {
        if (sandboxConfig) {
            setSandboxConfig({ ...sandboxConfig, ...updates });
        }
    };

    if (isLoading) {
        return (
            <main className="main-content">
                <div className="messages-container">
                    <div className="settings-page">
                        <div className="settings-loading">Loading settings...</div>
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
                        <h2>Settings</h2>
                    </div>

                    <div className="settings-tabs">
                        <button
                            className={`settings-tab ${activeTab === 'profile' ? 'active' : ''}`}
                            onClick={() => setActiveTab('profile')}
                        >
                            <User size={16} />
                            <span>Profile</span>
                        </button>
                        <button
                            className={`settings-tab ${activeTab === 'permissions' ? 'active' : ''}`}
                            onClick={() => setActiveTab('permissions')}
                        >
                            <Shield size={16} />
                            <span>Permissions</span>
                        </button>
                    </div>

                    {error && (
                        <div className="settings-error">
                            <AlertCircle size={14} />
                            <span>{error}</span>
                        </div>
                    )}

                    {activeTab === 'profile' && (
                        <div className="settings-section">
                            <h3 className="settings-section-title">
                                <User size={18} />
                                About You
                            </h3>
                            <p className="settings-section-description">
                                This information helps Pipali personalize responses and understand your context.
                            </p>

                            <div className="settings-form">
                                <div className="settings-field">
                                    <label htmlFor="name">Name</label>
                                    <input
                                        id="name"
                                        type="text"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        placeholder="Your name"
                                    />
                                </div>

                                <div className="settings-field">
                                    <label htmlFor="location">Location</label>
                                    <input
                                        id="location"
                                        type="text"
                                        value={location}
                                        onChange={(e) => setLocation(e.target.value)}
                                        placeholder="City, Country"
                                    />
                                </div>

                                <div className="settings-field">
                                    <label htmlFor="instructions">Custom Instructions</label>
                                    <p className="settings-field-hint">
                                        Tell Pipali about yourself, your preferences, and how you'd like it to respond.
                                    </p>
                                    <textarea
                                        id="instructions"
                                        value={instructions}
                                        onChange={(e) => setInstructions(e.target.value)}
                                        placeholder="Example:&#10;I work as a sales representative. Please explain technical concepts simply.&#10;&#10;Always write new files to my Desktop/Pipali folder.&#10;Do not overwrite my existing files unless I specifically ask."
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
                                                <span>Saving...</span>
                                            </>
                                        ) : saveStatus === 'saved' ? (
                                            <>
                                                <Check size={16} />
                                                <span>Saved</span>
                                            </>
                                        ) : (
                                            <>
                                                <Save size={16} />
                                                <span>Save Changes</span>
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Security & Sandbox Section */}
                    {activeTab === 'permissions' && (
                    <div className="settings-section">
                        <h3 className="settings-section-title">
                            <Shield size={18} />
                            Security & Sandbox
                        </h3>
                        <p className="settings-section-description">
                            Configure sandbox restrictions for shell commands and file operations.
                            When enabled, shell commands run in an OS-enforced sandbox for increased security.
                        </p>

                        {sandboxError && (
                            <div className="settings-error">
                                <AlertCircle size={14} />
                                <span>{sandboxError}</span>
                            </div>
                        )}

                        {/* Platform status indicator */}
                        {sandboxStatus && (
                            <div className={`sandbox-status ${sandboxStatus.supported ? 'supported' : 'unsupported'}`}>
                                {sandboxStatus.supported ? (
                                    <>
                                        <CheckCircle size={16} />
                                        <span>Sandbox supported on {sandboxStatus.platform === 'darwin' ? 'macOS' : sandboxStatus.platform}</span>
                                    </>
                                ) : (
                                    <>
                                        <ShieldOff size={16} />
                                        <span>Sandbox not available on {sandboxStatus.platform}. Shell commands will require confirmation.</span>
                                    </>
                                )}
                            </div>
                        )}

                        {sandboxConfig && (
                            <div className="settings-form">
                                {/* Enable toggle */}
                                <div className="settings-field settings-field-toggle">
                                    <label htmlFor="sandbox-enabled">Enable Sandbox</label>
                                    <p className="settings-field-hint">
                                        When enabled, shell commands run in an OS-enforced sandbox without requiring confirmation.
                                    </p>
                                    <label className="toggle-switch">
                                        <input
                                            id="sandbox-enabled"
                                            type="checkbox"
                                            checked={sandboxConfig.enabled}
                                            onChange={(e) => updateSandboxConfig({ enabled: e.target.checked })}
                                        />
                                        <span className="toggle-slider"></span>
                                    </label>
                                </div>

                                {/* Allowed write paths */}
                                <div className="settings-field">
                                    <label>Allowed Write Directories</label>
                                    <p className="settings-field-hint">
                                        File writes to these directories won't require confirmation.
                                    </p>
                                    <PathListEditor
                                        paths={sandboxConfig.allowedWritePaths}
                                        onChange={(paths) => updateSandboxConfig({ allowedWritePaths: paths })}
                                        placeholder="e.g., ~/Documents or /tmp"
                                    />
                                </div>

                                {/* Denied write paths */}
                                <div className="settings-field">
                                    <label>Protected Write Paths</label>
                                    <p className="settings-field-hint">
                                        Never allow writes to these paths, even in allowed directories.
                                    </p>
                                    <PathListEditor
                                        paths={sandboxConfig.deniedWritePaths}
                                        onChange={(paths) => updateSandboxConfig({ deniedWritePaths: paths })}
                                        placeholder="e.g., ~/.ssh or ~/.aws"
                                    />
                                </div>

                                {/* Denied read paths */}
                                <div className="settings-field">
                                    <label>Protected Read Paths</label>
                                    <p className="settings-field-hint">
                                        Always require confirmation before reading these paths (SSH keys, credentials, etc.)
                                    </p>
                                    <PathListEditor
                                        paths={sandboxConfig.deniedReadPaths}
                                        onChange={(paths) => updateSandboxConfig({ deniedReadPaths: paths })}
                                        placeholder="e.g., ~/.ssh or .env"
                                    />
                                </div>

                                <div className="settings-actions">
                                    <button
                                        onClick={handleSaveSandbox}
                                        disabled={sandboxSaveStatus === 'saving' || !hasSandboxChanges}
                                        className={`settings-save-btn ${sandboxSaveStatus === 'saved' ? 'saved' : ''}`}
                                    >
                                        {sandboxSaveStatus === 'saving' ? (
                                            <>
                                                <Loader2 size={16} className="spinning" />
                                                <span>Saving...</span>
                                            </>
                                        ) : sandboxSaveStatus === 'saved' ? (
                                            <>
                                                <Check size={16} />
                                                <span>Saved</span>
                                            </>
                                        ) : (
                                            <>
                                                <Save size={16} />
                                                <span>Save Security Settings</span>
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                    )}
                </div>
            </div>
        </main>
    );
}
