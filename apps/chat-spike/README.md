# chat-spike

A protocol spike, not a product. It exists to answer questions that only running
code can answer, and it is expected to be partly thrown away.

## What it proves

**Two channels, not one.** The specs described agents as MCP servers we call;
running the thing showed that is only half of it.

```
wake       browser ──POST /send──▶ server ──▶ Adapter ──▶ vendor CLI
                                                              │
participate  agent ──MCP──▶ bin/agent-os-mcp.mjs ──▶ tools ──▶ event log
```

The **wake channel** is Agent OS dispatching to an agent, rather than the agent
polling. It resolves the dangling `receiveTask` contract in `agent-sdk`:
**receiving is not an MCP tool, it is the adapter's outbound call.**

The **participate channel** is the reverse — the agent calls *us*, and every
write to the log crosses it. Claude Code drove it with no adapter at all
([FINDINGS](FINDINGS.md#positive-result-the-zero-adapter-path-works-against-claude-code));
Codex cannot, so its adapter speaks the protocol on its behalf. Same boundary
either way.

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

- [x] **0 — dispatch works, across four vendors.** No event log, no MCP server of our own.
- [x] **1 — event log.** Every message becomes `message.sent`; the UI projects the log; restart replays it. **Verified: kill the process, restart, the conversation comes back.**
- [x] **2 — participation channel.** Our MCP server (`register_agent` / `get_context` / `send_message`). **Verified: Claude Code registered and spoke through it with no adapter; impersonation was refused.**
- [ ] **3 — the experiment.** Persistent session vs. rebuilding from `get_context`. Compare coherence *and* latency.

## The participation channel

`src/mcp-tools.mjs` is the trust boundary; `bin/agent-os-mcp.mjs` is a stdio↔HTTP
bridge onto it that holds no state, so there is exactly one place that can write.

Attach it to any MCP client:

```bash
corepack pnpm --filter @agent-os/chat-spike start        # terminal 1
cat > /tmp/mcp.json <<'JSON'
{"mcpServers":{"agent-os":{"command":"node",
  "args":["<repo>/apps/chat-spike/bin/agent-os-mcp.mjs"],
  "env":{"AGENT_OS_URL":"http://localhost:4173","AGENT_OS_CALLER":"claude-code"}}}}
JSON
claude -p '注册进 Agent OS 然后发一条消息' --mcp-config /tmp/mcp.json
```

The three things an agent cannot do are enforced by **absence**, not by checks —
there is no field that reaches the envelope, no status tool, no approval tool
(CLAUDE.md rule 3). Plus one check that cannot be structural: `from` must match
the caller, or one agent could speak as another.

Rejections are readable sentences on purpose. The live test showed a real agent
reporting a refusal instead of retrying against it — a `400` would have bought a
retry loop.

## Findings worth keeping

**`config` injection works.** Passing `config.mcp_servers` on the `codex` tool
call does launch a server and completes the MCP handshake — no need to touch
`~/.codex/config.toml`.

**But Codex will not expose those tools to the model.**
`tool_search_always_defer_mcp_tools` has effective value `true` at stage
`removed`, so MCP tools sit behind a search step that never resolved across four
attempts (two of them hanging for four minutes). Claude Code, on the same server,
called all three on the first try. **Participation is therefore a per-vendor
capability, not something the protocol can assume** — which is exactly the case
adapters exist for.

## The event log

`data/events.jsonl`, append-only, using the **real envelope** from
[event-core.md](../../docs/architecture/event-core.md) rather than a simplified
one — so what it teaches transfers to Phase 1.1 instead of being re-learned.

```
{ id: "evt_01K…", type: "message.sent", seq: 3, project, actor, subject, at, causedBy, payload }
```

Two rules it enforces, both testable:

- **Nothing reaches the UI that was not written to the log first.** Rendering is
  a projection of `src/thread.mjs`, a pure `(state, event) => state` fold.
- **Anything derivable is derived, never stored.** Turn latency comes from the
  `causedBy` chain's timestamps. Cold-start (`fresh`) is not in the log at all —
  it describes the adapter's vendor session, not the project, so replay
  correctly forgets it.

Live-only signals — token deltas, reasoning, progress — bypass the log by
design. They are previews; the logged `message.sent` is the fact.

`log.mjs` is the throwaway part: Phase 1.2 replaces JSONL with SQLite + WAL,
transactional seq allocation, idempotency tokens and snapshots. Nothing above it
knows how events are stored.

## What is deliberately absent

Tasks, Supervisor, capability routing, memory extraction, the approval gate,
the seven screens, Tauri. Adding `create_task` in particular drags in the state
machine and the router; chat alone is the whole target here.

## Expected to survive

The adapter contract, the three tool schemas and their validation semantics, and
the thread reducer — `src/thread.mjs` is already shared verbatim with the
browser, which imports it rather than reimplementing it. `server.mjs`'s
orchestration and `log.mjs` are scaffolding.
