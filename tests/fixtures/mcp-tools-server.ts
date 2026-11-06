// Stdio MCP server exposing three no-op tools, for specs that need a server with tools to select.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'fixture-tools', version: '1.0.0' });
for (const name of ['read_note', 'write_note', 'delete_note']) {
    server.tool(name, `${name} fixture tool, also exposed as ${name}_under_a_long_unbroken_identifier_with_no_spaces`, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
}

await server.connect(new StdioServerTransport());
