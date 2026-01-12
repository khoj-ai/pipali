// Settings page component

import React, { useState, useEffect } from 'react';
import { Save, Loader2, Check, AlertCircle } from 'lucide-react';
import { apiFetch } from '../../utils/api';

interface UserContext {
    name?: string;
    location?: string;
    instructions?: string;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function SettingsPage() {
    const [name, setName] = useState('');
    const [location, setLocation] = useState('');
    const [instructions, setInstructions] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
    const [error, setError] = useState<string | null>(null);

    // Track if form has unsaved changes
    const [originalValues, setOriginalValues] = useState<UserContext>({});
    const hasChanges =
        name !== (originalValues.name || '') ||
        location !== (originalValues.location || '') ||
        instructions !== (originalValues.instructions || '');

    useEffect(() => {
        fetchUserContext();
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

                    {error && (
                        <div className="settings-error">
                            <AlertCircle size={14} />
                            <span>{error}</span>
                        </div>
                    )}

                    <div className="settings-section">
                        <h3 className="settings-section-title">About You</h3>
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
                </div>
            </div>
        </main>
    );
}
