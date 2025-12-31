import { useState, useEffect } from 'react';
import { X, Loader2, Terminal, Globe, Plus, Trash2 } from 'lucide-react';
import type { McpTransportType, CreateMcpServerInput } from '../../types/mcp';
import { apiFetch } from '../../utils/api';

interface CreateMcpServerModalProps {
    onClose: () => void;
    onCreated: () => void;
}

export function CreateMcpServerModal({ onClose, onCreated }: CreateMcpServerModalProps) {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [transportType, setTransportType] = useState<McpTransportType>('stdio');
    const [path, setPath] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [requiresConfirmation, setRequiresConfirmation] = useState(true);
    const [enabled, setEnabled] = useState(true);
    const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);

    const [isCreating, setIsCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canSubmit = name.length > 0 && path.length > 0 && !isCreating;

    // Handle Escape key to close modal
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
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

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;

        setIsCreating(true);
        setError(null);

        // Build env object from envVars array
        const env: Record<string, string> = {};
        for (const { key, value } of envVars) {
            if (key.trim()) {
                env[key.trim()] = value;
            }
        }

        const input: CreateMcpServerInput = {
            name: name.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
            description: description || undefined,
            transportType,
            path,
            apiKey: apiKey || undefined,
            env: Object.keys(env).length > 0 ? env : undefined,
            requiresConfirmation,
            enabled,
        };

        try {
            const res = await apiFetch('/api/mcp/servers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });

            if (res.ok) {
                onCreated();
            } else {
                const data = await res.json();
                setError(data.error || 'Failed to create MCP server');
            }
        } catch (e) {
            setError('Failed to create MCP server');
        } finally {
            setIsCreating(false);
        }
    };

    const handleBackdropClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    };

    return (
        <div className="modal-backdrop" onClick={handleBackdropClick}>
            <div className="modal mcp-server-modal">
                <div className="modal-header">
                    <h2>Add MCP Server</h2>
                    <button onClick={onClose} className="modal-close">
                        <X size={18} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="mcp-server-form">
                    <div className="form-group">
                        <label htmlFor="server-name">Name *</label>
                        <input
                            id="server-name"
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}
                            placeholder="my-mcp-server"
                            autoFocus
                        />
                        <span className="form-hint">Used to namespace tools (e.g., my-mcp-server/tool-name)</span>
                    </div>

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
                        <label>Transport Type *</label>
                        <div className="transport-type-selector">
                            <button
                                type="button"
                                className={`transport-type-btn ${transportType === 'stdio' ? 'active' : ''}`}
                                onClick={() => setTransportType('stdio')}
                            >
                                <Terminal size={16} />
                                <span>stdio</span>
                                <span className="transport-hint">Local script or npm package</span>
                            </button>
                            <button
                                type="button"
                                className={`transport-type-btn ${transportType === 'sse' ? 'active' : ''}`}
                                onClick={() => setTransportType('sse')}
                            >
                                <Globe size={16} />
                                <span>HTTP/SSE</span>
                                <span className="transport-hint">Remote server endpoint</span>
                            </button>
                        </div>
                    </div>

                    <div className="form-group">
                        <label htmlFor="server-path">
                            {transportType === 'stdio' ? 'Command / Package' : 'Server URL'} *
                        </label>
                        <input
                            id="server-path"
                            type="text"
                            value={path}
                            onChange={(e) => setPath(e.target.value)}
                            placeholder={
                                transportType === 'stdio'
                                    ? '@modelcontextprotocol/server-filesystem'
                                    : 'https://mcp.example.com/sse'
                            }
                        />
                        <span className="form-hint">
                            {transportType === 'stdio'
                                ? 'npm package name, path to .py/.js script, or executable'
                                : 'HTTP(S) endpoint URL'}
                        </span>
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
                        <span className="form-hint">When enabled, the user must approve each tool call from this server</span>
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
                        <span className="form-hint">Disabled servers won't connect or provide tools</span>
                    </div>

                    {error && <div className="form-error">{error}</div>}

                    <div className="modal-actions">
                        <button type="button" onClick={onClose} className="btn-secondary">
                            Cancel
                        </button>
                        <button type="submit" disabled={!canSubmit} className="btn-primary">
                            {isCreating ? (
                                <>
                                    <Loader2 size={16} className="spinning" />
                                    <span>Adding...</span>
                                </>
                            ) : (
                                'Add Server'
                            )}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
