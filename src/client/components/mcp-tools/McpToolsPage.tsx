import { useState, useEffect } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { McpServerInfo } from '../../types/mcp';
import { McpServerCard } from './McpServerCard';
import { CreateMcpServerModal } from './CreateMcpServerModal';
import { McpServerDetailModal } from './McpServerDetailModal';
import { McpToolsEmpty } from './McpToolsEmpty';
import { apiFetch } from '../../utils/api';

export function McpToolsPage() {
    const [servers, setServers] = useState<McpServerInfo[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isReloading, setIsReloading] = useState(false);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [selectedServer, setSelectedServer] = useState<McpServerInfo | null>(null);

    useEffect(() => {
        fetchServers();
    }, []);

    const fetchServers = async () => {
        try {
            const res = await apiFetch('/api/mcp/servers');
            if (res.ok) {
                const data = await res.json();
                setServers(data.servers || []);
            }
        } catch (e) {
            console.error('Failed to fetch MCP servers', e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleReload = async () => {
        setIsReloading(true);
        try {
            // First reload servers on the backend
            await apiFetch('/api/mcp/reload', { method: 'POST' });
            // Then fetch updated list
            await fetchServers();
        } catch (e) {
            console.error('Failed to reload MCP servers', e);
        } finally {
            setIsReloading(false);
        }
    };

    const handleServerCreated = () => {
        setShowCreateModal(false);
        fetchServers();
    };

    const handleServerUpdated = () => {
        fetchServers();
    };

    const handleServerDeleted = () => {
        setSelectedServer(null);
        fetchServers();
    };

    if (isLoading) {
        return (
            <main className="main-content">
                <div className="messages-container">
                    <div className="mcp-tools-gallery">
                        <div className="mcp-tools-loading">Loading MCP servers...</div>
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main className="main-content">
            <div className="messages-container">
                <div className="mcp-tools-gallery">
                    <div className="mcp-tools-header">
                        <div className="mcp-tools-header-left">
                            <h2>MCP Tool Servers</h2>
                            <span className="mcp-tools-count">{servers.length}</span>
                        </div>
                        <div className="mcp-tools-header-actions">
                            <button
                                onClick={() => setShowCreateModal(true)}
                                className="mcp-tools-create-btn"
                            >
                                <Plus size={16} />
                                <span>Add Server</span>
                            </button>
                            <button
                                onClick={handleReload}
                                className="mcp-tools-refresh-btn"
                                disabled={isReloading}
                                title="Reload all servers"
                            >
                                <RefreshCw size={16} className={isReloading ? 'spinning' : ''} />
                            </button>
                        </div>
                    </div>

                    {servers.length === 0 ? (
                        <McpToolsEmpty onAddServer={() => setShowCreateModal(true)} />
                    ) : (
                        <div className="mcp-tools-cards">
                            {servers.map((server) => (
                                <McpServerCard
                                    key={server.id}
                                    server={server}
                                    onClick={() => setSelectedServer(server)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {showCreateModal && (
                <CreateMcpServerModal
                    onClose={() => setShowCreateModal(false)}
                    onCreated={handleServerCreated}
                />
            )}

            {selectedServer && (
                <McpServerDetailModal
                    server={selectedServer}
                    onClose={() => setSelectedServer(null)}
                    onUpdated={handleServerUpdated}
                    onDeleted={handleServerDeleted}
                />
            )}
        </main>
    );
}
