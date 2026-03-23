# Linker — multi-instance coordination

You have access to **linker** tools that connect this Claude Code session to other running instances.
Follow these rules whenever 2 or more instances are active (i.e. `who` returns more than one entry).

---

## On session start

1. Call `connect(action="status")`.
   - If `setup_required` → call `connect(action="scan")` and follow the setup flow.
   - If connected, note your instance name and the host URL.
2. Call `who` to see who else is active.
3. If any other instances are present:
   - Call `recv` to read any messages addressed to you.
   - Call `pending` to see open questions — answer any you can immediately.
   - Call `get` (no key) to load shared context into your working memory.

---

## While working

### Before starting any non-trivial task
- Call `get` to check if another instance has already worked on something related.
- If uncertain whether another instance has relevant context, call `ask` with a specific question rather than starting from scratch.
  - Example: `ask("Has anyone mapped the auth flow in /src/auth?")` before reading every file.

### When you discover something useful
Share it so other instances benefit:
- Facts, decisions, file locations, API shapes → `set(key, value)` in shared context.
- Summaries of completed work → `send(content, to="*")` broadcast or target a specific instance.
- Keep keys short and descriptive: `"auth_flow"`, `"db_schema"`, `"current_task"`.

### When you finish a task
Call `send` with a brief summary of what you did and what changed, broadcast to `"*"`.
This keeps other instances in sync without them having to ask.

---

## Answering questions

- Before answering any question about the codebase, call `recv` first — another instance may have sent the answer already.
- Before reading a large file or directory, call `get` — another instance may have already extracted the relevant parts.
- If a question is outside your current context but another instance is likely to know, call `ask` and wait for the answer rather than guessing.

---

## Checking for questions from other instances

- Call `pending` at natural pause points (after completing a task, before starting a new one).
- Answer every pending question you can with `answer(id, answer)`.
- If you cannot answer, leave it for another instance — do not answer with uncertainty.

---

## Coordination rules

| Situation | Action |
|---|---|
| Other instance is working on the same file | `send` them a heads-up before editing |
| You need a decision from the user in another session | `ask` the question, include the question id in your reply |
| You have partial information | `set` what you know, `ask` for the rest |
| Another instance sent a message to you | Acknowledge it with `send(to="<sender>")` |
| Host is unreachable | Call `connect(action="scan")` to find a new host |

---

## Tool quick reference

| Tool | When to use |
|---|---|
| `connect(action="status")` | Session start, or if tools fail |
| `recv` | Start of session, before answering, after pauses |
| `pending` | After finishing a task, at pause points |
| `ask(question)` | When another instance likely knows the answer |
| `answer(id, answer)` | When you can answer a pending question |
| `send(content, to?)` | Share completed work, findings, warnings |
| `set(key, value)` | Store facts/context for all instances |
| `get(key?)` | Load shared context before starting work |
| `who` | Check who is active before coordinating |
| `log` | Debug or review recent cross-instance activity |

---

## What NOT to do

- Do not call `recv` or `pending` on every single tool call — only at meaningful checkpoints.
- Do not store large file contents in `set` — store summaries, paths, and key facts only.
- Do not `ask` questions you can answer yourself quickly.
- Do not wait indefinitely for an `ask` response — proceed after a reasonable attempt, note that you asked.
