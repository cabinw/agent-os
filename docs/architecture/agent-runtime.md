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

### Project workspace entry

ADR-047 makes a user-selected project workspace part of first-use acceptance.
The current local launcher creates Agent-specific directories under
`.agent-os/local/workspaces`; that is safe test containment, not a product-level
"open this repository" contract.

The entry implementation gives Project a stable Hub id, then registers a
Runner-owned placement `(project, runnerHost) → canonical working-copy path`.
Different hosts may have different paths per ADR-008. A browser may choose only
an already authorized placement; it never submits an arbitrary absolute path to
the Hub. A native picker may create a placement only through narrow trusted IPC
and Runner-side admission. Both paths reject traversal, symlink escape and
cross-project session reuse. Worktrees may provide isolation, but remain
Runner-owned placements derived from an explicitly authorized project root.

### Product readiness

The execution home may label an Agent **Ready** only when one sourced read model
confirms all of these at an observation time:

| Fact | Authority |
| --- | --- |
| executable | Runner resolves a canonical registered binary |
| authenticated | adapter performs a non-mutating vendor preflight |
| connected / accepting | authenticated live placement snapshot |
| workspace authorized | exact `(project, host)` placement and fingerprint |
| permission usable | adapter policy can perform the requested work class |
| capacity | logical and placement concurrency admit another Run |

A durable registration alone proves none of the live facts. A failed fact keeps
its reason and next action; the system does not discover missing authentication
by sacrificing the user's first real Run.

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
ephemeral. A transport lease may be reoffered after its grace period, but the
durable task does not invent a `running → assigned` transition. Hub boot keeps
the task `running` and re-dispatches with the existing `task.started` id; an old
lease is fenced and a surviving Worker replays the same logical execution. See
[ADR-042](../decisions/ADR-042-interrupted-runner-dispatch-recovery.md).

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

The implemented legacy key is `(user, project, agent)`. ADR-047 requires the
Code-session entry to scope it as `(user, project, conversation, agent)` so two
visible Conversations cannot share hidden vendor context. An explicit migrated
default Conversation may adopt one legacy placement; arbitrary matching may not.

The Hub persists the owning host; that Runner persists the opaque vendor session
id, adapter and canonical workspace. Resume requires the same Conversation,
host, adapter and workspace fingerprint. If any change or resume fails, the
Runner starts fresh and rebuilds from sourced project context. The mapping is
operational state, not project truth.

That fallback is proven. It changes latency and cost, not correctness.

## Capability, not provider

See [ADR-004](../decisions/ADR-004-capability-first-agent-catalog.md). Domain
logic and autonomous Task routing never branch on `provider`. A human-facing
client may display and directly select a configured Agent such as Codex or
Claude; vendor invocation still exists only in adapter / integration code. Task
routing reads the effective capability
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
Runner contract. It runs on the Runner and is the only place invocation behavior
branches by vendor. Provider names may also appear as configuration and display
labels; they do not control domain semantics.

```
       Runner contract  (dispatch, event stream, cancel, health)
            ▲
   ┌────────┼────────┬──────────┬──────────┐
Claude   Codex    Gemini    Perplexity   …          ← adapters
```

Adapters are configuration, not architecture: the shipped set grows without
changing domain or routing semantics. Presentation may display the configured
Agent/vendor label but must branch behavior on declared integration capabilities.
An agent that participates through MCP needs no
translation for its calls, but wake, connection mounting and vendor invocation
remain Runner responsibilities.

The SDK exposes three deliberately separate surfaces: AgentClient for named MCP
calls, Runner for dispatch/control, and Adapter for vendor wake and stream
normalization. `receiveTask` belongs to Runner dispatch; there is no generic
`sendEvent`. See [ADR-016](../decisions/ADR-016-agent-sdk-boundaries.md).

The shared subprocess adapter seam owns abort, absolute timeout, bounded stderr,
control-plane environment filtering and JSONL lifecycle. A concrete adapter
owns only command construction and vendor-line interpretation. Neither retries;
the Runner owns dispatch idempotency and durable terminal replay.

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
