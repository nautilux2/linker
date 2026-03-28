# linker

Bridge multiple AI coding instances together — share context, send messages, ask and answer questions across sessions without copy-pasting.

Works with **Claude Code**, **Cursor**, **Windsurf**, **Aider**, **Codex CLI**, **Continue**, and any OpenAI-API-based agent.

## Install

### MCP tools — one command, zero config

```
/plugin install linker@nautilux2
```

Works in Claude Code, Cursor, Windsurf, and any MCP-compatible tool. Restart and the tools are live — nothing else needed.

### Non-MCP tools — npx one-liners

First, join a running host (started by one of the MCP instances above):

```bash
# Aider
npx github:nautilux2/linker join http://HOST:7700 --name aider
npx github:nautilux2/linker filewatch --name aider
# then: aider --read ~/.linker/bus/context.json --read ~/.linker/bus/who.json

# OpenAI agents (Codex CLI, GPT-4 loops, LangChain, etc.)
npx github:nautilux2/linker join http://HOST:7700 --name codex
npx github:nautilux2/linker openai --name codex
# then: fetch tools from http://localhost:7720/tools
```

### Manual MCP (no plugin marketplace)

Add to your tool's MCP settings:

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

## What it does

When you have two or more AI sessions open (different tools, terminals, or machines), linker lets them coordinate as a group:

- **Send / receive messages** between specific instances or broadcast to all
- **Ask / answer questions** across sessions — one instance asks, another answers
- **Shared context store** — set and get key-value facts visible to all instances
- **Presence tracking** — see which AI tools are connected and their agent types
- **Auto-discovery** — new instances scan for an active host and join automatically

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

connect(action="join", url="http://localhost:7700", name="bob")
→ Joined. All tools active.
```

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

## Multi-AI presence

`who` returns agent type so instances know who they're talking to:

```json
{
  "alice": { "agent_type": "claude",  "tool": "claude-code", "last_seen": "14:32:01" },
  "bob":   { "agent_type": "cursor",  "tool": "Cursor",      "last_seen": "14:32:05" },
  "carol": { "agent_type": "codex",   "tool": "codex",       "last_seen": "14:31:58" }
}
```

## Inject rules into any project

```bash
npx github:nautilux2/linker inject
```

Writes coordination rules to `.cursorrules`, `.windsurfrules`, and `AGENT.md` in the current directory. Safe to re-run (idempotent).

## Architecture

```
linker host (HTTP daemon, port 7700)
  ├── instance alice  →  MCP stdio       (Claude Code / Cursor / Windsurf)
  ├── instance bob    →  openai adapter  (Codex CLI / GPT-4 agent loops)
  └── instance carol  →  filewatch       (Aider / shell scripts)
```

The host is a lightweight in-memory HTTP server. All state is ephemeral — resets if the host restarts.

## Requirements

- Node.js 18+
- No additional dependencies (stdlib only)

## License

MIT — © 2024 [nautilux2](https://github.com/nautilux2)
