# ADR-038: Autonomous Routing Is Serialized Event Reconciliation

Status: accepted

## Context

Task Engine already derives readiness and deterministically ranks live agent
placements. No service reacts to those facts without a Supervisor or MCP
assignment call. Routing multiple ready tasks from one snapshot would also
reuse stale load and can oversubscribe the final concurrency slot.

## Decision

`AutonomousTaskRouter` reacts to durable events that can add ready work, change
agent availability or free execution capacity. It reads current Task and Agent
Catalog projections plus authenticated live placement telemetry, then considers
exactly one ready task.

Ready tasks sort by priority, creation time and Task id. Placement selection
reuses `selectAgentPlacement`; provider and role remain absent. A successful
assignment produces another `task.assigned` trigger, so the next ready task is
evaluated only after Runtime has published updated state.

Routing calls are serialized per project and independent across projects. The
Runtime Port receives the chosen logical agent and operational host plus an
expected `created` status, triggering event id and deterministic operation
token. It must atomically reserve the placement and append `task.assigned`,
returning `assigned` or `conflict`. The router never reserves or appends itself.

No match remains a typed decision (`no-capability`, `unreachable`,
`unavailable`, `saturated`) and leaves the task `created`. A later relevant
event retries reconciliation. Live telemetry stays operational input and is not
persisted as project truth.

## Alternatives

**Route every ready task in one pass.** Rejected: subsequent choices use stale
placement load unless reservation and projection updates are observed.

**Let the Supervisor call `assign_task`.** Rejected: routine deterministic
matching does not require model judgment and creates avoidable intervention.

**Persist live reachability.** Rejected by ADR-012: restart makes it stale.

**Retry conflicts in a tight loop.** Rejected: the winning assignment or next
availability event is the correct fresh reconciliation trigger.

## Consequences

- Ready work advances from events without Supervisor participation.
- Final-slot races are contained by one atomic Runtime operation.
- Repeated delivery uses the same operation token and cannot duplicate assign.
- A no-match diagnosis is explicit without inventing a task lifecycle state.
