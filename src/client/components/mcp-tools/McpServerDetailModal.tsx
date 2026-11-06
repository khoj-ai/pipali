import { useState, useEffect, useRef } from 'react';
import { X, Loader2, Trash2, Save, Play, Terminal, Globe, Plus, AlertCircle, CheckCircle, KeyRound, ShieldCheck, CircleSlash } from 'lucide-react';
import type { McpServerInfo, McpTransportType, McpConfirmationMode, McpAuthType, McpToolInfo, UpdateMcpServerInput } from '../../types/mcp';
import { apiFetch } from '../../utils/api';
import { countEnabledTools, isToolEnabled, selectOnly, toggleTool } from '../../utils/mcp-tools';
import { useTranslation } from 'react-i18next';
import { McpOAuthAdvancedSettings, isGoogleApisUrl, parseOAuthScopes } from './McpOAuthAdvancedSettings';

interface McpServerDetailModalProps {
    server: McpServerInfo;
    onClose: () => void;
    onUpdated: () => void;
    onDeleted: () => void;
}

export function McpServerDetailModal({ server, onClose, onUpdated, onDeleted }: McpServerDetailModalProps) {
    const [description, setDescription] = useState(server.description || '');
    const [transportType, setTransportType] = useState<McpTransportType>(server.transportType);
    const [authType, setAuthType] = useState<McpAuthType>(server.authType ?? (server.apiKey ? 'bearer' : 'none'));
    const [path, setPath] = useState(server.path);
    const [apiKey, setApiKey] = useState(server.apiKey || '');
    const [oauthClientId, setOAuthClientId] = useState(server.oauthClientId || '');
    const [oauthClientSecret, setOAuthClientSecret] = useState(server.oauthClientSecret || '');
    const [oauthScopesText, setOAuthScopesText] = useState((server.oauthScopes || []).join('\n'));
    const [isAdvancedOpen, setIsAdvancedOpen] = useState(() => isGoogleApisUrl(server.path));
    const [confirmationMode, setConfirmationMode] = useState<McpConfirmationMode>(server.confirmationMode);
    const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(() => {
        if (!server.env) return [];
        return Object.entries(server.env).map(([key, value]) => ({ key, value }));
    });
    const [enabledToolsSet, setEnabledToolsSet] = useState<Set<string>>(() => {
        return new Set(server.enabledTools || []);
    });

    const { t } = useTranslation();

    const [isSaving, setIsSaving] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isTesting, setIsTesting] = useState(false);
    const [isReconnectingOAuth, setIsReconnectingOAuth] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [tools, setTools] = useState<McpToolInfo[]>([]);
    const [isLoadingTools, setIsLoadingTools] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
    const previousOAuthStatus = useRef(server.oauthStatus);

    // Check if there are unsaved changes
    const hasChanges = (() => {
        if (description !== (server.description || '')) return true;
        if (transportType !== server.transportType) return true;
        if (authType !== (server.authType ?? (server.apiKey ? 'bearer' : 'none'))) return true;
        if (path !== server.path) return true;
        if (authType === 'bearer' && apiKey !== (server.apiKey || '')) return true;
        if (oauthClientId !== (server.oauthClientId || '')) return true;
        if (oauthClientSecret !== (server.oauthClientSecret || '')) return true;
        if (parseOAuthScopes(oauthScopesText).join('\n') !== (server.oauthScopes || []).join('\n')) return true;
        if (confirmationMode !== server.confirmationMode) return true;

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

    useEffect(() => {
        if (transportType === 'http' && isGoogleApisUrl(path)) {
            setIsAdvancedOpen(true);
        }
    }, [path, transportType]);

    useEffect(() => {
        const previousStatus = previousOAuthStatus.current;
        if (server.authType === 'oauth' && server.oauthStatus === 'connected' && previousStatus !== 'connected') {
            setError(null);
            setTestResult({
                success: true,
                message: t('mcpTools.oauthConnected'),
            });
        }
        previousOAuthStatus.current = server.oauthStatus;
    }, [server.authType, server.oauthStatus, t]);

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

    const toolNames = tools.map(t => t.name);
    const enabledToolCount = countEnabledTools(enabledToolsSet, toolNames);

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
            authType: transportType === 'http' ? authType : 'none',
            apiKey: transportType === 'http' && authType === 'bearer' ? apiKey || undefined : undefined,
            oauthClientId: transportType === 'http' ? oauthClientId : undefined,
            oauthClientSecret: transportType === 'http' ? oauthClientSecret : undefined,
            oauthScopes: transportType === 'http' ? parseOAuthScopes(oauthScopesText) : undefined,
            env: Object.keys(env).length > 0 ? env : undefined,
            confirmationMode,
            enabledTools: Array.from(enabledToolsSet),
        };

        try {
            const res = await apiFetch(`/api/mcp/servers/${server.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });

            if (res.ok) {
                onUpdated();
                onClose();
            } else {
                const data = await res.json();
                setError(data.error || t('mcpTools.failedToUpdateServer'));
            }
        } catch (e) {
            setError(t('mcpTools.failedToUpdateServer'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async () => {
        setIsDeleting(true);
        setError(null);

        try {
            const res = await apiFetch(`/api/mcp/servers/${server.id}`, {
                method: 'DELETE',
            });

            if (res.ok) {
                onDeleted();
            } else {
                const data = await res.json();
                setError(data.error || t('mcpTools.failedToDeleteServer'));
            }
        } catch (e) {
            setError(t('mcpTools.failedToDeleteServer'));
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
            const res = await apiFetch(`/api/mcp/servers/${server.id}/test`, {
                method: 'POST',
            });

            const data = await res.json();

            if (data.success) {
                setTestResult({
                    success: true,
                    message: t('mcpTools.connectionSuccessful', { count: data.toolCount }),
                });
                // Also load tools
                await loadTools();
            } else {
                setTestResult({
                    success: false,
                    message: data.error || t('mcpTools.connectionFailed'),
                });
            }
        } catch (e) {
            setTestResult({
                success: false,
                message: t('mcpTools.failedToTestConnection'),
            });
        } finally {
            setIsTesting(false);
        }
    };

    const handleReconnectOAuth = async () => {
        setIsReconnectingOAuth(true);
        setError(null);
        setTestResult(null);

        try {
            const res = await apiFetch(`/api/mcp/servers/${server.id}/oauth/reconnect`, {
                method: 'POST',
            });
            const data = await res.json();
            if (res.ok && data.success) {
                setTestResult({
                    success: true,
                    message: t('mcpTools.oauthFlowStarted'),
                });
                onUpdated();
            } else {
                setError(data.error || t('mcpTools.oauthReconnectFailed'));
            }
        } catch {
            setError(t('mcpTools.oauthReconnectFailed'));
        } finally {
            setIsReconnectingOAuth(false);
        }
    };

    const loadTools = async () => {
        setIsLoadingTools(true);
        try {
            const res = await apiFetch(`/api/mcp/servers/${server.id}/tools`);
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
                            <label htmlFor="server-description">{t('mcpTools.description')}</label>
                            <input
                                id="server-description"
                                type="text"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder={t('mcpTools.descriptionDetailPlaceholder')}
                            />
                        </div>

                        <div className="form-group">
                            <label>{t('mcpTools.transportType')}</label>
                            <div className="transport-type-selector compact">
                                <button
                                    type="button"
                                    className={`transport-type-btn ${transportType === 'stdio' ? 'active' : ''}`}
                                    onClick={() => {
                                        setTransportType('stdio');
                                        setAuthType('none');
                                    }}
                                >
                                    <Terminal size={16} />
                                    <span>{t('mcpTools.stdio')}</span>
                                </button>
                                <button
                                    type="button"
                                    className={`transport-type-btn ${transportType === 'http' ? 'active' : ''}`}
                                    onClick={() => setTransportType('http')}
                                >
                                    <Globe size={16} />
                                    <span>{t('mcpTools.http')}</span>
                                </button>
                            </div>
                        </div>

                        <div className="form-group">
                            <label htmlFor="server-path">
                                {transportType === 'stdio' ? t('mcpTools.commandLabel') : t('mcpTools.serverUrlLabel')}
                            </label>
                            <input
                                id="server-path"
                                type="text"
                                value={path}
                                onChange={(e) => setPath(e.target.value)}
                            />
                        </div>

                        {transportType === 'http' && (
                            <>
                                <div className="form-group">
                                    <label>{t('mcpTools.authType')}</label>
                                    <div className="transport-type-selector compact">
                                        <button
                                            type="button"
                                            className={`transport-type-btn ${authType === 'none' ? 'active' : ''}`}
                                            onClick={() => setAuthType('none')}
                                        >
                                            <CircleSlash size={16} />
                                            <span>{t('mcpTools.authNone')}</span>
                                        </button>
                                        <button
                                            type="button"
                                            className={`transport-type-btn ${authType === 'bearer' ? 'active' : ''}`}
                                            onClick={() => setAuthType('bearer')}
                                        >
                                            <KeyRound size={16} />
                                            <span>{t('mcpTools.authBearer')}</span>
                                        </button>
                                        <button
                                            type="button"
                                            className={`transport-type-btn ${authType === 'oauth' ? 'active' : ''}`}
                                            onClick={() => setAuthType('oauth')}
                                        >
                                            <ShieldCheck size={16} />
                                            <span>{t('mcpTools.authOAuth')}</span>
                                        </button>
                                    </div>
                                    <span className="form-hint">
                                        {authType === 'oauth' ? t('mcpTools.authOAuthHint') : t('mcpTools.authTypeHint')}
                                    </span>
                                </div>

                                {authType === 'bearer' && (
                                    <div className="form-group">
                                        <label htmlFor="server-api-key">{t('mcpTools.apiKey')}</label>
                                        <input
                                            id="server-api-key"
                                            type="password"
                                            value={apiKey}
                                            onChange={(e) => setApiKey(e.target.value)}
                                            placeholder={t('mcpTools.apiKeyPlaceholder')}
                                        />
                                    </div>
                                )}

                                <McpOAuthAdvancedSettings
                                    isOpen={isAdvancedOpen}
                                    onToggle={() => setIsAdvancedOpen(open => !open)}
                                    oauthClientId={oauthClientId}
                                    onOAuthClientIdChange={setOAuthClientId}
                                    oauthClientSecret={oauthClientSecret}
                                    onOAuthClientSecretChange={setOAuthClientSecret}
                                    oauthScopesText={oauthScopesText}
                                    onOAuthScopesTextChange={setOAuthScopesText}
                                />

                                {authType === 'oauth' && (
                                    <div className="mcp-oauth-section">
                                        <div className={`mcp-oauth-status ${server.oauthStatus}`}>
                                            <ShieldCheck size={14} />
                                            <span>{t(`mcpTools.oauthStatus.${server.oauthStatus}` as any)}</span>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={handleReconnectOAuth}
                                            disabled={isReconnectingOAuth}
                                            className="btn-secondary"
                                        >
                                            {isReconnectingOAuth ? (
                                                <>
                                                    <Loader2 size={16} className="spinning" />
                                                    <span>{t('mcpTools.connectingOAuth')}</span>
                                                </>
                                            ) : (
                                                <>
                                                    <ShieldCheck size={16} />
                                                    <span>{t('mcpTools.reconnectOAuth')}</span>
                                                </>
                                            )}
                                        </button>
                                    </div>
                                )}
                            </>
                        )}

                        {transportType === 'stdio' && (
                            <div className="form-group">
                                <label>{t('mcpTools.envVars')}</label>
                                <div className="env-vars-list">
                                    {envVars.map((envVar, index) => (
                                        <div key={index} className="env-var-row">
                                            <input
                                                type="text"
                                                value={envVar.key}
                                                onChange={(e) => handleEnvVarChange(index, 'key', e.target.value)}
                                                placeholder={t('mcpTools.envKeyPlaceholder')}
                                                className="env-var-key"
                                            />
                                            <span className="env-var-separator">=</span>
                                            <input
                                                type="text"
                                                value={envVar.value}
                                                onChange={(e) => handleEnvVarChange(index, 'value', e.target.value)}
                                                placeholder={t('mcpTools.envValuePlaceholder')}
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
                                        <span>{t('mcpTools.addVariable')}</span>
                                    </button>
                                </div>
                            </div>
                        )}

                        <div className="form-group">
                            <label htmlFor="confirmation-mode">{t('mcpTools.confirmationMode')}</label>
                            <div className="confirmation-mode-selector">
                                <button
                                    type="button"
                                    className={`confirmation-mode-btn ${confirmationMode === 'always' ? 'active' : ''}`}
                                    onClick={() => setConfirmationMode('always')}
                                >
                                    {t('mcpTools.confirmAlwaysShort')}
                                </button>
                                <button
                                    type="button"
                                    className={`confirmation-mode-btn ${confirmationMode === 'unsafe_only' ? 'active' : ''}`}
                                    onClick={() => setConfirmationMode('unsafe_only')}
                                >
                                    {t('mcpTools.confirmUnsafeShort')}
                                </button>
                                <button
                                    type="button"
                                    className={`confirmation-mode-btn ${confirmationMode === 'never' ? 'active' : ''}`}
                                    onClick={() => setConfirmationMode('never')}
                                >
                                    {t('mcpTools.confirmNeverShort')}
                                </button>
                            </div>
                            <span className="form-hint">
                                {confirmationMode === 'always' && t('mcpTools.confirmAlwaysHint')}
                                {confirmationMode === 'unsafe_only' && t('mcpTools.confirmUnsafeHintLong')}
                                {confirmationMode === 'never' && t('mcpTools.confirmNeverHintShort')}
                            </span>
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
                                        <span>{t('mcpTools.testing')}</span>
                                    </>
                                ) : (
                                    <>
                                        <Play size={16} />
                                        <span>{t('mcpTools.testConnection')}</span>
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
                                    <h4>{t('mcpTools.availableTools', { count: tools.length })}</h4>
                                    <div className="mcp-tools-list-actions">
                                        <button
                                            type="button"
                                            onClick={() => setEnabledToolsSet(new Set())}
                                            className="btn-text-sm"
                                            disabled={enabledToolCount === tools.length}
                                        >
                                            {t('mcpTools.enableAll')}
                                        </button>
                                    </div>
                                </div>
                                <p className="mcp-tools-help">
                                    {enabledToolsSet.size === 0
                                        ? t('mcpTools.allToolsEnabled')
                                        : t('mcpTools.toolsEnabledCount', { enabled: enabledToolCount, total: tools.length })}
                                </p>
                                <div className="tools-list">
                                    {tools.map((tool) => {
                                        const isEnabled = isToolEnabled(enabledToolsSet, tool.name);
                                        const isLastEnabled = isEnabled && enabledToolCount === 1;
                                        return (
                                            <div
                                                key={tool.namespacedName}
                                                className={`tool-item ${isEnabled ? 'enabled' : 'disabled'}`}
                                            >
                                                <div className="tool-item-header">
                                                    <label className="tool-toggle">
                                                        <input
                                                            type="checkbox"
                                                            checked={isEnabled}
                                                            disabled={isLastEnabled}
                                                            onChange={() => setEnabledToolsSet(toggleTool(enabledToolsSet, toolNames, tool.name))}
                                                        />
                                                        <code className="tool-name">{tool.name}</code>
                                                    </label>
                                                    <button
                                                        type="button"
                                                        onClick={() => setEnabledToolsSet(selectOnly(toolNames, tool.name))}
                                                        className="btn-text-sm tool-only-btn"
                                                        disabled={isLastEnabled}
                                                        aria-label={t('mcpTools.enableOnlyTool', { name: tool.name })}
                                                    >
                                                        {t('mcpTools.enableOnly')}
                                                    </button>
                                                </div>
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
                                <span>{t('mcpTools.loadingTools')}</span>
                            </div>
                        )}

                        {error && <div className="form-error">{error}</div>}
                    </div>
                </div>

                <div className="modal-actions modal-actions-split">
                    <div className="modal-actions-left">
                        {showDeleteConfirm ? (
                            <>
                                <span className="delete-confirm-text">{t('mcpTools.deleteServerConfirm')}</span>
                                <button
                                    type="button"
                                    onClick={handleDelete}
                                    disabled={isDeleting}
                                    className="btn-danger"
                                >
                                    {isDeleting ? (
                                        <Loader2 size={16} className="spinning" />
                                    ) : (
                                        t('mcpTools.yesDelete')
                                    )}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setShowDeleteConfirm(false)}
                                    className="btn-secondary"
                                >
                                    {t('common.cancel')}
                                </button>
                            </>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setShowDeleteConfirm(true)}
                                className="btn-danger-outline"
                            >
                                <Trash2 size={16} />
                                <span>{t('common.delete')}</span>
                            </button>
                        )}
                    </div>
                    <div className="modal-actions-right">
                        <button type="button" onClick={onClose} className="btn-secondary">
                            {t('common.close')}
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
                                    <span>{t('mcpTools.savingShort')}</span>
                                </>
                            ) : (
                                <>
                                    <Save size={16} />
                                    <span>{t('mcpTools.saveChanges')}</span>
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
