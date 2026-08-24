# Data Model

## Objects

```
Project ── the Hub container: metadata, decisions, agents, history
   │
Goal ───── a human-stated outcome
   │
Task ───── an executable unit of work
   │
Agent ──── the AI worker that executes it
   │
Event ──── an immutable record of something that happened
   │
Knowledge  durable, sourced conclusion
```

Message and Approval hang off this spine: a Message is agent-to-agent
communication scoped to a task, an Approval is a suspended action awaiting a
human. A Thread is the derived grouping of a task's messages — see
[product/threads.md](../product/threads.md). Host placement and vendor session
are operational runtime records; see [agent-runtime](agent-runtime.md).

## Definitions

| Object | Key fields | Notes |
| --- | --- | --- |
| **Project** | `id, name, gitRemote, state, stack, cover, lastActivity` | Hub metadata; working-copy paths belong to Runner hosts |
| **Goal** | `id, project, statement, status` | Decomposed by the Supervisor into tasks |
| **Task** | see [task-schema](../protocol/task-schema.md) | The unit routing and progress attach to |
| **Agent** | see [agent-schema](../protocol/agent-schema.md) | Logical identity is per project; capability is per `(agent, host)` placement |
| **Message** | event `id`; `from, to, type, task?, content, replyTo?, attachments?` | `replyTo` is message semantics; runtime-owned `causedBy` is execution causality |
| **Thread** | `project, task?` | **Derived, not stored.** One per task plus one project thread. See [ADR-006](../decisions/ADR-006-threads-as-a-view-in-agents.md) |
| **Event** | see [event-core](event-core.md) and [event-catalog](../protocol/event-catalog.md) | Versioned strict record; the only writable object |
| **Knowledge** | see [memory](memory.md) | Typed, sourced, supersedable |
| **Approval** | opaque approval subject `id`; `action, detail, requestedBy, risk, status` | status ∈ pending / granted / rejected / expired; request envelope id is separate |

## Ownership

Only Event is written directly. Everything else in this table is a *projection* —
a reducer's output over the event log. Creating a task means appending
`task.created`; the task row appears because a reducer put it there.

This is the single most important property to preserve while implementing. See
[ADR-005](../decisions/ADR-005-derived-state-only.md).

## Identity

- Projects, goals, agents: stable string ids, human-readable where useful
  (`proj_oldwebsite`, `codex-developer`).
- Tasks: `TASK-nnn`, unique per project, never reused.
- Events: sortable unique ids plus a per-project `seq`.
- Knowledge: `KN-nnn`, per project.
