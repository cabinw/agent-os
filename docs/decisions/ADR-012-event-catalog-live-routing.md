# ADR-012: Event Catalog with Live Placement Routing

Status: accepted

## Context

Agent registrations are permanent project facts, but reachability and load are
process state. Replaying `agent.registered` after a Hub restart cannot prove the
Runner is still connected. V1 `task.assigned` records the logical executor, not
the chosen host, and same-host reconnect deliberately emits no duplicate
registration event.

The Hub Spike uses one `busy` boolean and first-match ordering. That does not
enforce logical concurrency across hosts and makes equal matches depend on map
insertion order.

## Decision

`task-engine` exposes two pure layers:

1. An event-derived Agent Catalog reduces `agent.registered`,
   `agent.status.changed` and `agent.disconnected`. Placement identity is
   `(agent, host)`. Logical fields and `concurrency` must agree across an
   agent's placements; capabilities may differ by host.
2. Routing joins that catalog with a caller-supplied live placement snapshot.
   The snapshot contains authenticated reachability, whether the placement is
   accepting work and its active dispatch count. It is never persisted as
   project truth.

A route candidate must contain every required capability, have a reachable and
accepting placement, and remain below the logical agent's concurrency after
active counts are summed across all hosts.

Candidates use one deterministic order:

1. full required-capability match;
2. lower logical load ratio;
3. lower placement load;
4. higher accepted-result rate with Laplace smoothing;
5. lexical agent id, then host id.

Only `completed` and `failed` tasks score past outcomes. Cancelled work is not an
agent result. Routing never reads `provider` or integration capability.

No match is a value, not an exception or silent empty list. The result names one
of `no-capability`, `unreachable`, `unavailable` or `saturated`; the command
layer keeps the task `created` and surfaces that reason.

The chosen host remains Hub operational state. V1 `task.assigned` continues to
record only the logical executor and `matchedBy`.

## Alternatives

**Persist reachability in the catalog.** Rejected: restart turns stale
registrations into apparently live agents, and same-host reconnect has no new
event.

**Store host on `task.assigned`.** Rejected: host placement is dispatch state,
not task truth, and changing the frozen v1 payload requires a protocol version.

**Copy the Spike's first idle match.** Rejected: insertion order is not a policy,
one boolean cannot enforce cross-host concurrency, and historical results never
participate.

## Consequences

- Replay rebuilds the durable catalog exactly; live routing is safe after a
  restart only when the Runner snapshot is supplied.
- Registration changes replace vendors without changing routing code.
- Hub admission must reserve a placement atomically before appending
  `task.assigned`; the pure selector does not prevent two callers choosing the
  same final slot.
- Historical scoring is per logical agent because v1 task events do not record
  host placement.
