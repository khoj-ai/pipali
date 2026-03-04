# Pipali Self-Query API
Default Base URL: `http://localhost:6464/api`. If not running there, find where the bun server is running yourself.

Use curl via `shell_command` or equivalent tools. Use `execution_mode: "direct"` to query these endpoints if hit sandbox restrictions and to perform unsafe/modifying operations.

## Conversations
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/conversations` | List all conversations. Supports `?q=<term>` for full-text search |
| GET | `/chat/:conversationId/history` | Full message history and metadata like cost, tokens |

## Models
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/models` | All available chat models |
| GET | `/user/model` | User's currently selected model |

## User
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/user/context` | User profile (name, location, instructions) from ~/.pipali/USER.md. Always in your system prompt too |

## Skills
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/skills` | All installed skills with descriptions from ~/.pipali/skills/**/SKILL.md |

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
- `transportType`: `"stdio"` or `"sse"`
- `path`: command to run (stdio) or URL (sse). The command is called with bunx/uvx/no prefix, auto-inferred
- `confirmationMode`: `"always"` (default), `"unsafe_only"`, or `"never"`
- `enabledTools`: optional whitelist of tool names. Omit to enable all

## Sandbox
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/user/sandbox` | Sandbox config (allowed/denied paths, domains) |