# Roadmap

**Canonical.** Replaces the former Phase 4 MVP plan, Phase 5 core implementation
plan, Phase 6 bootstrap and Phase 6 roadmap — four documents describing the same
scope under three numbers.

## Current execution track

The executable chat spike precedes the formal package phases. ADR-008 fixes this
order; Remote Runner work does not start until Local Runner semantics pass.

| Order | Status | Deliverable | Done when |
| --- | --- | --- | --- |
| G | done | Restore quality gates; authenticate every capable Hub route | `pnpm verify` is green; caller identity comes from a server-side principal |
| LF | done | Strict Local Runner foundation | A real subprocess passes result / event / error, workspace-containment and restart-session tests |
| L | done | Add injectable Hub → Local Runner vertical slice | A real subprocess crosses Hub → Runner → adapter, records its reply and recovers after failure |
| C | next | Finish the shared Runner contract; remove direct-adapter fallback | Session, event stream, cancellation, retry, error and liveness cases have transport-neutral tests; Hub requires a Runner |
| R | pending | Remote Runner transport | The Local acceptance task runs unchanged; the normalized event sequence matches |
| 1.1 | pending | Formal Event Core | The proven envelope and contracts move into `packages/` |

The Hub is the server control plane and dispatches only. Project working copies,
vendor credentials and adapters stay on Runners. See
[ADR-008](../decisions/ADR-008-server-hub-local-first-runners.md).

## Phase 1 — Core loop

Goal: prove the runtime loop end to end, headless. No UI.

| Milestone | Deliverable | Done when |
| --- | --- | --- |
| 1.1 Event Core | Envelope, bus, store, replay, reducer registration | Replaying the log reproduces state exactly |
| 1.2 Task Engine | Lifecycle per ADR-002, dependencies, capability routing | Illegal transitions are rejected, not corrected |
| 1.3 MCP Server | All v0.3 tools, validated at the boundary | An external agent completes a task with no bespoke code |
| 1.4 Agent SDK | Shared Runner contract; register, dispatch, report; one adapter | Local and Remote transports execute the same task type identically |
| 1.5 Demo | Supervisor → task → agent → events → status | The scenario below runs from a script |

Demo scenario: a supervisor creates a task, Agent OS routes it by capability, the
executing agent reports progress and a result, and project status updates — all
observable as events.

## Phase 2 — Memory

| Milestone | Deliverable |
| --- | --- |
| 2.1 | Knowledge extraction pipeline from events |
| 2.2 | Typed, sourced knowledge items with superseding |
| 2.3 | `get_context` — agents start work with prior decisions loaded |
| 2.4 | Query and graph API |

Phase 2 is where the product becomes different from a task tracker. Do not defer
it to chase UI.

## Phase 3 — Human surfaces

| Milestone | Deliverable |
| --- | --- |
| 3.1 | Project Pulse |
| 3.2 | Project Library and Project Detail |
| 3.3 | Approval Gate and menu-bar extra |
| 3.4 | Tasks and Agents views |
| 3.5 | Threads — thread reader in Agents, embedded thread in Task Detail |

The thread reducer (grouping messages by task, interleaving lifecycle events) can
land in Phase 1 alongside the other reducers; only the surface waits for Phase 3.

## Phase 4 — Revival and Canvas

| Milestone | Deliverable |
| --- | --- |
| 4.1 | Revival Mode report and restart plan |
| 4.2 | Project snapshots and filmstrip |
| 4.3 | Canvas, all three zoom levels |
| 4.4 | Knowledge Graph view inside Memory |

## Phase 5 — Multi-agent depth

Agent negotiation, multi-agent planning, autonomous routing, performance
analytics. Deliberately last: each of these is only meaningful once the log,
memory and approval gate are trustworthy.

## Package sequencing rule

Build downward-dependency-first: `event-core` → `task-engine` → `mcp-server` →
`agent-sdk` → `memory-core` → UI. A UI built before the reducers exist will
invent state, and that state will be wrong. This is the dependency order inside
the formal packages; it does not reverse the current spike track above.
