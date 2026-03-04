---
name: introspect
description: Always read this skill before answering questions about your capabilities, UI, settings, state including past chats/routines/skills/tools. Use to help user configure you, onboard, navigate UI and troubleshoot issues.
---

# Introspect
Get grounded answers about your capabilities and configuration - reference your actual UI, API and code. Explain using language suitable to the user's capabilities (e.g limit technical jargon when interacting with non-technical users).

## Architecture Overview
You run as a desktop app. Pipali code is open-source at https://github.com/khoj-ai/pipali. Stack: Tauri desktop shell (Rust) + Bun server (as tauri sidecar) + React frontend

## Query Live State
Query your own API to answer questions about your current setup and manage state. You can use curl via `shell_command` or equivalent tools. Use `execution_mode: "direct"` if you hit sandbox restrictions.

See `references/api.md` for API endpoints to manage mcp servers, automations/routines, skills, chats, user preferences, sandbox settings etc.

### Common Introspection Patterns
The bun server is usually at: `http://localhost:6464`. If not, find your bun server url first.

- What previous conversations have I had about surfing?: GET /api/conversations?q=surfing
- What tools are connected?:  GET /api/mcp/servers
- What automations are set up?: GET /api/automations
- What models are available?: GET /api/models
- What shell sandbox restrictions apply?: GET /api/user/sandbox

## Key Paths
| Purpose | Path |
|---------|------|
| User profile | `~/.pipali/USER.md` |
| Skills directory | `~/.pipali/skills/` |
| App data (macOS) | `~/Library/Application Support/pipali/` |
| App data (Linux) | `~/.local/share/pipali/` |
| App data (Windows) | `%APPDATA%/pipali/` |
| Database | `<app-data>/db/` (PGlite, an embedded wasm postgres) |
| Logs (macOS) | `~/Library/Logs/pipali/` |

## UI Navigation
The app has a navigation sidebar on the left and a main content area.

### Sidebar
- Skills — view, manage installed skills to give you specialized knowledge and workflows
- Routines — view, manage scheduled/triggered tasks for you to work on (~cron)
- Tools — view, manage MCP server integrations to give you tools for work
- Settings — user profile, sandbox permissions tabs
- Conversation list — recent chats. Button below to open modal to view and search all chats
- User menu (bottom) — account, theme toggle, logout

### Home Page
- New tasks/chats are started from the home page
- Navigate by clicking the pipali name+icon on top pane of main content area
- A live overview of all tasks being worked on, awaiting user confirmation, completed (but not yet viewed by user) or pinned by user is visible as task cards with progress indicators

### Chat
- Main body has chat history as rows of user message, trajectory dropdown, your message
- Message input is at the bottom with file attachment, llm model switcher
- Each tool step streams in real-time via WebSocket as you work
- Trajectory dropdown can be toggled between collapsed, outline and expanded views to vary thoughts, tool call, tool result details
- User confirmations are automatically triggered for unsafe operations. They appear inline when conversation open and as toasts when on other pages

### Settings Page
- **Profile**: User name, location, custom instructions by user for you to always load/remember. Stored in ~/.pipali/USER.md
- **Permissions**: Configure which files/dirs require user confirmation to read/write from your sandboxed shell and other tools

### Routines Page
- Create automations with cron schedules (e.g., "every Monday at 9am")
- Each automation has a single conversation with its execution history
- Can be activated/deactivated, run manually, or deleted
- Routines is the user facing name of the automations feature in code
- Routines allow user to assign scheduled tasks for you to work on or reusable prompts that they can trigger manually

### Tools Page
- Add MCP servers (stdio or SSE transport). 
- Each server is shown as a card with name, description, connection status, chosen confirmation mode.
- On opening server card user can edit server description, connection command (the command is called with bunx/uvx/no prefix auto inferred based on syntax), transport type (stdio, http/sse), confirmation mode (i.e if to request user confirmation (always, unsafe only, never) when you call the server tools), which tools from the mcp server to enable, test connection button

### Skills Page
View, create, update, delete skills

## Source Code
For deep implementation questions, read the code in the Pipali GitHub repo. Raw file URLs pattern: `https://raw.githubusercontent.com/khoj-ai/pipali/main/<path>`

Key source files:
- Server entry: `src/server/index.ts`
- API routes: `src/server/routes/api.ts`
- Agent loop: `src/server/processor/director/index.ts`
- System prompt: `src/server/processor/director/prompts.ts`
- DB schema: `src/server/db/schema.ts`
- Frontend app: `src/client/app.tsx`
- Sidebar: `src/client/components/layout/Sidebar.tsx`
- Settings: `src/client/components/settings/SettingsPage.tsx`