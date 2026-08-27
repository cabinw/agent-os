# Agent OS Architecture Overview

## Target runtime loop

This cycle is the whole system. Deployment separates its control and execution
planes per [ADR-008](../decisions/ADR-008-server-hub-local-first-runners.md).
ADR-047 makes the direct project session the product entry; Supervisor planning
is an optional coordination path once work needs a durable graph. Conversation /
Run identity and events in this diagram are the ENTRY-1 target, not an existing
canonical reducer. Today direct `/say` crosses Hub / Runner but does not create a
complete durable Run lifecycle.

```
Human opens project ──▶ Conversation / Run ───────────────┐
        │                                                 │
        └── optional Goal ──▶ Supervisor ──▶ Task Engine ─┤
                                                          ▼
                                                     Server Hub
                                                          │ dispatch only
                                                 established outbound connection
                                                          │
                                                          ▼
                                                   Local / Remote Runner
                                                          │
                                                   adapter ──▶ vendor CLI
                                                          │ MCP requests + result stream
                                                          ▼
                                                      Server Hub
                                                          │ validate + emit
                                                          ▼
                                                      Event Core
                                                          │
                              ┌───────────────────────────┼──────────────────────┐
                              ▼                           ▼                      ▼
                         Run / Task State           Project Memory         Human Surfaces
```

The loop closes: what the human sees in Project Pulse is a reduction of the same
events the Task Engine used to advance state. There is no second source of truth.
For ENTRY, canonical Conversation / Run commands write the formal Event Store and
a Hub-side application / read-model adapter applies formal reducers. The product
client receives typed, sourced projections; it does not import domain code or
reduce raw events. The pre-v1 Spike JSONL log stays diagnostic and read-only, not
a dual-write target or implicit migration source.

## Layers

```
┌──────────────────────────────────────────────────────┐
│  apps/macos            Execution, Pulse, Library    │  presentation
│  apps/hub              server composition root     │  control plane
│  apps/runner           local / remote execution    │  execution plane
├──────────────────────────────────────────────────────┤
│  mcp-server            protocol ingress             │  boundary
├──────────────────────────────────────────────────────┤
│  agent-sdk · task-engine · memory-core               │  integration + domain
├──────────────────────────────────────────────────────┤
│  event-core            bus, store, reducers         │  kernel
└──────────────────────────────────────────────────────┘
```

This is the formal target layering. The executable Hub and Runner currently
remain co-composed under `apps/chat-spike`; ENTRY reuses that backend while
`apps/macos` stays the one product client.

Rule: a layer may depend downward only, so `event-core` sits at the **bottom**
and has zero internal workspace dependencies. Pure schema and storage runtime
libraries do not reverse that graph. It must compile with no knowledge that a
UI, an AI vendor, or even the other four packages exist. The domain packages
register reducers into it, never the reverse. See
[ADR-005](../decisions/ADR-005-derived-state-only.md) and
[packages.md](packages.md).

## Components

| Component | Responsibility | Never does |
| --- | --- | --- |
| **Conversation / Run (ENTRY-1 target)** | Give a project session durable execution identity and terminal facts | Treat a vendor session or live stream as project truth |
| **Supervisor Agent** | Optionally decompose goals, assign work, detect drift | Block the first direct Code Agent prompt or execute work itself |
| **Server Hub** | Authenticate, route, dispatch; own events and project metadata | Start a vendor CLI or open a working copy |
| **Agent Runtime** | Track `(agent, host)` lifecycle and match capability to task | Know vendor-specific APIs outside an adapter |
| **Runner** | Own adapters, vendor sessions and project working copies | Write the Hub event store directly |
| **MCP Server** | Validate and admit authenticated agent calls, emit events | Trust caller identity from a body field |
| **Event Core** | Validate versioned record shapes; append, order, persist, replay, reduce | Interpret domain meaning or authorize transitions |
| **Task Engine** | Enforce legal state transitions | Talk to agents directly |
| **Memory Core** | Turn event history into durable knowledge | Store raw transcripts as knowledge |
| **Approval Gate** | Suspend risky actions pending a human | Auto-approve on timeout |

## Why events are the kernel

Three product requirements collapse into one mechanism:

- *Project Pulse* needs a narrative of what happened today → replay the day's events.
- *Revival Mode* needs to explain a project abandoned a year ago → replay everything.
- *Canvas* needs live agent state → subscribe to the same stream.

Building these on a mutable database would require three separate change-tracking
systems. Building them on an event log requires none.

## Trust boundary

Everything an external agent sends crosses one boundary — the MCP Server — and is
authenticated and validated there. A credential maps to a principal on the Hub;
a claimed caller id is not authority. An agent cannot write an event directly,
set task status, or mark its own high-risk action approved. It can only
*request*; the runtime decides and emits.

```
external agent ──MCP──▶ Server Hub ──▶ [authenticate, authorize, validate]
                                                     │
                                      ┌──────────────┴─────────────┐
                                      ▼                            ▼
                                  Event Core              Approval Gate ──▶ human
```

Runners connect outbound and receive work over that established connection.
Vendor credentials and working files never cross this trust boundary.
