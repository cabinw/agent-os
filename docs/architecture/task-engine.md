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
                    │    review    │  human or reviewing agent
                    └──────┬───────┘
              accepted     │      rejected → back to running
                    ┌──────▼───────┐
                    │  completed   │
                    └──────────────┘

   any non-terminal ──▶ cancelled          running/review ──▶ failed
```

`blocked` is a bypass, not a stage: a task returns to `running` with its progress
intact. Terminal states are `completed`, `failed`, `cancelled`.

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
                              (capability match, current load, past outcomes)
```

If no candidate exists the task stays `created` and the Supervisor is notified —
it never silently sits unassigned.

## Dependencies

A task with unmet `dependsOn` cannot leave `created`. When a dependency reaches
`completed` the engine re-evaluates readiness. Cycles are rejected at creation.

## Progress

Progress is agent-reported and advisory. It drives UI only — never state
transitions. A task at 100% progress is still `running` until `report_result`
arrives, because the agent, not the percentage, declares completion.

## Approval coupling

If `requiresApproval` is set, `review` is entered on `report_result` and the
Approval Gate is invoked. No path exists from `running` straight to `completed`
for such a task. See [product/approvals.md](../product/approvals.md).

## Emitted events

`task.created`, `task.assigned`, `task.started`, `task.progress.updated`,
`task.blocked`, `task.unblocked`, `task.review.requested`, `task.completed`,
`task.failed`, `task.cancelled`.
