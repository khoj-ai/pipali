# Pipali Self-Query API
Default Base URL: `http://localhost:6464/api`. If not running there, find where the bun server is running yourself.

Query these with `shell_command`, using the bundled `bun` or `uv` runtimes (both are always on PATH). Use `execution_mode: "direct"` if hit sandbox restrictions and to perform unsafe/modifying operations.

## Conversations
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/conversations` | List all conversations. Supports `?q=<term>` for full-text search |
| GET | `/chat/:conversationId/history` | Full message history and metadata like cost, tokens |

Delegated conversations have `parentConversationId` set to the conversation that
started them. Read one with `inspect_task`, or pull just the parts you need from
`/chat/:conversationId/history`.

## Models
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/models` | All available chat models |
| GET | `/user/model` | User's currently selected model |

## Skills
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/skills` | All currently loaded skills, including hidden skills and visibility state |

## Automations
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/automations` | List all automations with trigger configs and status |
| GET | `/automations/:id` | Get automation details |
| POST | `/automations` | Create automation (see schema below) |
| PUT | `/automations/:id` | Update automation (see schema below) |
| DELETE | `/automations/:id` | Delete automation |
| POST | `/automations/:id/pause` | Pause automation |
| POST | `/automations/:id/resume` | Resume automation |
| POST | `/automations/:id/trigger` | Manually trigger automation |
| GET | `/automations/:id/executions` | Get execution history |

### Create/Update Automation Schema
```json
{
  "name": "Weekly report",
  "prompt": "Draft my weekly project update email",
  "triggerType": "cron",
  "triggerConfig": { "type": "cron", "schedule": "0 9 * * 1", "timezone": "America/New_York" }
}
```

- `triggerType`: `"cron"` or `null` (manual-only)
- `triggerConfig`: must match `triggerType`. Omit or set `null` for manual-only routines

## MCP Servers (Tool Integrations)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/mcp/servers` | List all MCP servers with connection status |
| GET | `/mcp/servers/:id` | Get server details |
| POST | `/mcp/servers` | Add MCP server (see schema below) |
| PUT | `/mcp/servers/:id` | Update server config (partial schema) |
| DELETE | `/mcp/servers/:id` | Remove MCP server |
| POST | `/mcp/servers/:id/test` | Test server connection |
| GET | `/mcp/servers/:id/tools` | List tools provided by a server |

### Create MCP Server Schema
```json
{
  "name": "github",
  "transportType": "stdio",
  "path": "@modelcontextprotocol/server-github",
  "description": "Interact with GitHub",
  "env": { "GITHUB_TOKEN": "ghp_..." },
  "confirmationMode": "unsafe_only",
  "enabled": true,
  "enabledTools": ["create_issue", "list_issues"]
}
```

- `name`: lowercase alphanumeric with dashes/underscores
- `transportType`: `"stdio"` or `"http"`
- `path`: command to run (stdio) or URL (http). The command is called with bunx/uvx/no prefix, auto-inferred
- `confirmationMode`: `"always"` (default), `"unsafe_only"`, or `"never"`
- `enabledTools`: optional whitelist of tool names. Omit to enable all

## Sandbox
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/user/sandbox` | Sandbox config (allowed/denied paths, domains) |

## Memory
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/memory/settings` | Get memory settings, including `memoriesEnabled` |
| PUT | `/memory/settings` | Update memory settings |
