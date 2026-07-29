# chat-spike

A protocol spike, not a product. It exists to answer questions that only running
code can answer, and it is expected to be partly thrown away.

## What it proves

The **wake channel**: Agent OS dispatches to an agent, rather than the agent
polling for work.

```
browser ──POST /send──▶ server ──▶ CodexAdapter ──▶ codex mcp-server
   ▲                                                      │
   └──────────GET /events (SSE)◀── codex/event progress ───┘
```

This is the shape the specs describe — the runtime hands work to agents
([overview](../../docs/architecture/overview.md)) — and it resolves the dangling
`receiveTask` contract in `agent-sdk`: **receiving is not an MCP tool, it is the
adapter's outbound call.**

## Run it

```bash
corepack pnpm --filter @agent-os/chat-spike start
# → http://localhost:4173
```

Requires `codex` on PATH (verified against codex-cli 0.142.5) and a logged-in
Codex account. The agent runs `sandbox: read-only`, `approval-policy: never`,
with its working directory pinned to `apps/chat-spike/workspace/`.

## Four vendors

Codex, Claude, Grok and Kimi all run behind one adapter contract — switch in the
header. Measurements and the full comparison are in
[FINDINGS.md](FINDINGS.md); the short version is that they differ on three of
four integration capabilities, so adapters **declare** what they can do and the
UI branches on the declaration:

| | streaming | reasoning | session | usage |
| --- | --- | --- | --- | --- |
| Codex | ✅ | ❌ | ✅ | ✅ |
| Claude | ✅ | ❌ | ✅ | ✅ |
| Grok | ✅ | ✅ | ✅ | ✅ |
| Kimi | ❌ | ❌ | ✅ | ❌ |

Switching provider keeps the transcript and drops the vendor session — the
cheapest demonstration of why context belongs in the log.

## Measured behaviour

| | |
| --- | --- |
| First turn | ~20s — cold start is real |
| Continued turn (`codex-reply`) | ~7s |
| Progress notifications | `codex/event`, ~34 on a first turn |
| Session continuity | Confirmed: `codex-reply` with a `threadId` retains context; a fresh `codex` call does not |

The cold-start gap matters beyond latency: it is the price of the memory-first
model, where an agent rebuilds context from the log instead of holding it.
That trade-off is what stage 3 measures.

## Stages

- [x] **0 — dispatch works, across four vendors.** This code. In-memory only, no event log, no MCP server of our own.
- [ ] **1 — event log.** Every message becomes `message.sent`; the UI projects the log; restart replays it.
- [ ] **2 — participation channel.** Our MCP server (`register_agent` / `get_context` / `send_message`); the adapter translates Codex's reply into a `send_message` request. Also worth trying against Claude Code, which surfaces MCP tools directly — two providers, two integration shapes, one core ([ADR-004](../../docs/decisions/ADR-004-capability-first-agent-catalog.md)).
- [ ] **3 — the experiment.** Persistent session vs. rebuilding from `get_context`. Compare coherence *and* latency.

## Findings worth keeping

**`config` injection works.** Passing `config.mcp_servers` on the `codex` tool
call does launch a server and completes the MCP handshake — no need to touch
`~/.codex/config.toml`.

**But Codex will not expose those tools to the model.**
`tool_search_always_defer_mcp_tools` has effective value `true` at stage
`removed`, so MCP tools sit behind a search step that never resolved across four
attempts (two of them hanging for four minutes). This is why stage 2 routes the
reply through the **adapter** rather than expecting Codex to call our tools —
which is what an adapter is for anyway.

## What is deliberately absent

Tasks, Supervisor, capability routing, memory extraction, the approval gate,
the seven screens, Tauri. Adding `create_task` in particular drags in the state
machine and the router; chat alone is the whole target here.

## Expected to survive

`codex-adapter.mjs`'s shape, the three tool schemas from stage 2, and the thread
reducer once stage 1 lands. `server.mjs`'s orchestration and the in-memory store
are scaffolding.
