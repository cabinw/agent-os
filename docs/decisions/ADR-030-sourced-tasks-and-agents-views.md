# ADR-030: Sourced Tasks and Agents Views

Status: accepted

## Context

Task progress, lifecycle, durable Agent Catalog facts and live Runner state are
different data. A surface that flattens them will call 100% progress completed,
or call a disconnected registration healthy. An unassigned task also needs an
explicit routing diagnosis.

## Decision

Build one `ProjectWorkforce` read model from:

```
project + complete contiguous history
observedAt
authenticated live placements { agent, host, accepting, active }
```

Replay Task and Agent Catalog projections. Validate live placements against the
catalog before deriving any view.

Each task exposes lifecycle status and advisory progress separately. A task at
100% in `review` renders `awaiting-human-review`; it is not completed.

For a created task without an executor:

1. unmet dependencies → `waiting-dependency`
2. selectable live candidate → `awaiting-assignment`
3. otherwise preserve `selectAgentPlacement` reason:
   `no-capability`, `unreachable`, `unavailable` or `saturated`

Agents merge placements by logical agent id. Durable identity, role, provider,
concurrency and declared integration come from registration events. Connected,
accepting and active-dispatch counts come only from the supplied live snapshot.
Provider is display metadata and is never a branch.

Capability coverage iterates the controlled canonical vocabulary. A capability
is covered only by a connected, accepting placement. The surface may show
completed/failed Task outcomes and current active dispatches. It does not show a
heartbeat age or throughput rate because the live contract has neither a
heartbeat timestamp nor an observation interval.

Agents has a `roster / threads` header toggle. RM-3.6 implements roster and an
honest threads-pending state; RM-3.7 supplies the thread reader.

All derived entries carry source event ids. `observedAt` is displayed as the
live snapshot time and is not an event.

## Alternatives

**Treat progress 100 as done.** Rejected: Task lifecycle completion requires
human acceptance after review.

**Infer unassigned reason from missing executor.** Rejected: capability,
reachability, availability, saturation and dependencies require different
actions.

**Replay registrations as runtime health.** Rejected: a durable registration
can survive a Hub restart while its Runner is offline.

## Consequences

- The composition layer rejects mixed/gapped/duplicate history and invalid or
  duplicate live placements.
- Tasks and Agents consume one shared view so assignment and coverage cannot
  disagree.
- Adding heartbeat or throughput requires extending the authenticated live
  snapshot contract and its tests first.
