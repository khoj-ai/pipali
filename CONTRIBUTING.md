# Contributing to Pipali

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) v1.2.19+
- A [Pipali](https://pipali.ai) account

### Install and Run

```bash
git clone https://github.com/khoj-ai/pipali.git
cd pipali
bun install
bun run dev
```

Open [http://localhost:6464](http://localhost:6464) in your browser.

### Desktop App

Build the Tauri desktop app (requires [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)):

```bash
bun run tauri:build:debug
```

### Environment Variables

Copy `.env.example` to `.env`. The app auto-loads `.env` via Bun — no dotenv needed.

### Tests

```bash
bun test             # Unit tests
bun run test:e2e     # E2E tests (Playwright)
```

### Database

Pipali uses [PGlite](https://pglite.dev) (embedded Postgres) with [Drizzle ORM](https://orm.drizzle.team/). The database is stored locally at `./pipali.db/`.

```bash
bun run db:generate  # Generate migration from schema changes
bun run db:migrate   # Apply migrations
```

## Development Guidelines

- **DRY**: Reuse functions, refactor for maintainability, use standards where available.
- **Test**: Update existing tests or add new ones to test important behaviors

## Project Structure

```
src/
├── client/          # React 19 frontend
├── server/          # Bun + Hono backend
│   ├── routes/      # HTTP & WebSocket endpoints
│   ├── processor/   # Agent system (director-actor pattern)
│   ├── db/          # PGlite database & Drizzle ORM
│   ├── automation/  # Scheduled task system
│   ├── skills/      # Custom agent behaviors
│   └── sandbox/     # Secure command execution
src-tauri/           # Tauri desktop app (Rust)
tests/               # Unit & E2E tests
drizzle/             # Database migrations
```

## Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Pipali App (Local)                    │
│                                                          │
│  ┌────────────┐   WebSocket    ┌───────────────────────┐ │
│  │   React    │◄──────────────►│    Bun + Hono Server  │ │
│  │  Frontend  │  (real-time)   │                       │ │
│  └────────────┘                │  ┌─────────────────┐  │ │
│                                │  │    Director     │  │ │
│                                │  │  (agent loop)   │  │ │
│                                │  └───────┬─────────┘  │ │
│                                │          │            │ │
│                                │  ┌───────▼─────────┐  │ │
│                                │  │     Actors      │  │ │
│                                │  │ (tool execution)│  │ │
│                                │  └───────┬─────────┘  │ │
│                                │          │            │ │
│                                │  ┌───────▼─────────┐  │ │
│                                │  │     PGlite      │  │ │
│                                │  │   (local db)    │  │ │
│                                │  └─────────────────┘  │ │
│                                └───────────┬───────────┘ │
└────────────────────────────────────────────┼─────────────┘
                                             │
                          ┌──────────────────▼─────────────────────┐
                          │        Pipali Platform (Remote)        │
                          │                                        │
                          │  • LLM API (Manage Context, Routing)   │
                          │  • Remote AI Tools (Browse Web)        │
                          │  • Auth (OAuth + token refresh)        │
                          │  • Billing, Usage, Teams               │
                          └────────────────────────────────────────┘
```


### Director-Actor Pattern

The agent uses a **director-actor pattern** for task orchestration:

- **Director** (`src/server/processor/director/`) — An async generator that loops: call LLM → get tool calls → execute tools → feed results back → repeat until the LLM responds without tool calls
- **Actors** (`src/server/processor/actor/`) — Individual tool implementations (file ops, shell, web search, MCP tools). Execute in parallel.
- **Research Runner** (`src/server/processor/research-runner.ts`) — Manages conversation persistence around the director loop

```
                    ┌────────────────────────┐
                    │        Director        │
                    │    (async generator)   │
                    │                        │
                    │  1. Call LLM           │
                    │  2. Parse tool calls   │
                    │  3. Dispatch to actors │
                    │  4. Collect results    │
                    │  5. Loop or finish     │
                    └───────────┬────────────┘
                                │
              ┌─────────────────┼──────────────────┐
              │                 │                  │
              ▼                 ▼                  ▼
     ┌────────────────┐ ┌──────────────┐ ┌──────────────────┐
     │  Built-in      │ │  MCP Tools   │ │  Confirmation    │
     │  Actors        │ │              │ │  Gate            │
     │                │ │  browser__   │ │                  │
     │  view_file     │ │  fill_form   │ │  Dangerous ops   │
     │  edit_file     │ │              │ │  require user    │
     │  write_file    │ │  slack__     │ │  approval        │
     │  shell_command │ │  send_message│ │                  │
     │  search_web    │ │              │ │  Tunable via     │
     │  read_webpage  │ │  (namespaced │ │  preferences     │
     │  grep_files    │ │   server__   │ │                  │
     │  list_files    │ │   toolname)  │ │                  │
     │  ask_user      │ │              │ │                  │
     └────────────────┘ └──────────────┘ └──────────────────┘
```

### Skills System

Skills are reusable instruction sets that extend the agent's behavior. Each skill is a directory with a `SKILL.md` file (and optional scripts/references).

```
~/.pipali/skills/<skill-name>/
├── SKILL.md          # Frontmatter (name, description) + markdown instructions
├── scripts/          # Optional helper scripts (TypeScript, Python, etc.)
├── references/       # Optional reference files
└── package.json      # Optional npm dependencies
```

**How skills are loaded:**
1. `loadSkills()` scans `~/.pipali/skills/` and builtin skills at startup
2. The director injects loaded skills into the system prompt as XML
3. The LLM reads skill name + description, and can read the full `SKILL.md` for detailed instructions when relevant

Skills are designed for progressive disclosure — the agent sees a summary of all skills but only reads full instructions when a skill is relevant to the current task.

**Code:** `src/server/skills/`, builtin skills in `src/server/skills/builtin/`

### Command Sandbox

Shell commands run in an OS-enforced sandbox, by default. Sandboxed commands skip user confirmation; commands that need full system access require explicit approval.
We use Seatbelt on Mac, Bubblewrap on Linux. Windows does not currently have sandboxing, so all shell commands require user confirmation.

```
┌─────────────────────────────────────────────────┐
│              shell_command actor                │
│                                                 │
│   ┌─────────────────┐   ┌───────────────────┐   │
│   │  Sandbox Mode   │   │   Direct Mode     │   │
│   │                 │   │                   │   │
│   │  macOS Seatbelt │   │  Full system      │   │
│   │  Linux bwrap    │   │  access           │   │
│   │                 │   │                   │   │
│   │  Restricted to: │   │  Requires user    │   │
│   │  • allowed paths│   │  confirmation     │   │
│   │  • allowed hosts│   │  via WebSocket    │   │
│   │                 │   │                   │   │
│   │  No confirmation│   │                   │   │
│   │  needed         │   │                   │   │
│   └─────────────────┘   └───────────────────┘   │
└─────────────────────────────────────────────────┘
```

**Sandbox rules** are stored per-user in the database (`SandboxSettings` table):
- Read is allowed by default apart from explicitly denied paths.
  - `deniedReadPaths` — sensitive paths blocked from reading (e.g., `~/.ssh`, `~/.aws`, `.env`)
- Write is denied by default apart from explicitly allowed paths.
  - `allowedWritePaths` — directories the sandbox can write to (default: `/tmp`, `~/.pipali`)
- Network access is denied by default apart from explicitly allowed domains
  - `allowedDomains` — network domains accessible from the sandbox (e.g., npm, pypi, github)

**Code:** `src/server/sandbox/`, uses `@anthropic-ai/sandbox-runtime`

### Conversation Storage (ATIF)

All conversations are stored in **ATIF** (Agent Trajectory Interchange Format) — a structured JSON format persisted as JSONB in PGlite. See [RFC](https://github.com/laude-institute/harbor/blob/main/docs/rfcs/0001-trajectory-format.md) for details.

Each conversation is a sequence of steps:

```
Step 1: source=system   │ System prompt
Step 2: source=user     │ User message
Step 3: source=agent    │ Thought + tool_calls (e.g., search_web, view_file)
Step 4: source=agent    │ Observation (tool results)
Step 5: source=agent    │ Thought + tool_calls (follow-up tools)
Step 6: source=agent    │ Observation (results)
Step 7: source=agent    │ Final response (no tool calls = loop ends)
```

Key entry points:
- Agent orchestration: `src/server/processor/director/`
- Tool implementations: `src/server/processor/actor/`
- API routes: `src/server/routes/api.ts`
- WebSocket handler: `src/server/routes/ws.ts`
- Database schema: `src/server/db/schema.ts`
