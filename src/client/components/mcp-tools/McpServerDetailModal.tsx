import { useState, useEffect } from 'react';
import { X, Loader2, Trash2, Save, Play, Terminal, Globe, Plus, AlertCircle, CheckCircle } from 'lucide-react';
import type { McpServerInfo, McpTransportType, McpToolInfo, UpdateMcpServerInput } from '../../types/mcp';

interface McpServerDetailModalProps {
    server: McpServerInfo;
    onClose: () => void;
    onUpdated: () => void;
    onDeleted: () => void;
}

export function McpServerDetailModal({ server, onClose, onUpdated, onDeleted }: McpServerDetailModalProps) {
    const [description, setDescription] = useState(server.description || '');
    const [transportType, setTransportType] = useState<McpTransportType>(server.transportType);
    const [path, setPath] = useState(server.path);
    const [apiKey, setApiKey] = useState(server.apiKey || '');
    const [requiresConfirmation, setRequiresConfirmation] = useState(server.requiresConfirmation);
    const [enabled, setEnabled] = useState(server.enabled);
    const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(() => {
        if (!server.env) return [];
        return Object.entries(server.env).map(([key, value]) => ({ key, value }));
    });
    const [enabledToolsSet, setEnabledToolsSet] = useState<Set<string>>(() => {
        return new Set(server.enabledTools || []);
    });

    const [isSaving, setIsSaving] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isTesting, setIsTesting] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [tools, setTools] = useState<McpToolInfo[]>([]);
    const [isLoadingTools, setIsLoadingTools] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

    // Check if there are unsaved changes
    const hasChanges = (() => {
        if (description !== (server.description || '')) return true;
        if (transportType !== server.transportType) return true;
        if (path !== server.path) return true;
        if (apiKey !== (server.apiKey || '')) return true;
        if (requiresConfirmation !== server.requiresConfirmation) return true;
        if (enabled !== server.enabled) return true;

        // Check env vars
        const currentEnv: Record<string, string> = {};
        for (const { key, value } of envVars) {
            if (key.trim()) currentEnv[key.trim()] = value;
        }
        const serverEnv = server.env || {};
        if (Object.keys(currentEnv).length !== Object.keys(serverEnv).length) return true;
        for (const [key, value] of Object.entries(currentEnv)) {
            if (serverEnv[key] !== value) return true;
        }

        // Check enabled tools
        const originalEnabledTools = new Set(server.enabledTools || []);
        if (enabledToolsSet.size !== originalEnabledTools.size) return true;
        for (const tool of enabledToolsSet) {
            if (!originalEnabledTools.has(tool)) return true;
        }

        return false;
    })();

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    const handleAddEnvVar = () => {
        setEnvVars([...envVars, { key: '', value: '' }]);
    };

    const handleRemoveEnvVar = (index: number) => {
        setEnvVars(envVars.filter((_, i) => i !== index));
    };

    const handleEnvVarChange = (index: number, field: 'key' | 'value', value: string) => {
        const newEnvVars = [...envVars];
        const envVar = newEnvVars[index];
        if (envVar) {
            envVar[field] = value;
            setEnvVars(newEnvVars);
        }
    };

    const handleToggleTool = (toolName: string) => {
        const newSet = new Set(enabledToolsSet);
        if (newSet.has(toolName)) {
            newSet.delete(toolName);
        } else {
            newSet.add(toolName);
        }
        setEnabledToolsSet(newSet);
    };

    const handleToggleAllTools = (enable: boolean) => {
        if (enable) {
            setEnabledToolsSet(new Set(tools.map(t => t.name)));
        } else {
            setEnabledToolsSet(new Set());
        }
    };

    const handleSave = async () => {
        if (!hasChanges) return;

        setIsSaving(true);
        setError(null);

        const env: Record<string, string> = {};
        for (const { key, value } of envVars) {
            if (key.trim()) env[key.trim()] = value;
        }

        const input: UpdateMcpServerInput = {
            description: description || undefined,
            transportType,
            path,
            apiKey: apiKey || undefined,
            env: Object.keys(env).length > 0 ? env : undefined,
            requiresConfirmation,
            enabled,
            enabledTools: enabledToolsSet.size > 0 ? Array.from(enabledToolsSet) : undefined,
        };

        try {
            const res = await fetch(`/api/mcp/servers/${server.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });

            if (res.ok) {
                onUpdated();
                onClose();
            } else {
                const data = await res.json();
                setError(data.error || 'Failed to update server');
            }
        } catch (e) {
            setError('Failed to update server');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async () => {
        setIsDeleting(true);
        setError(null);

        try {
            const res = await fetch(`/api/mcp/servers/${server.id}`, {
                method: 'DELETE',
            });

            if (res.ok) {
                onDeleted();
            } else {
                const data = await res.json();
                setError(data.error || 'Failed to delete server');
            }
        } catch (e) {
            setError('Failed to delete server');
        } finally {
            setIsDeleting(false);
            setShowDeleteConfirm(false);
        }
    };

    const handleTestConnection = async () => {
        setIsTesting(true);
        setError(null);
        setTestResult(null);
        setTools([]);

        try {
            const res = await fetch(`/api/mcp/servers/${server.id}/test`, {
                method: 'POST',
            });

            const data = await res.json();

            if (data.success) {
                setTestResult({
                    success: true,
                    message: `Connection successful! Found ${data.toolCount} tool(s).`,
                });
                // Also load tools
                await loadTools();
            } else {
                setTestResult({
                    success: false,
                    message: data.error || 'Connection failed',
                });
            }
        } catch (e) {
            setTestResult({
                success: false,
                message: 'Failed to test connection',
            });
        } finally {
            setIsTesting(false);
        }
    };

    const loadTools = async () => {
        setIsLoadingTools(true);
        try {
            const res = await fetch(`/api/mcp/servers/${server.id}/tools`);
            if (res.ok) {
                const data = await res.json();
                setTools(data.tools || []);
            }
        } catch (e) {
            console.error('Failed to load tools', e);
        } finally {
            setIsLoadingTools(false);
        }
    };

    const handleBackdropClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    };

    return (
        <div className="modal-backdrop" onClick={handleBackdropClick}>
            <div className="modal mcp-server-modal mcp-server-detail-modal">
                <div className="modal-header">
                    <h2>{server.name}</h2>
                    <button onClick={onClose} className="modal-close">
                        <X size={18} />
                    </button>
                </div>

                <div className="mcp-server-detail-content">
                    <div className="mcp-server-form">
                        <div className="form-group">
                            <label htmlFor="server-description">Description</label>
                            <input
                                id="server-description"
                                type="text"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="What this server provides"
                            />
                        </div>

                        <div className="form-group">
                            <label>Transport Type</label>
                            <div className="transport-type-selector compact">
                                <button
                                    type="button"
                                    className={`transport-type-btn ${transportType === 'stdio' ? 'active' : ''}`}
                                    onClick={() => setTransportType('stdio')}
                                >
                                    <Terminal size={16} />
                                    <span>stdio</span>
                                </button>
                                <button
                                    type="button"
                                    className={`transport-type-btn ${transportType === 'sse' ? 'active' : ''}`}
                                    onClick={() => setTransportType('sse')}
                                >
                                    <Globe size={16} />
                                    <span>HTTP/SSE</span>
                                </button>
                            </div>
                        </div>

                        <div className="form-group">
                            <label htmlFor="server-path">
                                {transportType === 'stdio' ? 'Command / Package' : 'Server URL'}
                            </label>
                            <input
                                id="server-path"
                                type="text"
                                value={path}
                                onChange={(e) => setPath(e.target.value)}
                            />
                        </div>

                        {transportType === 'sse' && (
                            <div className="form-group">
                                <label htmlFor="server-api-key">API Key</label>
                                <input
                                    id="server-api-key"
                                    type="password"
                                    value={apiKey}
                                    onChange={(e) => setApiKey(e.target.value)}
                                    placeholder="Optional authentication key"
                                />
                            </div>
                        )}

                        {transportType === 'stdio' && (
                            <div className="form-group">
                                <label>Environment Variables</label>
                                <div className="env-vars-list">
                                    {envVars.map((envVar, index) => (
                                        <div key={index} className="env-var-row">
                                            <input
                                                type="text"
                                                value={envVar.key}
                                                onChange={(e) => handleEnvVarChange(index, 'key', e.target.value)}
                                                placeholder="KEY"
                                                className="env-var-key"
                                            />
                                            <span className="env-var-separator">=</span>
                                            <input
                                                type="text"
                                                value={envVar.value}
                                                onChange={(e) => handleEnvVarChange(index, 'value', e.target.value)}
                                                placeholder="value"
                                                className="env-var-value"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => handleRemoveEnvVar(index)}
                                                className="btn-icon-sm"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    ))}
                                    <button
                                        type="button"
                                        onClick={handleAddEnvVar}
                                        className="btn-text add-env-var-btn"
                                    >
                                        <Plus size={14} />
                                        <span>Add variable</span>
                                    </button>
                                </div>
                            </div>
                        )}

                        <div className="form-group form-checkbox-group">
                            <label className="checkbox-label">
                                <input
                                    type="checkbox"
                                    checked={requiresConfirmation}
                                    onChange={(e) => setRequiresConfirmation(e.target.checked)}
                                />
                                <span>Require confirmation for tool calls</span>
                            </label>
                        </div>

                        <div className="form-group form-checkbox-group">
                            <label className="checkbox-label">
                                <input
                                    type="checkbox"
                                    checked={enabled}
                                    onChange={(e) => setEnabled(e.target.checked)}
                                />
                                <span>Enable server</span>
                            </label>
                        </div>

                        {/* Test Connection Section */}
                        <div className="mcp-test-section">
                            <button
                                type="button"
                                onClick={handleTestConnection}
                                disabled={isTesting}
                                className="btn-secondary"
                            >
                                {isTesting ? (
                                    <>
                                        <Loader2 size={16} className="spinning" />
                                        <span>Testing...</span>
                                    </>
                                ) : (
                                    <>
                                        <Play size={16} />
                                        <span>Test Connection</span>
                                    </>
                                )}
                            </button>

                            {testResult && (
                                <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
                                    {testResult.success ? (
                                        <CheckCircle size={14} />
                                    ) : (
                                        <AlertCircle size={14} />
                                    )}
                                    <span>{testResult.message}</span>
                                </div>
                            )}
                        </div>

                        {/* Tools List */}
                        {tools.length > 0 && (
                            <div className="mcp-tools-list">
                                <div className="mcp-tools-list-header">
                                    <h4>Available Tools ({tools.length})</h4>
                                    <div className="mcp-tools-list-actions">
                                        <button
                                            type="button"
                                            onClick={() => handleToggleAllTools(true)}
                                            className="btn-text-sm"
                                            disabled={enabledToolsSet.size === tools.length}
                                        >
                                            Enable All
                                        </button>
                                        <span className="divider">|</span>
                                        <button
                                            type="button"
                                            onClick={() => handleToggleAllTools(false)}
                                            className="btn-text-sm"
                                            disabled={enabledToolsSet.size === 0}
                                        >
                                            Disable All
                                        </button>
                                    </div>
                                </div>
                                <p className="mcp-tools-help">
                                    {enabledToolsSet.size === 0
                                        ? 'All tools are enabled by default. Toggle individual tools to restrict access.'
                                        : `${enabledToolsSet.size} of ${tools.length} tools enabled.`}
                                </p>
                                <div className="tools-list">
                                    {tools.map((tool) => {
                                        const isEnabled = enabledToolsSet.size === 0 || enabledToolsSet.has(tool.name);
                                        return (
                                            <div
                                                key={tool.namespacedName}
                                                className={`tool-item ${isEnabled ? 'enabled' : 'disabled'}`}
                                            >
                                                <label className="tool-toggle">
                                                    <input
                                                        type="checkbox"
                                                        checked={enabledToolsSet.has(tool.name)}
                                                        onChange={() => handleToggleTool(tool.name)}
                                                    />
                                                    <code className="tool-name">{tool.name}</code>
                                                </label>
                                                <p className="tool-description">{tool.description}</p>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {isLoadingTools && (
                            <div className="mcp-tools-loading">
                                <Loader2 size={16} className="spinning" />
                                <span>Loading tools...</span>
                            </div>
                        )}

                        {error && <div className="form-error">{error}</div>}
                    </div>
                </div>

                <div className="modal-actions modal-actions-split">
                    <div className="modal-actions-left">
                        {showDeleteConfirm ? (
                            <>
                                <span className="delete-confirm-text">Delete this server?</span>
                                <button
                                    type="button"
                                    onClick={handleDelete}
                                    disabled={isDeleting}
                                    className="btn-danger"
                                >
                                    {isDeleting ? (
                                        <Loader2 size={16} className="spinning" />
                                    ) : (
                                        'Yes, Delete'
                                    )}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setShowDeleteConfirm(false)}
                                    className="btn-secondary"
                                >
                                    Cancel
                                </button>
                            </>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setShowDeleteConfirm(true)}
                                className="btn-danger-outline"
                            >
                                <Trash2 size={16} />
                                <span>Delete</span>
                            </button>
                        )}
                    </div>
                    <div className="modal-actions-right">
                        <button type="button" onClick={onClose} className="btn-secondary">
                            Close
                        </button>
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={!hasChanges || isSaving}
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
                                    <span>Save Changes</span>
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
