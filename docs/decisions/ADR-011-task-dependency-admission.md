# ADR-011: Task Dependencies Are Admitted Before Events

Status: accepted

## Context

`task.created.dependsOn` is immutable. If every creation may reference only an
already stored task, cycles other than self-dependency are structurally
impossible. Supervisor planning still needs forward references inside one task
batch, so "reject cycles at creation" otherwise has no meaningful input.

Persisting a separate ready flag would also violate ADR-005: readiness is fully
derivable from task events.

## Decision

- A single task creation may reference only tasks already present in the same
  project.
- A batch plan may reference existing tasks and ids in that same batch. The
  complete proposed graph is validated for duplicate ids, missing references
  and cycles before any event is appended.
- Accepted batches are emitted in deterministic topological order; task id is
  the tie-breaker.
- A task is ready exactly when it is `created` and every dependency is
  `completed`.
- `task.assigned` admission and replay both reject an unready task. Dependency
  completion changes the derived ready set without writing a readiness event or
  row.
- Failed or cancelled dependencies remain unmet. Policy for replacing them
  belongs to the Supervisor, not the graph reducer.

## Alternatives

**Allow unresolved references in the permanent log.** Rejected: replay would
temporarily contain an invalid task and could observe different readiness by
event position.

**Store `ready` and update dependents.** Rejected: it is derived state and can
drift from dependency status.

**Skip cycle detection because single creates cannot cycle.** Rejected: batch
planning is the real graph admission boundary and must reject the whole plan
before partial append.

## Consequences

- Batch append is all-or-nothing at the command layer; RM-1.2b supplies the
  validation and ordering, while multi-event command transaction composition
  remains a Hub concern.
- Ready-set recomputation is deterministic and replay-safe.
- Dependency edges remain immutable in v1. Changing them requires a new
  catalogued event and reducer semantics.
