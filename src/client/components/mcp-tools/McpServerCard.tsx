import { Terminal, Globe, CheckCircle, XCircle, AlertCircle, Loader2, ChevronRight } from 'lucide-react';
import type { McpServerInfo, McpConnectionStatus } from '../../types/mcp';

interface McpServerCardProps {
    server: McpServerInfo;
    onClick?: () => void;
}

function getStatusIcon(status: McpConnectionStatus | undefined, enabled: boolean) {
    if (!enabled) {
        return <XCircle size={12} className="status-icon disabled" />;
    }

    switch (status) {
        case 'connected':
            return <CheckCircle size={12} className="status-icon connected" />;
        case 'connecting':
            return <Loader2 size={12} className="status-icon connecting spinning" />;
        case 'error':
            return <AlertCircle size={12} className="status-icon error" />;
        default:
            return <XCircle size={12} className="status-icon disconnected" />;
    }
}

function getStatusText(status: McpConnectionStatus | undefined, enabled: boolean): string {
    if (!enabled) return 'disabled';
    return status || 'disconnected';
}

export function McpServerCard({ server, onClick }: McpServerCardProps) {
    const TransportIcon = server.transportType === 'stdio' ? Terminal : Globe;
    const status = server.connectionStatus;

    return (
        <div
            className={`mcp-server-card ${!server.enabled ? 'disabled' : ''}`}
            onClick={onClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClick?.();
                }
            }}
        >
            <div className="mcp-server-card-header">
                <div className="mcp-server-transport-badge">
                    <TransportIcon size={12} />
                    <span>{server.transportType}</span>
                </div>
                <div className={`mcp-server-status-badge ${getStatusText(status, server.enabled)}`}>
                    {getStatusIcon(status, server.enabled)}
                    <span>{getStatusText(status, server.enabled)}</span>
                </div>
            </div>

            <h3 className="mcp-server-card-title">{server.name}</h3>

            {server.description && (
                <p className="mcp-server-card-description">{server.description}</p>
            )}

            <div className="mcp-server-card-path">
                <code>{server.path}</code>
            </div>

            {server.lastError && (
                <div className="mcp-server-card-error">
                    <AlertCircle size={12} />
                    <span>{server.lastError}</span>
                </div>
            )}

            <div className="mcp-server-card-footer">
                <div className="mcp-server-meta">
                    {server.confirmationMode !== 'never' && (
                        <span className="mcp-server-confirmation-badge" title={
                            server.confirmationMode === 'always'
                                ? 'Confirmation required for all operations'
                                : 'Confirmation required for write operations'
                        }>
                            {server.confirmationMode === 'always' ? 'Confirm all' : 'Confirm writes'}
                        </span>
                    )}
                </div>
                <ChevronRight size={14} />
            </div>
        </div>
    );
}
