// Stdio MCP server that writes to stderr, for tests of what the client does with it.
// `refuse` reports an error and exits instead of serving. The `crash` tool reports an
// error and exits when called.
import fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

if (process.argv[2] === 'refuse') {
    fs.writeSync(2, 'error: EXAMPLE_API_KEY is not set\n');
    process.exit(1);
}

const server = new McpServer({ name: 'fixture-stderr', version: '1.0.0' });
server.tool('crash', 'Report an error on stderr and exit', async () => {
    fs.writeSync(2, 'fatal: out of memory\n');
    process.exit(1);
});

await server.connect(new StdioServerTransport());
