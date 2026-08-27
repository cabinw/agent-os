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

## Code session gap

[ADR-047](../decisions/ADR-047-code-session-first-product-entry.md) makes a
project-bound Code Agent session the product entry. The current canonical model
does not yet identify a user-visible Conversation or one prompt's executable
Run: `Thread(project, task?)` groups existing events, while Vendor Session is an
opaque Runner optimization.

The existing implementation name `ConversationProjectState` refers to that
thread projection: one project thread plus task threads. Its name does not make
it a named, reopenable Code Agent Conversation, and ENTRY-1 must either evolve
or clearly separate it without breaking historical replay.

The entry refactor must freeze these four concepts before implementation:

| Concept | Required distinction |
| --- | --- |
| Conversation | User-visible continuity; may contain multiple Runs |
| Run | One cancellable, recoverable prompt execution with a durable terminal fact |
| Vendor Session | Opaque continuation handle; never project truth |
| Task | Optional accountable work unit with dependencies and human review |

ADR-047 already fixes two isolation boundaries around that pending lifecycle:

- working-copy placement is `(project, runnerHost)`, not one Hub path and not an
  arbitrary browser-supplied absolute path;
- Vendor Session scope is `(user, project, conversation, agent)`, with only an
  explicit default Conversation allowed to adopt legacy three-part state.

Do not add fields to Task or treat a direct message as a durable Run to avoid
this decision. If Conversation / Run become stored domain identities, add a
focused ADR, catalog events and replay tests before emitters.

## Definitions

| Object | Key fields | Notes |
| --- | --- | --- |
| **Project** | `id, name, state, stack, humanParticipation, lastActivity` | Hub metadata; thread posting defaults off and changes only through its project event |
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
