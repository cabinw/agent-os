# Four vendors, measured

Every number here came from running the CLI on this machine, not from
documentation. Where a vendor documents nothing — which is most of the event
schemas — the shape was learned by dumping real traffic (`DUMP_EVENTS=path`).

Versions: codex-cli 0.142.5 · Claude Code · Grok Build · Kimi. macOS, 2026-07-29.

## The comparison

| | Codex | Claude | Grok | Kimi |
| --- | --- | --- | --- | --- |
| **Wake command** | `codex mcp-server` | `-p --output-format stream-json --verbose --include-partial-messages` | `--single --output-format streaming-json` | `-p --output-format stream-json` |
| **Transport** | **MCP over stdio**, long-lived | subprocess + stdout JSONL | subprocess + stdout JSONL | subprocess + stdout JSONL |
| **Event keyed on** | `msg.type` (MCP notification) | `type` | `type` | **`role`** |
| **Answer arrives as** | `agent_message_content_delta.delta` | `stream_event` → `text_delta`, authoritative in `result` | `{type:"text", data}` | `{role:"assistant", content}` |
| **Token streaming** | ✅ | ✅ *(needs the extra flag)* | ✅ | ❌ **one shot** |
| **Reasoning stream** | ❌ | ❌ | ✅ **only one** | ❌ |
| **Session id** | `threadId` in tool result | `session_id` | `end.sessionId` | `session_id` on a meta line |
| **Continue** | `codex-reply(threadId, …)` | `--resume <id>` | `--resume` / `-c` | `-r <id>` |
| **Usage reported** | ✅ + context window | ✅ | ✅ + **cost in USD** | ❌ |
| **Cold turn** | 7.1–13.8s | 4.6s | 5.7s | 8.7s |
| **Continued turn** | **1.5s** | — | — | — |

## What this changed

### 1. There are two channels, and the specs only described one

```
wake         Agent OS ──▶ agent      vendor-specific, always needs an adapter
participate  agent ──▶ Agent OS      MCP, our server, ADR-001 holds here
```

**Only Codex speaks MCP on the wake channel**, and it speaks it as a *server* —
so Agent OS is the client. The other three are "spawn a process, read a stream".
ADR-001's promise that "an agent that already speaks MCP connects with no
adapter" is true of the participate channel and **false of the wake channel** for
all four vendors tested.

This also resolves the dangling `receiveTask` in `agent-sdk`: receiving is not an
MCP tool, it is the adapter's outbound call.

### 2. Integration capability is a second axis

`agent-schema.md` has a controlled vocabulary of *task* capabilities — coding,
testing, research. Nothing described whether an agent can stream, expose
reasoning, or resume. Those are **integration** capabilities, they vary
independently, and the UI has to branch on them:

- Kimi cannot stream → a UI that assumes deltas shows a frozen pane for ~9s
- Grok streams reasoning 20:1 against its answer → rendering it inline buries the answer
- Codex is the only one where continuation is dramatically cheaper than a cold start

One vendor would have taught none of this. Building the UI on Codex alone would
have baked in three wrong assumptions.

### 3. The memory-first rebuild has a measured price

Codex: **7.1s cold vs 1.5s continued — 4.7×**. That is the cost of discarding a
vendor session and rebuilding context from the log.

So the Phase 3 question is no longer only "is `get_context` coherent enough". It
is also "is it worth 4.7× latency", and the answer is probably per-situation:
resident sessions inside a long task, rebuild across tasks and across days.
`agent.disconnected` in `agent-runtime.md` already calls ephemeral agents normal
— this puts a number on it.

## Negative result: Codex will not expose our MCP tools to its model

Injecting `config.mcp_servers` on the `codex` tool call **does work at the
process level** — Codex reads it, spawns the server, completes the MCP handshake,
requests `tools/list`:

```
PROCESS_LAUNCHED
RECV initialize
RECV notifications/initialized
RECV tools/list
```

But the tool is never called. `tool_search_always_defer_mcp_tools` has effective
value `true` at stage `removed` (not overridable), so MCP tools sit behind a
search step. Four attempts with different prompts and feature overrides: zero
calls, two of them hanging for four minutes.

**Consequence:** the participate channel routes through the **adapter**, which
translates a vendor reply into a `send_message` request. That is what an adapter
is for, and the trust boundary is unchanged — the adapter is inside it, the
vendor is outside. Worth retrying against Claude Code, which does not force
deferral.

## Operational notes

- **Timeouts are mandatory.** Two four-minute hangs during probing. Every adapter
  caps a turn at 180s; a stuck agent must fail, not idle.
- **Claude needs `--include-partial-messages`** or the whole answer arrives at
  once, and its `result` event is authoritative over the concatenated deltas.
- **Kimi's meta line spells out its own resume command** (`kimi -r <id>`), which
  is the friendliest session affordance of the four.
- **Grok reports cost in USD per turn**; nobody else does.

## Reproducing

```bash
corepack pnpm --filter @agent-os/chat-spike start
# switch provider in the header, or PROVIDER=grok to start there
DUMP_EVENTS=/tmp/events.jsonl corepack pnpm --filter @agent-os/chat-spike start
```
