// Empty state when no MCP servers are configured

import React from 'react';
import { Wrench } from 'lucide-react';

interface McpToolsEmptyProps {
    onAddServer: () => void;
}

export function McpToolsEmpty({ onAddServer }: McpToolsEmptyProps) {
    return (
        <div className="empty-state mcp-tools-empty">
            <Wrench className="empty-icon" size={32} strokeWidth={1.5} />
            <h2>No Tool Servers</h2>
            <p>Connect MCP servers to extend Panini with external tools.</p>
            <p className="empty-hint">
                MCP (Model Context Protocol) servers provide additional capabilities like:
            </p>
            <ul className="mcp-capabilities">
                <li>Database queries</li>
                <li>API integrations</li>
                <li>Custom automations</li>
                <li>External services</li>
            </ul>
            <button className="btn-primary" onClick={onAddServer}>
                Add Your First Server
            </button>
        </div>
    );
}
