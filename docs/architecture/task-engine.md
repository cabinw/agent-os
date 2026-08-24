# Task Engine

Tasks are the bridge between a human goal and agent execution. The Task Engine
owns the lifecycle and refuses illegal transitions.

## Lifecycle

Canonical. See [ADR-002](../decisions/ADR-002-task-lifecycle.md).

```
                    ┌──────────────┐
                    │   created    │
                    └──────┬───────┘
                           │ assign_task
                    ┌──────▼───────┐
                    │   assigned   │
                    └──────┬───────┘
                           │ agent accepts
                    ┌──────▼───────┐      notify_blocked     ┌───────────┐
                    │   running    │ ──────────────────────▶ │  blocked  │
                    │              │ ◀────────────────────── │           │
                    └──────┬───────┘      blocker resolved   └───────────┘
                           │ report_result
                    ┌──────▼───────┐
                    │    review    │  human acceptance only
                    └──────┬───────┘
              accepted     │      rejected → back to running
                    ┌──────▼───────┐
                    │  completed   │
                    └──────────────┘

   any non-terminal ──▶ cancelled          running/review ──▶ failed
```

`blocked` is a bypass, not a stage: a task returns to `running` with its progress
intact. Terminal states are `completed`, `failed`, `cancelled`.

`task.started` also moves `review → running` when rejected work begins rework.
All other legal edges are the exhaustive matrix in ADR-002. Any unlisted pair
throws during command admission and replay.

## Model

```json
{
  "id": "TASK-014",
  "project": "proj_oldwebsite",
  "title": "Implement payment webhook handler",
  "goal": "GOAL-003",
  "owner": "claude-architect",
  "executor": "codex-developer",
  "status": "running",
  "progress": 65,
  "priority": "high",
  "dependsOn": ["TASK-011"],
  "outputs": [],
  "knowledge": ["KN-021"],
  "requiresApproval": false
}
```

`owner` is accountable for the outcome; `executor` does the work. They differ
whenever one agent delegates to another, which is the normal case.

## Assignment

The engine does not pick an agent by name. It asks the Agent Runtime for an
`(agent, host)` placement that satisfies the task's required capabilities and is
not saturated. The task stores the logical agent as `executor`; the runtime
placement supplies the host used for dispatch.

```
task.requires = ["coding", "testing"]
        │
        ▼
find_agent(capabilities) ──▶ `(agent, host)` candidates ranked by
                              (capability match, current load,
                               capability outcomes, global outcomes)
```

If no candidate exists the task stays `created` and the Supervisor is notified —
it never silently sits unassigned.

The human Tasks/Agents surface follows
[ADR-030](../decisions/ADR-030-sourced-tasks-and-agents-views.md). It preserves
the exact routing diagnosis (`no-capability`, `unreachable`, `unavailable` or
`saturated`) and keeps dependency waiting distinct from runtime assignment.

The durable Agent Catalog and live routing inputs are separate:

```
agent.* events ──▶ catalog `(agent, host)` facts
Runner snapshot ─▶ reachable · accepting · active dispatches
task projection ─▶ completed / failed outcomes and duration
                   by logical executor × required capability
                         │
                         ▼
                  rankAgentPlacements(...)
```

`reduceAgentCatalog` validates registration identity and lifecycle replay.
`rankAgentPlacements` joins it with authenticated live telemetry. It requires a
full capability match, sums active dispatches across hosts against logical
`concurrency`, then sorts by logical load ratio, placement load,
Laplace-smoothed required-capability score, global accepted-result rate and
lexical `(agent, host)` tie-breakers. `deriveAgentPerformance` also reports
average observed task duration; no performance state is stored. It never reads
`provider` or integration capability. See
[ADR-039](../decisions/ADR-039-agent-performance-is-derived-per-capability.md).

`selectAgentPlacement` returns either a chosen candidate or an explicit
`no-capability`, `unreachable`, `unavailable` or `saturated` result. The Hub must
reserve the selected placement atomically before appending `task.assigned`; the
chosen host remains operational state. See
[ADR-012](../decisions/ADR-012-event-catalog-live-routing.md).

Autonomous routing subscribes to durable work, availability and capacity
events. It selects one ready task by priority, creation time and id, then asks
Runtime to atomically reserve the chosen placement and append
`task.assigned`. That assignment becomes the fresh trigger for the next task.
Projects serialize independently; no-match and reservation conflict stay typed
results rather than silent retries. See
[ADR-038](../decisions/ADR-038-autonomous-routing-is-serialized-event-reconciliation.md).

## Dependencies

A task with unmet `dependsOn` cannot leave `created`. When a dependency reaches
`completed` the engine re-evaluates readiness. Cycles are rejected at creation.

Single creation references existing same-project tasks only. A Supervisor batch
may use forward references inside the batch, but `validateTaskPlan` validates
the complete proposed graph before any append and returns deterministic
topological order. `readyTaskIds` and `unmetDependencies` are pure selectors;
there is no stored ready flag. `task.assigned` fails admission and replay while
any dependency is not `completed`. See
[ADR-011](../decisions/ADR-011-task-dependency-admission.md).

## Progress

Progress is agent-reported and advisory. It drives UI only — never state
transitions. A task at 100% progress is still `running` until `report_result`
arrives, because the agent, not the percentage, declares completion.

The Tasks view renders lifecycle and progress as separate fields. In
particular, 100% in `review` is waiting for human review, not complete.

## Approval coupling

Every `report_result` enters `review`. If `requiresApproval` is set, the Approval
Gate must additionally grant before `task.completed` is admitted. There is no
direct `running → completed` path. See
[product/approvals.md](../product/approvals.md).

## Thread projection

`task-engine` also owns the pure thread projection. It creates one derived
thread per task plus the project thread, attributes messages directly, carries
approval attribution from request to decision, and fans related knowledge into
the named task threads. Lifecycle dividers and lossless progress runs remain in
project `seq` order. Replay rejects missing task, approval and reply references;
snapshot state is strict and versioned. See
[ADR-018](../decisions/ADR-018-thread-projection-attribution.md).

## Emitted events

`task.created`, `task.assigned`, `task.started`, `task.progress.updated`,
`task.blocked`, `task.unblocked`, `task.review.requested`, `task.completed`,
`task.failed`, `task.cancelled`.
