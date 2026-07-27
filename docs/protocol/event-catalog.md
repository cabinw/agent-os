# Event Catalog

**Canonical.** Every event name in Agent OS. Nothing may emit a type absent from
this list; adding a type means adding it here first.

Envelope is specified in [architecture/event-core.md](../architecture/event-core.md).

## Naming

`<domain>.<subject>.<pastTenseVerb>` — lowercase, dot-separated, always past
tense. Events record what happened, never what should happen.

## agent.*

| Event | Payload | Emitted when |
| --- | --- | --- |
| `agent.registered` | `{ id, name, provider, role, capabilities }` | An agent joins a project |
| `agent.status.changed` | `{ from, to, reason? }` | idle / working / waiting / blocked transitions |
| `agent.disconnected` | `{ id, graceful }` | Heartbeat lost or clean exit |

## task.*

| Event | Payload | Emitted when |
| --- | --- | --- |
| `task.created` | `{ title, goal, requires, priority, dependsOn }` | `create_task` |
| `task.assigned` | `{ executor, matchedBy }` | `assign_task` or capability match |
| `task.started` | `{ executor }` | Executor accepts and begins |
| `task.progress.updated` | `{ progress, note? }` | `update_task` |
| `task.blocked` | `{ reason, severity, needs }` | `notify_blocked` |
| `task.unblocked` | `{ resolution }` | Blocker cleared |
| `task.review.requested` | `{ summary, outputs }` | `report_result` |
| `task.completed` | `{ acceptedBy }` | Review accepted |
| `task.failed` | `{ reason, attempts }` | Unrecoverable |
| `task.cancelled` | `{ by, reason }` | Withdrawn by human or Supervisor |

## message.*

| Event | Payload | Emitted when |
| --- | --- | --- |
| `message.sent` | `{ from, to, type, task?, content, replyTo?, attachments? }` | `send_message`, or a human posting into a thread |

`to` is an agent id or `"*"` (every agent on the task). `actor.kind` on the
envelope distinguishes an agent sender from a human one — a human message is
guidance and **never** satisfies a pending approval. Thread membership is derived
from `task`; see [ADR-006](../decisions/ADR-006-threads-as-a-view-in-agents.md).

## approval.*

| Event | Payload | Emitted when |
| --- | --- | --- |
| `approval.requested` | `{ action, risk, reversible, requestedBy, task? }` | `request_approval` |
| `approval.granted` | `{ by, note? }` | Human approves |
| `approval.rejected` | `{ by, reason }` | Human declines |
| `approval.expired` | `{ after }` | No answer within the window — never an implicit grant |

## knowledge.*

| Event | Payload | Emitted when |
| --- | --- | --- |
| `knowledge.created` | `{ type, title, summary, sourceEvents }` | Memory Core extracts an item |
| `knowledge.linked` | `{ from, to, relation }` | Graph edge formed |
| `knowledge.superseded` | `{ old, new }` | A later decision replaces an earlier one |

## project.*

| Event | Payload | Emitted when |
| --- | --- | --- |
| `project.created` | `{ name, stack }` | New project |
| `project.state.changed` | `{ from, to }` | active / paused / archived / completed |
| `project.snapshot.captured` | `{ label, image, at }` | A visual checkpoint is recorded |
| `project.revived` | `{ dormantDays, plan }` | Revival Mode generates a restart plan |

## pulse.*

| Event | Payload | Emitted when |
| --- | --- | --- |
| `pulse.story.generated` | `{ headline, body, sourceEvents }` | The daily digest produces a story |

Replaces the former `news.generated`.

## Compensation

There is no delete or edit. An incorrect event is corrected by appending a
compensating event that references it via `causedBy`. Reducers must therefore
tolerate corrections rather than assume monotonic truth.
