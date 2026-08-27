# Roadmap

**Canonical.** Replaces the former Phase 4 MVP plan, Phase 5 core implementation
plan, Phase 6 bootstrap and Phase 6 roadmap — four documents describing the same
scope under three numbers.

## Current product-entry track

The formal kernel, memory, human surfaces, Local / Remote Runner and production
deployment tracks are implemented. Real first-use testing reopened the product
entry: the existing Pulse / New task shell is not a conventional Code Agent
workflow. ADR-047 fixes the new order.

| Order | Status | Deliverable | Done when |
| --- | --- | --- | --- |
| ENTRY-0 | done | Product decision and cold handoff | ADR-047, canonical docs, board and `HANDOFF.md` agree |
| ENTRY-1 | in progress (15%) | Conversation / Run contract | Conversation, Run, Vendor Session and optional Task have non-overlapping identity, lifecycle and replay semantics; two Conversations cannot share a vendor handle |
| ENTRY-2 | pending | Project placement and readiness | Stable Project id maps `(project, runnerHost)` to an authorized working copy; readiness covers executable, auth, Runner, workspace and capacity facts |
| ENTRY-3 | pending | One product entry and local vertical slice | `apps/macos` route `execution` runs at least one real Codex or Claude safely in the selected workspace; 4173 remains diagnostic |
| ENTRY-4 | pending | Execution evidence and memory | Changed files, tests, accepted outputs and decisions are sourced, inspectable and available to a later cold session |
| ENTRY-5 | pending | Remote and multi-agent exposure | The same entry can place work remotely and show delegation without turning team setup into first-use configuration |

ENTRY-1 through ENTRY-4 are the only active product route. Do not start ENTRY-5
until the local first-use browser journey passes. See
[HANDOFF](../../HANDOFF.md) for the exact acceptance path.

## Completed foundation track

The executable chat spike precedes the formal package phases. ADR-008 fixes this
order; Remote Runner work does not start until Local Runner semantics pass.

| Order | Status | Deliverable | Done when |
| --- | --- | --- | --- |
| G | done | Restore quality gates; authenticate every capable Hub route | `pnpm verify` is green; caller identity comes from a server-side principal |
| LF | done | Strict Local Runner foundation | A real subprocess passes result / event / error, workspace-containment and restart-session tests |
| L | done | Add injectable Hub → Local Runner vertical slice | A real subprocess crosses Hub → Runner → adapter, records its reply and recovers after failure |
| C | done | Finish the shared Runner contract; remove direct-adapter fallback | Session, event stream, cancellation, retry, error and liveness cases have transport-neutral tests; Hub requires a Runner |
| R | done | Remote Runner transport | The Local acceptance task runs unchanged; the normalized event sequence matches |
| 1.1a | done | Versioned strict Event Contract | The v1 envelope, current 38 payload types, ULID, subject rules and type contract live in `packages/event-core` |
| SVR | done | Server Hub deployment and Windows Worker validation | Trusted deployment, recovery and real cross-host evidence pass without weakening HTTPS or identity boundaries |
| 1.1b | done | SQLite Event Store | Transactional sequence allocation and idempotent append replace the throwaway JSONL truth source in the formal kernel |

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

Live execution uses nested work-item ids without redefining the public
milestones:

| Milestone | Work items |
| --- | --- |
| 1.1 Event Core | `1.1a` envelope/schema/ULID · `1.1b` SQLite store · `1.1c` bus/replay/reducers · `1.1d` snapshots |
| 1.2 Task Engine | `1.2a` lifecycle matrix · `1.2b` dependency graph · `1.2c` capability routing |
| 1.3 MCP Server | `1.3a` 12 strict tools · `1.3b` authorization boundary · `1.3c` approval gate |
| 1.4 Agent SDK | `1.4a` SDK and first formal adapter |
| 1.5 Demo | `1.5a` Supervisor · `1.5b` thread reducer · `1.5c` end-to-end script |

Demo scenario: a supervisor creates a task, Agent OS routes it by capability, the
executing agent reports progress and a result, and project status updates — all
observable as events. `apps/core-demo` uses deterministic scripted Planner and
Runner fixtures around the formal packages, persists to SQLite, crosses MCP for
agent participation, keeps human grant/accept outside MCP, and requires live and
replayed projections to match. See
[ADR-019](../decisions/ADR-019-phase-one-demo-composition.md).

## Phase 2 — Memory

| Milestone | Deliverable |
| --- | --- |
| 2.1 | Knowledge item model and structural extraction triggers |
| 2.2 | Windowed extraction with runtime-owned causal sources |
| 2.3 | Immutable linear decision supersession |
| 2.4 | `get_context` — active decisions and upstream outputs |
| 2.5 | Query and graph API |

Phase 2 is implemented in the formal packages. ENTRY-4 must connect that memory
to the live Code Agent composition; package completion alone is not product
integration.

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
analytics. These foundations are implemented. ADR-047 changes how they appear:
delegation stays an execution strategy behind a primary Code Agent session
rather than first-use team configuration.

## Package sequencing rule

Build permanent domain changes downward-dependency-first: `event-core` →
`task-engine` → `mcp-server` → `agent-sdk` → `memory-core` → UI. The ENTRY track
is a vertical integration over implemented packages; any new Conversation / Run
fact still follows catalog → reducer → replay test → emitter → UI.
