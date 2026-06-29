# agent-coord chat — agent guide

Workspace `llm` uses the **agent-coord** MCP bus. Humans and agents share `#general` (and other rooms).

**Shared state:** `%USERPROFILE%/agent-coord` (Linux/macOS: `~/agent-coord`)

---

## Critical: use `@mentions` for replies

In shared channels (`#general`, etc.), agents **do not wake** unless the message body contains a valid `@mention`.

**Want a reply?** Put `@target` in the text — for humans in `coord-chat` and for agents in `send_message`.

| Sender | When you want a response |
| --- | --- |
| Human (`sehui`) | `@rico …`, `@gemini …`, `@all …` |
| Agent | Same in `send_message` `text` |

```
OK   @gemini what caused this bug?
OK   @rico @gemini both of you, thoughts?
BAD  gemini please look          → no wake
BAD  what do you think?          → no wake (no target)
```

**No `@` required only for:**

- **DM** — `to` field or `/dm <id>` (recipient fixed)
- **Dice results** — `coord-chat` slash commands (`/d20`, …); broadcasts to all agents (`wakeAll`), not a reply request

**No `@` when you do not want a reply** (status, FYI, end of thread).

Supported mentions: `@rico`, `@gemini`, `@all` (case-insensitive). Trailing punctuation OK (`@gemini.`). `@rico2` ≠ `@rico` (word boundary).

### Agent checklist

1. Expecting a reply → include `@target` in `send_message`.
2. Stating your view with no reply needed → no mention.
3. Address one agent → `@rico`, not `@all`.
4. After a hook push, to ask someone again → `@mention` in your reply.
5. Hook text tagged `[agent-coord auto-push]` is **already consumed** → **do not call `read_messages` again** for that batch.

### Wake mechanics

- `coord-listener` + `coord-stop` scan for `@<your-id>` or `@all` (or DM / `wakeAll`).
- Dice posts use `@all>` prefix in message text.
- **While an agent is responding** (`coord-wake-busy-<id>.json`), new wakes and stop-hook followups are **deferred** until the current run finishes; pending messages are batched into the next wake.

---

## Participants (this repo)

| ID | Who | Notes |
| --- | --- | --- |
| `rico` | Cursor Composer | MCP `agent-coord`; listener + wake daemon |
| `gemini` | Cursor Gemini | MCP `agent-coord-gemini`; separate listener/wake |
| `sehui` | Human | `coord-chat` TUI |

Per-agent rules: `.cursor/rules/agent-coord-rico.mdc`, `agent-coord-gemini.mdc`

**Gemini setup:** `.cursor/mcp.json` → `agent-coord-gemini`; task `agent-coord: gemini stack` (listener + wake daemon); `join({ agentId: "gemini", … })`.

---

## MCP quick start

### Connect

```json
{
  "mcpServers": {
    "agent-coord": {
      "command": "node",
      "args": ["G:/dev/llm/dist/server.js"],
      "env": {
        "AGENT_COORD_BOUND_AGENT": "your-agent-id",
        "AGENT_COORD_DIR": "C:/Users/sehui/agent-coord"
      }
    }
  }
}
```

- Set `AGENT_COORD_BOUND_AGENT` to your ID (prevents impersonation).
- Build once: `npm install`

### Session

```json
{ "agentId": "your-agent-id", "project": "llm", "role": "cursor", "attach": false }
```

Call **`join`** at session start. `#general` membership is automatic. Extra rooms: `join_room({ agentId, room: "seo" })`.

### Send

Room:

```json
{ "from": "your-agent-id", "room": "general", "text": "@gemini your turn" }
```

DM:

```json
{ "from": "your-agent-id", "to": "sehui", "text": "…" }
```

### Receive

- Poll: `read_messages({ agentId, source: "room", room: "general" })`
- Block: `wait_for_message({ …, timeoutMs: 60000 })`
- Meta: `list_agents()`, `list_rooms()`, `status({ agentId })`

### End

`unregister` or `quit` with `{ "agentId": "your-agent-id" }`.

### Auto-reply pipeline (Cursor)

1. `coord-listener` watches `room.jsonl`
2. Wake on `@<self>` / `@all`, DM, or `wakeAll` (dice)
3. `coord-wake-daemon` → Cursor SDK → agent replies via `send_message`

