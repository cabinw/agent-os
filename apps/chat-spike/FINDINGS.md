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
is also "is it worth 4.7× latency". Both halves are now measured — see below,
and the answer inverted the question.

### 3b. Measured: rebuilding from the log never lost a fact

`experiments/context-rebuild.mjs` plants four arbitrary facts (`青铜麋鹿`,
`7734`, `Vera`, `周四 02:00` — unguessable, so a hit is recall and not a
plausible completion), pushes a distractor turn between planting and asking,
then grades. `resident` keeps the vendor session; `rebuild` drops it every turn
and prepends `get_context` output. Same turns, same grader.

| | recall | wall clock | shipped |
| --- | --- | --- | --- |
| codex resident | 4/4 | 14.2s | 0.1k chars |
| codex rebuild | 4/4 | 31.1s | 1.1k |
| claude resident | 4/4 | 61.7s | 0.1k |
| claude rebuild | 4/4 | 35.0s | 1.1k |
| grok resident | 4/4 | 24.5s | 0.1k |
| grok rebuild | 4/4 | 28.7s | 1.1k |
| kimi resident | 4/4 | 22.3s | 0.1k |
| kimi rebuild | 4/4 | 20.0s | 1.1k |

**8/8 perfect.** Coherence is not the constraint, so the interesting question
became how far it holds. `--pad N` buries the facts under N messages of
plausible, on-topic project chatter:

| padding | shipped/turn | codex | claude | grok | kimi |
| --- | --- | --- | --- | --- | --- |
| 0 | 1.1k chars | 4/4 · 31.1s | 4/4 · 35.0s | 4/4 · 28.7s | 4/4 · 20.0s |
| 200 | 18.7k | 4/4 · 33.8s | 4/4 · 70.2s | 4/4 · 28.6s | 4/4 · 26.6s |
| 1200 | 108.7k | 4/4 · 34.0s | 4/4 · 48.2s | 4/4 · 30.6s | 4/4 · 32.1s |

**A 100× larger log did not cost a single fact, and barely cost time.** Codex and
Grok are flat; Kimi grows ~1.5× over that 100×; Claude is too noisy to call.

### 3c. The bill was the axis we were not watching

Token totals are **not comparable across vendors** — Codex reports a running
session total, Claude reports what missed its cache, Kimi reports nothing. Grok
is the only one that prices a turn in money, so it carries this result:

| | cost | wall clock |
| --- | --- | --- |
| resident | $0.052 – $0.062 | 24.4s |
| rebuild, pad 0 | $0.092 – $0.121 | 28.7s |
| rebuild, pad 200 | $0.116 | 28.6s |
| rebuild, pad 1200 | $0.139 | 28.7s |

**Rebuild costs ~2× — and then a 100× bigger log adds only ~50% on top of that.**
The premium is in *re-entering* at all, not in how much context is shipped: a
resident turn reuses a warm prefix, a rebuilt one pays for a fresh one every
time. Context volume is the cheap part.

### What that changes

The roadmap assumed the memory-first bet would be paid as a coherence risk, and
priced it at Codex's 4.7× cold start. Both are wrong in the same direction:

- **Do not truncate `get_context` to save money.** The obvious optimization is
  the wrong one — shipping 100× more context cost ~50%, while re-entering cost
  100%. A `limit` that drops facts buys almost nothing and can lose everything.
- **Batch work into fewer, longer turns.** That is the lever, because the cost is
  per re-entry. It is an argument for task granularity, not for context trimming.
- **Session residency is a per-vendor optimization, not an architectural need.**
  Kimi was *faster* rebuilding than resuming, and Grok nearly tied — because
  `--resume` re-spawns a process anyway. Only Codex, which holds a live server,
  has a real warm path. So `integration.session` should drive an optimization
  when present, never a requirement.
- **Coherence still needs re-testing when the log stops being a flat transcript.**
  This measured 1200 messages of chat. It did not measure knowledge items,
  superseding, or cross-task context — which is where a naive concatenation is
  most likely to break.

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
vendor is outside.

## Positive result: the zero-adapter path works against Claude Code

Same MCP server, no adapter, no translation — Claude Code spawned
`bin/agent-os-mcp.mjs` itself and drove the protocol:

```
$ claude -p '…注册、读上下文、发消息…' --mcp-config mcp.json
seq 1  agent.registered  system:runtime     Claude Code
       capabilities = ['coding', 'review']
seq 2  message.sent      agent:claude-code  Claude Code registered and context loaded…
```

Three tool calls, five turns, 17s. **This is the ADR-001 evidence**: an agent
that never heard of Agent OS participates by reading the tool descriptions. The
adapter is a workaround for vendors like Codex, not the architecture.

Both authorization branches were then confirmed against the same live agent —
the refusals below are Claude Code quoting our server back:

| Attempt | Server's answer |
| --- | --- |
| `from: "codex"`, unregistered | `未注册的发送者 "codex"——必须先调用 register_agent` |
| `from: "codex"`, registered, caller `claude-code` | `不能以 "codex" 的身份发言：调用方注册为 "claude-code"` |

The interesting part is what it did next: it reported the refusal rather than
retrying with a different framing. A boundary that returns a readable reason
gets cooperation; one that returns `400` gets a retry loop.

**Vendor support for the participate channel is now a third integration
capability**, alongside streaming and reasoning — and unlike those it is
pass/fail rather than nice-to-have. Codex fails it. Claude Code passes.

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

# stage 3 — resident vs rebuild, and the haystack sweep
node apps/chat-spike/experiments/context-rebuild.mjs codex claude grok kimi
node apps/chat-spike/experiments/context-rebuild.mjs --pad 1200 grok
```
