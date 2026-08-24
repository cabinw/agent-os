# Agent Runtime

Manages logical agents, their host placements and vendor sessions. It answers
one question well: *which agent on which host should do this?*

## Hub and Runners

Per [ADR-008](../decisions/ADR-008-server-hub-local-first-runners.md), the Hub is
the control plane and dispatches only. A Runner is the execution plane:

```
Server Hub ⇄ outbound Runner connection
                  │
                  ├── adapter ── vendor CLI
                  └── project working copy
```

Every Runner initiates its Hub connection. It owns vendor credentials, adapter
processes and local project paths. The Hub owns authorization, routing, events
and project metadata; it never starts a CLI or reads the working copy.

Local and Remote Runners use the same dispatch and event-stream contract. Build
and test the Local Runner first. Remote work changes transport only after a real
local CLI task passes the contract suite.

## Agent lifecycle

```
registered ──▶ idle ──▶ working ──▶ idle
                 │         │
                 │         ├──▶ waiting   (awaiting another agent or approval)
                 │         └──▶ blocked   (cannot proceed)
                 │
                 └──▶ disconnected ──▶ (re-register)
```

`disconnected` is expected, not exceptional — Runner and agent processes are
ephemeral. Any task held by a disconnected placement returns to `assigned`
after a grace period and is re-matched to an eligible `(agent, host)`.

**This is now measured, not assumed.** Dropping the vendor session every turn and
rebuilding from `get_context` lost none of four planted facts across four vendors,
and still lost none with 1200 unrelated messages (~108k chars) buried on top
([FINDINGS](../../apps/chat-spike/FINDINGS.md#3b-measured-rebuilding-from-the-log-never-lost-a-fact)).

The cost is **~2× per turn, paid for re-entering rather than for context volume**
— a 100× larger log added only ~50% on top. Two consequences for anything that
schedules agents:

- Keeping a session alive is a per-vendor optimization where one exists, never a
  correctness requirement. One vendor tested was *faster* rebuilding than
  resuming, because its `--resume` re-spawns a process anyway.
- The lever on cost is **fewer, longer turns**, not smaller context. That makes
  it a question about task granularity.

## Model

The logical agent and its host placement are separate records:

```json
{
  "agent": "codex-developer",
  "host": "wk-macbook",
  "capabilities": ["coding", "testing", "git"],
  "environment": {
    "os": "macos",
    "arch": "arm64",
    "mcpServers": ["agent-os", "ghidra"]
  },
  "status": "working",
  "currentTask": "TASK-014"
}
```

The agent record still owns name, provider-for-display, role, parent and
concurrency. The placement owns reachability, effective capability and load.

## Sessions

A logical vendor session is keyed by `(user, project, agent)`. The Hub persists
its owning host; that Runner persists the opaque vendor session id, adapter and
canonical workspace. Resume requires the same host, adapter and workspace. The
mapping is operational state, not project truth: if any of those change or
resume fails, the Runner starts fresh and rebuilds from `get_context`.

That fallback is proven. It changes latency and cost, not correctness.

## Capability, not provider

See [ADR-004](../decisions/ADR-004-capability-first-agent-catalog.md). Nothing in
the runtime branches on `provider`. Task routing reads the effective capability
of `(agent, host)`: an agent may have `testing` on a host with the required
toolchain and lack it elsewhere. Swapping vendors or hosts changes registration,
not tasks or core code.

Capability vocabulary is defined in
[protocol/agent-schema.md](../protocol/agent-schema.md); it is a controlled list
so that `find_agent` is not guessing at free text.

The event-derived catalog is durable; reachability, acceptance and active
dispatch counts are a live authenticated Runner snapshot. Routing joins both and
sums active work across placements before enforcing the logical agent's
`concurrency`. A replayed registration never proves a Runner is currently live.
See [ADR-012](../decisions/ADR-012-event-catalog-live-routing.md).

## Adapters

An adapter is the thin translation between a vendor's interface and the shared
Runner contract. It runs on the Runner and is the only place a provider name may
appear.

```
       Runner contract  (dispatch, event stream, cancel, health)
            ▲
   ┌────────┼────────┬──────────┬──────────┐
Claude   Codex    Gemini    Perplexity   …          ← adapters
```

Adapters are configuration, not architecture: the shipped set grows without
touching `agent-runtime`. An agent that participates through MCP needs no
translation for its calls, but wake, connection mounting and vendor invocation
remain Runner responsibilities.

## Supervision tree

`parentAgent` forms a tree rooted at the Supervisor. It carries delegation
accountability: if a child fails, the parent is notified and decides whether to
retry, reassign, or escalate to a human.

```
supervisor
├── claude-architect
│   └── codex-developer
└── perplexity-researcher
```

## Health

The runtime tracks per-agent liveness (heartbeat), throughput, and blocked
frequency. This feeds the agent status list in the menu bar and the health
indicator on project cards. An agent failing health checks stops receiving new
assignments before it is disconnected.
