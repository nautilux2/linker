# linker

Bridge multiple Claude Code instances together — share context, send messages, ask and answer questions across sessions without copy-pasting.

## What it does

When you have two or more Claude Code sessions open (different projects, terminals, or machines), linker lets them coordinate as a group:

- **Send / receive messages** between specific instances or broadcast to all
- **Ask / answer questions** across sessions — one instance asks, another answers
- **Shared context store** — set and get key-value facts visible to all instances
- **Auto-discovery** — new instances scan for an active host and join automatically
- **Native Claude Code tools** — no manual commands; Claude invokes linker tools on its own

## Install

### As a Claude Code plugin (recommended)

```bash
/plugin install linker@nautilux
```

Claude Code reads `.mcp.json` automatically — linker tools appear in the next session.

### Via pip

```bash
pip install linker-mcp
```

Then add to Claude Code manually:

```bash
# ~/.claude/settings.json or .claude/settings.json
{
  "mcpServers": {
    "linker": {
      "command": "python3",
      "args": ["-m", "linker_mcp"]
    }
  }
}
```

## Setup flow

**First instance (host):**

On first run Claude will detect linker is unconfigured and call `connect(action="scan")`. Since no host exists yet, it will offer to start one:

```
connect(action="host", name="alice")
→ Host started on http://localhost:7700
→ Others join with: connect(action="join", url="http://localhost:7700", name="<name>")
```

The host runs as a background daemon — it stays alive between Claude sessions.

**Every other instance:**

On startup Claude scans ports 7700–7710, finds the host, and joins automatically:

```
connect(action="scan")
→ Found: http://localhost:7700 (instances: ['alice'])

connect(action="join", url="http://localhost:7700", name="bob")
→ Joined. All tools active.
```

If no host is found on the local machine, Claude will ask you to either become the host or provide the host URL manually.

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
| `who` | List all connected instances and their last-seen time |
| `log` | Show recent messages, questions, and context |

## How Claude uses these tools

When 2+ instances are active, Claude automatically:

1. Calls `recv` and `pending` on session start to catch up
2. Calls `get` before starting work to load shared context
3. Calls `set` when it discovers useful facts (file locations, decisions, API shapes)
4. Calls `send` after completing a task to broadcast a summary
5. Calls `ask` when another instance is likely to have the answer
6. Calls `pending` at the end of each task and answers any open questions

This behaviour is defined in `CLAUDE.md` and reinforced in the MCP server's responses — Claude receives the coordination rules on every session start where peers are present.

## Requirements

- Python 3.8+
- No additional dependencies (stdlib only)

## Architecture

```
linker host (HTTP daemon, port 7700)
  ├── instance alice  →  python3 -m linker_mcp  (MCP stdio, spawned by Claude Code)
  └── instance bob    →  python3 -m linker_mcp  (MCP stdio, spawned by Claude Code)
```

The host is a lightweight in-memory HTTP server. Each Claude Code session runs its own MCP stdio process that forwards tool calls to the host over plain HTTP. All state lives in the host process; if the host restarts, state resets (no persistence by design — sessions are ephemeral).

## License

MIT — © 2024 [nautilux](https://github.com/nautilux)
