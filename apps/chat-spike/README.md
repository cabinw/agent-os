# chat-spike

A protocol spike, not a product. It exists to answer questions that only running
code can answer, and it is expected to be partly thrown away.

It is also the executable baseline for
[ADR-008](../../docs/decisions/ADR-008-server-hub-local-first-runners.md): first
route a real CLI through a Local Runner contract, then move the same contract
behind a Remote Runner transport.

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

The default server composition still shares one process, but an injected
Local Runner now crosses the measured boundary: Hub dispatch on one side,
Runner execution on the other. That path is now mandatory and the direct-adapter
fallback is gone. Project files and vendor logins stay with the Runner.

## Run it

```bash
corepack pnpm --filter @agent-os/chat-spike start
# → http://127.0.0.1:4173
```

Startup prints a one-time human token when `AGENT_OS_HUMAN_TOKEN` is not set.
Open the URL and enter that token in the public bootstrap shell. The shell has no
project data or capability until the token is accepted; it keeps the token in
memory and sends it as `Authorization: Bearer …` on data and control requests.
For one-step local opening,
`http://127.0.0.1:4173/#token=<URL-encoded-token>` is also accepted. A fragment
is never sent to the server; the page clears it before its first authenticated
request. The token is not written to a query, cookie or `localStorage`, so a
refresh asks again.

For a stable development credential, set a random value of at least 32
non-whitespace characters:

```bash
AGENT_OS_HUMAN_TOKEN='<human-token-at-least-32-chars>' \
  corepack pnpm --filter @agent-os/chat-spike start
```

The Hub defaults to `127.0.0.1`. Widen `HOST` only with an explicit Origin
allowlist; authentication remains mandatory.

Requires `codex` on PATH (verified against codex-cli 0.142.5) and a logged-in
Codex account. The agent runs `sandbox: read-only`, `approval-policy: never`,
with its working directory pinned to `apps/chat-spike/workspace/`.

## Four vendors

Codex, Claude, Grok and Kimi all run behind one adapter contract — switch in the
header. Measurements and the full comparison are in
[FINDINGS.md](FINDINGS.md); the short version is that they differ on three of
four integration capabilities, so adapters **declare** what they can do and the
UI branches on the declaration:

| | participates | streaming | reasoning | session | usage |
| --- | --- | --- | --- | --- | --- |
| Codex | ❌ | ✅ | ❌ | ✅ | ✅ |
| Claude | ✅ | ✅ | ❌ | ✅ | ✅ |
| Grok | ✅ | ✅ | ✅ | ✅ | ✅ |
| Kimi | ✅ | ❌ | ❌ | ✅ | ❌ |

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
model, where an agent rebuilds context from the log instead of holding it. Stage
3 measured that trade-off, and it came out the other way round from the
assumption — see below.

## The memory-first bet, priced

```bash
node experiments/context-rebuild.mjs codex claude grok kimi   # resident vs rebuild
node experiments/context-rebuild.mjs --pad 1200 grok          # bury the facts first
```

Four arbitrary facts are planted, a distractor turn is pushed in between, then
they are asked for. `resident` keeps the vendor session; `rebuild` drops it every
turn and prepends `get_context` output — the real mechanism, off the real log.

**Recall was 4/4 in all eight runs, and stayed 4/4 with 1200 unrelated messages
(108k chars) buried on top.** Coherence was never the constraint. Full numbers in
[FINDINGS](FINDINGS.md#3b-measured-rebuilding-from-the-log-never-lost-a-fact).

What it costs (Grok, the only vendor that prices a turn in money):

| | cost/5 turns | wall clock |
| --- | --- | --- |
| resident | $0.052 – $0.062 | 24.4s |
| rebuild | $0.092 – $0.121 | 28.7s |
| rebuild, 100× the log | $0.139 | 28.7s |

**Re-entering costs ~2×; the context you ship on top of it is nearly free.** So
the obvious optimization — truncating `get_context` — is the wrong one. The lever
is fewer, longer turns, which makes this a question about task granularity rather
than about context windows.

## Stages

- [x] **0 — dispatch works, across four vendors.** No event log, no MCP server of our own.
- [x] **1 — event log.** Every message becomes `message.sent`; the UI projects the log; restart replays it. **Verified: kill the process, restart, the conversation comes back.**
- [x] **2 — participation channel.** Our MCP server (`register_agent` / `get_context` / `send_message`). **Verified: Claude Code registered and spoke through it with no adapter; impersonation was refused.**
- [x] **A+B — the Agent Hub.** A human plays Supervisor; agents delegate to each other. **Verified: one human turn produced `you → claude → grok → claude → you`, with the coordinator choosing `find_agent` unprompted.** Task objects were deferred to stage C.
- [x] **3 — the experiment.** Persistent session vs. rebuilding from `get_context`. **Result: 8/8 perfect recall, and it held under a 100× larger log. The cost is a ~2× per-turn premium for re-entering, almost independent of context volume.**
- [x] **C — task review loop.** Tasks, capability routing and human acceptance
  now run through the Hub; a Runner result reaches `review`, never self-accepts.

## The participation channel

`src/mcp-tools.mjs` is the trust boundary; `bin/agent-os-mcp.mjs` is a stdio↔HTTP
bridge onto it that holds no state, so there is exactly one place that can write.

Attach it to any MCP client:

```bash
corepack pnpm --filter @agent-os/chat-spike start        # terminal 1
cat > /tmp/mcp.json <<'JSON'
{"mcpServers":{"agent-os":{"command":"node",
  "args":["<repo>/apps/chat-spike/bin/agent-os-mcp.mjs"],
  "env":{"AGENT_OS_URL":"http://localhost:4173","AGENT_OS_TOKEN":"<token-for-claude>"}}}}
JSON
claude -p '注册进 Agent OS 然后发一条消息' --mcp-config /tmp/mcp.json
```

Start the Hub with the matching scoped token, for example
`AGENT_OS_AGENT_TOKENS='{"claude":"<token-for-claude>"}'`. The token maps to
principal `claude`; request fields cannot change that identity. Generated MCP
configuration files are written with mode `0600`.

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

A formal Supervisor agent, memory extraction, the general risk-approval
workflow, the seven screens and Tauri. The spike has only the task and human
review behavior needed to prove the Hub / Runner boundary.

## Expected to survive

The shared Runner / adapter contract, tool schemas and validation semantics, and
the thread reducer — `src/thread.mjs` is already shared verbatim with the
browser, which imports it rather than reimplementing it. `server.mjs`'s current
co-located orchestration and `log.mjs` are scaffolding.

## Next execution order

1. **Done:** protect every capable Hub route with authenticated principals.
2. **Done:** Local Runner foundation — strict dispatch, normalized events /
   result / error, real subprocess, workspace containment and persistent
   `(user, project, agent)` sessions.
3. **Done:** the Hub supports injected Local Runner dispatch; normalized
   streaming, task review, failure and queue recovery have vertical-slice
   coverage.
4. **Done:** freeze cancellation, retry and liveness tests; persist request-id
   idempotency; require Runner injection and remove the direct fallback.
5. **Active:** add an outbound Remote Runner connection and rerun the same
   acceptance task.
6. Move the proven envelope and contracts into formal packages.
