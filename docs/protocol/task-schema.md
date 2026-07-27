# Task Schema

## States

Canonical, lowercase, per [ADR-002](../decisions/ADR-002-task-lifecycle.md):

```
created · assigned · running · blocked · review · completed · failed · cancelled
```

Terminal: `completed`, `failed`, `cancelled`. `blocked` always returns to
`running`.

## Object

```json
{
  "id": "TASK-014",
  "project": "proj_oldwebsite",
  "goal": "GOAL-003",
  "title": "Implement payment webhook handler",
  "description": "Handle Stripe webhooks with idempotency keys.",
  "status": "running",
  "progress": 65,
  "priority": "high",
  "requires": ["coding"],
  "owner": "claude-architect",
  "executor": "codex-developer",
  "dependsOn": ["TASK-012"],
  "outputs": [],
  "knowledge": ["KN-021"],
  "requiresApproval": false,
  "createdAt": "2026-07-20T10:00:00Z",
  "startedAt": "2026-07-21T09:12:00Z"
}
```

## Fields

| Field | Notes |
| --- | --- |
| `requires` | Capability list used for routing. Set at creation; agents are matched to it. |
| `owner` | Accountable for the outcome. Usually the agent that created the task. |
| `executor` | Doing the work. Empty until assigned. |
| `progress` | 0–100, agent-reported, advisory only. Never triggers a transition. |
| `dependsOn` | Task cannot leave `created` until all are `completed`. Cycles rejected. |
| `outputs` | File paths, URLs or artifact ids produced. Populated at `report_result`. |
| `knowledge` | Knowledge items this task consumed or produced. |
| `requiresApproval` | Forces the Approval Gate before `completed`. |

## Priority

`low` · `medium` · `high` · `critical`. Affects routing order and Pulse
surfacing, not preemption — a running task is never interrupted by a
higher-priority arrival.