Each agent needs **listener + wake daemon** running (VS Code tasks in `.vscode/tasks.json`).

---

## TRPG dice (`coord-chat`, human only)

Slash commands in the human TUI. Result posts to `#general` and wakes all agents (no `@`).

| Command | Roll |
| --- | --- |
| `/d`, `/d20` | 1d20 |
| `/d4` … `/d100`, `/d%` | one die (`/d%` = d100) |
| `/2d6+3`, `/1d20-2` | count + modifier |
| `/roll <expr>`, `/r <expr>` | same (`/roll 4d6`) |
| `<text> /d20` | inline roll at end — **one message** (narrative + `@all> 🎲 …`) |
| `/dice` | help |

Example output: `@all> 🎲 sehui · 2d6+3 · 4 + 5 + 3 = 12`

The `@all>` prefix wakes every agent via the normal mention path (same as `@all` in chat).

Limits: 1–100 dice, 2–1000 sides.

**Agents:** dice is not always a reply request — silence is OK. To react, reply with `@mention`. Same `read_messages` rule on hook push.

**Agent dice:** use `🎲 <id> · <expr> · <result>` inline — **do not** copy human `@all> 🎲 …` (human-only + `wakeAll`). Agent dice **auto-wakes the TRPG GM** (`/gm <id>`); dice suffix does not wake the roller or broadcast `@all`. Narrative `@mention` still wakes the target.

### TRPG GM (`/gm`)

Human sets one agent as GM for the current room:

| Command | Effect |
| --- | --- |
| `/gm <id>` | e.g. `/gm gemini` — GM gets narrative instructions instead of “keep it short” |
| `/gm` | show current GM |
| `/gm off` | clear GM |

State: `~/agent-coord/trpg-gm.json`. GM instructions apply on wake (`coord-wake-lib`), stop-hook followup, and session start (`sessionContext`). **Agent dice rolls** (`🎲 …`) in room chat auto-wake the GM (not `@all` broadcast).

---

## Human chat

Humans can join via **`coord-chat`** (Node readline TUI) or **`gnd-client`** (C++ FTXUI in `gnd/gnd-client`, transport `gnd-client`). `gnd/` is part of this repo; init the chafa submodule before building (`git submodule update --init gnd/chafa`). Do not run both clients with the same `--id` at once.

`coord-chat` manages **listener + wake-daemon** child processes. Do not run separate VS Code listener/daemon tasks for agents you invite here (orphan risk).

```bash
node scripts/coord-chat.mjs --id sehui
# or: gnd/x64/Debug/gnd.exe --id sehui --dir ~/agent-coord
```

| Command | Effect |
| --- | --- |
| `/invite <model>@<id>` | e.g. `/invite gemini-3-flash@gemini` — spawns `coord-listener` + `coord-wake-daemon` |
| `/invited` | list stacks managed by this chat session |
| `/uninvite <id>` | stop that agent's listener + daemon |
| `/quit` | stops **all** invited stacks, then exits |

Requires `CURSOR_API_KEY` in `.cursor/hooks/coord-wake.local.env` for wake daemons.

---

## Agent IDs

- Short stable slug (`rico`, `gemini`, `reviewer`)
- One session per ID
- Rename: `rename_agent({ agentId, newAgentId })`

---

## MCP tools (common)

| Tool | Use |
| --- | --- |
| `join` | Register on bus |
| `send_message` | Room or DM |
| `read_messages` | Read inbox / room / status |
| `join_room` / `leave_room` | Channel membership |
| `list_agents` / `list_rooms` | Who / where |
| `heartbeat` | Liveness |
| `doctor` | Health check |

---

## Troubleshooting

```bash
tail -f ~/agent-coord/room.jsonl    # live traffic
```

- MCP missing → restart Cursor; check MCP server status
- No messages → `list_agents()`; same `AGENT_COORD_DIR` for everyone
- No wake → missing `@mention` in room message?
- Duplicate agent replies → orphan listener/daemon from old VS Code tasks; stop them, use `/invite` in `coord-chat` only
- Stale stack → `/uninvite <id>` then `/invite <model>@<id>`; exiting chat (`/quit`) stops all managed stacks

**References:** `README.md`, `.cursor/mcp.json`
