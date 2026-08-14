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

## artifact.*

| Event | Payload | Emitted when |
| --- | --- | --- |
| `artifact.produced` | `{ path, kind, task }` | An agent produces a document or asset worth keeping |
| `artifact.derived` | `{ path, from, lens }` | An artifact is produced by digesting others from one role's perspective |

**Payloads are deliberately minimal.** The content lives on disk and can be
re-analysed at any time; the event only has to record *that it existed and where
it came from*. Anything richer — summaries, tags, chunk indexes — is derived,
and deriving it later is always possible. Failing to record the provenance is
not: an artifact whose origin was never written down cannot be traced back after
the fact.

`artifact.derived` carries the chain that makes a corpus usable. A research
corpus is read by different roles, and **each role reading it produces something
different** — the terrain designer's notes on a particle-system document are not
the VFX designer's. `from` lists the sources, `lens` names the perspective. That
chain is what lets a later task reuse a digest instead of re-reading the corpus.

## measurement.*

| Event | Payload | Emitted when |
| --- | --- | --- |
| `measurement.recorded` | `{ metric, value, source, at }` | External data about shipped work arrives |

The inbound half of the loop. Knowledge already carries `sourceEvents` — where a
conclusion *came from* — but nothing recorded what happened *because* of it. A
decision taken during research ("adopt a no-fail daily loop") is a hypothesis
until retention data either confirms or refutes it.

Recording measurements is what lets memory **grow rather than accumulate**: the
value of a long-lived role is not that it remembers more, it is that its
conclusions have been tested. Link a measurement to the knowledge it bears on
with `knowledge.linked`.

## pulse.*

| Event | Payload | Emitted when |
| --- | --- | --- |
| `pulse.story.generated` | `{ headline, body, sourceEvents }` | The daily digest produces a story |

Replaces the former `news.generated`.

## Compensation

There is no delete or edit. An incorrect event is corrected by appending a
compensating event that references it via `causedBy`. Reducers must therefore
tolerate corrections rather than assume monotonic truth.
