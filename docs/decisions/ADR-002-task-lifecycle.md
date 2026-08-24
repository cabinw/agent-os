# ADR-002: One Task Lifecycle

Status: accepted

## Context

Three incompatible lifecycles existed across the specs:

| Source | States |
| --- | --- |
| MCP protocol v0.2 | `CREATED → ASSIGNED → RUNNING → BLOCKED → REVIEW → COMPLETED` |
| `task-schema.md` | `planned, assigned, running, blocked, reviewing, completed` |
| Task Engine docs | `Created → Assigned → Running → Review → Completed` (no blocked) |

They disagreed on the initial state name, on casing, on whether `blocked` exists,
and on `review` vs `reviewing`. Any implementation would have had to pick one and
silently contradict two documents.

## Decision

One lifecycle, lowercase everywhere including JSON:

```
created · assigned · running · blocked · review · completed · failed · cancelled
```

- `created` — not `planned`. The event is `task.created`; the state should match.
- `blocked` is a **bypass state**, not a stage. It is entered from `running` and
  returns to `running` with progress intact.
- `review` — noun, matching `task.review.requested`.
- `failed` and `cancelled` added. Both were missing everywhere, yet both are
  reachable in reality: agents fail, humans change their minds.
- Terminal: `completed`, `failed`, `cancelled`.

The ten canonical `task.*` events have one exhaustive matrix:

| Current | Event | Next |
| --- | --- | --- |
| absent | `task.created` | `created` |
| `created` | `task.assigned` | `assigned` |
| `assigned` | `task.started` | `running` |
| `running` | `task.progress.updated` | `running` |
| `running` | `task.blocked` | `blocked` |
| `blocked` | `task.unblocked` | `running` |
| `running` | `task.review.requested` | `review` |
| `review` | `task.started` | `running` |
| `review` | `task.completed` | `completed` |
| `running`, `review` | `task.failed` | `failed` |
| any non-terminal | `task.cancelled` | `cancelled` |

Every other state/event pair is illegal. `task.started` from `review` means the
executor has begun rework after rejection; the rejection itself remains an
approval/review fact. A duplicate `task.created` is illegal, not idempotence —
command idempotence is handled before event creation.

Every reported result emits `task.review.requested`. `requiresApproval` decides
whether the Approval Gate must also grant before `task.completed`; it does not
create a direct `running → completed` edge.

## Alternatives

**Keep `BLOCKED` in the linear chain**, as v0.2 implied. Rejected: it suggests
blocked work progresses toward review, when in fact it resumes where it stopped.
Modelling it as a stage would also force an arbitrary answer to "what is the
progress of a blocked task?"

**Add `paused`.** Rejected as redundant with `blocked` + `needs: human`; the
distinction did not survive a concrete example.

## Consequences

- `progress` never causes a transition. A task at 100% is `running` until the
  agent reports a result.
- A task requiring approval cannot reach `completed` without passing `review`.
- An illegal task event fails admission and replay loudly; reducers do not turn
  corrupt history into a no-op.
- The transition matrix is small enough to test exhaustively, and that test is
  the guard against this drifting again.
