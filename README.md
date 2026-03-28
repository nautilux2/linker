# linker

Bridge multiple AI coding instances together — share context, send messages, ask and answer questions across sessions without copy-pasting.

Works with **Claude Code**, **Cursor**, **Windsurf**, **Aider**, **Codex CLI**, **Continue**, and any OpenAI-API-based agent.

## What it does

When you have two or more AI sessions open (different tools, terminals, or machines), linker lets them coordinate as a group:

- **Send / receive messages** between specific instances or broadcast to all
- **Ask / answer questions** across sessions — one instance asks, another answers
- **Shared context store** — set and get key-value facts visible to all instances
- **Presence tracking** — see which AI tools are connected and their agent types
- **Auto-discovery** — new instances scan for an active host and join automatically
- **Native tool integration** — no manual commands; each AI invokes linker tools on its own

## Install

### Claude Code / Cursor / Windsurf (MCP — zero config)

```
/plugin install linker@nautilux2
```

Claude Code reads `.mcp.json` and starts the server automatically via `npx`. Restart and the tools are live.

### Manual MCP (any MCP-compatible tool)

Add to `~/.claude/settings.json` (or your tool's equivalent):

```json
{
  "mcpServers": {
    "linker": {
      "command": "npx",
      "args": ["-y", "github:nautilux2/linker"]
    }
  }
}
```

### OpenAI-based agents (Codex CLI, GPT-4 agent loops)

```bash
npx github:nautilux2/linker join <host-url> --name YOUR_NAME
node adapters/openai.js --name YOUR_NAME
```

Then in your agent loop:

```js
const linker = require('linker-mcp/adapters/openai')
// include linker.tools in your OpenAI API request
// call linker.execute(name, args) for each tool_call returned
```

See `adapters/openai.js` for a complete agent loop example.

### Aider / file-based agents

```bash
npx github:nautilux2/linker join <host-url> --name YOUR_NAME
node adapters/filewatch.js --name YOUR_NAME &
aider --read ~/.linker/bus/context.json \
      --read ~/.linker/bus/who.json \
      --read ~/.linker/bus/pending.json
```

### Inject rules into any project

```bash
npx github:nautilux2/linker inject
```

Writes coordination rules to `.cursorrules`, `.windsurfrules`, and `AGENT.md` in the current directory. Idempotent — safe to re-run.

## Setup flow

**First instance (host):**

On first run the AI detects linker is unconfigured and calls `connect(action="scan")`. Since no host exists yet, it offers to start one:

```
connect(action="host", name="alice")
→ Host started on http://localhost:7700
→ Others join with: connect(action="join", url="http://localhost:7700", name="<name>")
```

The host runs as a background daemon — it stays alive between AI sessions.

**Every other instance:**

On startup the AI scans ports 7700–7710, finds the host, and joins automatically:

```
connect(action="scan")
→ Found: http://localhost:7700 (instances: ['alice'])

connect(action="join", url="http://localhost:7700", name="bob", agent_type="cursor")
→ Joined. All tools active.
```

Non-Claude AIs can identify their type with `agent_type` — visible to all instances via `who`.

## Tools

| Tool | Description |
|---|---|
| `connect` | Setup: scan for hosts, join, start a host, or check status |
| `send` | Send a message to a specific instance or broadcast to all |
| `recv` | Read unread messages addressed to this instance |
| `ask` | Post a question for other instances to answer (returns an id) |
| `answer` | Answer a pending question by id |
| `pending` | List all unanswered questions |
| `set` | Store a key-value pair in shared context |
| `get` | Read shared context (one key or all) |
| `who` | List all connected instances, their agent types, and last-seen time |
| `log` | Show recent messages, questions, and context |

## Multi-AI coordination

`who` now returns agent type information so instances know who they're talking to:

```json
{
  "alice": { "agent_type": "claude", "tool": "claude-code", "last_seen": "14:32:01" },
  "bob":   { "agent_type": "cursor", "tool": "Cursor",      "last_seen": "14:32:05" },
  "carol": { "agent_type": "codex",  "tool": "codex",       "last_seen": "14:31:58" }
}
```

The hub also exposes `GET /tools.openai` — linker tool definitions in OpenAI function-calling format, for dynamic discovery by agent frameworks.

## How each AI uses linker tools

| AI tool | Transport | Behavior injection |
|---|---|---|
| Claude Code | MCP stdio | `CLAUDE.md` (project) |
| Cursor | MCP stdio | `.cursorrules` via `inject` |
| Windsurf | MCP stdio | `.windsurfrules` via `inject` |
| Continue | MCP stdio | `systemMessage` in config.json |
| Codex CLI / GPT agents | `adapters/openai.js` | System prompt from `AGENT.md` |
| Aider | `adapters/filewatch.js` | `--read AGENT.md` |
| Any script | `adapters/filewatch.js` | Poll `~/.linker/bus/out/` |

## Adapters

### `adapters/openai.js`

Standalone HTTP server (port 7720) and importable module. Wraps linker tools in OpenAI function-calling format.

```
GET  /tools  → OpenAI tool definitions array
POST /call   → { "name": "linker_send", "arguments": {...} } → { "result": "..." }
```

Tool names are prefixed `linker_` to avoid collisions (e.g. `linker_send`, `linker_ask`).

### `adapters/filewatch.js`

Polls the hub every 2s and writes state snapshots to `~/.linker/bus/`:

```
~/.linker/bus/context.json   — shared key-value context
~/.linker/bus/who.json       — connected instances
~/.linker/bus/messages.json  — your unread messages
~/.linker/bus/pending.json   — unanswered questions
```

Script agents can also execute tools by dropping files in `~/.linker/bus/out/`:

```json
{ "id": "001", "name": "send", "arguments": { "content": "done with auth" } }
```

Result appears in `~/.linker/bus/in/001.json`.

## Architecture

```
linker host (HTTP daemon, port 7700)
  ├── /send  /recv  /ask  /answer  /set  /get  /who  /pending  /log
  ├── /tools.openai  (OpenAI function-calling format, for agent discovery)
  │
  ├── instance alice  →  MCP stdio  (Claude Code / Cursor / Windsurf)
  ├── instance bob    →  adapters/openai.js  (Codex CLI / GPT agents)
  └── instance carol  →  adapters/filewatch.js  (Aider / scripts)
```

The host is a lightweight in-memory HTTP server. Each AI session connects via its own transport. All state lives in the host process; if the host restarts, state resets (no persistence by design — sessions are ephemeral).

## Requirements

- Node.js 18+ (for the JS implementation — recommended)
- Python 3.8+ (for `linker.py` — manual installs only)
- No additional dependencies (stdlib only)

## License

MIT — © 2024 [nautilux2](https://github.com/nautilux2)
