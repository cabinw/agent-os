# Event Catalog

**Canonical.** Every event name and v1 payload in Agent OS. Nothing may emit a
type absent from this list; adding a type means adding it here first.

Envelope and version rules are specified in
[architecture/event-core.md](../architecture/event-core.md) and
[ADR-009](../decisions/ADR-009-versioned-strict-event-contract.md).

## Naming

`<domain>.<qualifier?>.<pastTenseVerb>` — lowercase and dot-separated, with at
least two segments. The final segment records what happened; optional middle
segments qualify the fact (`task.review.requested`, `project.state.changed`).
The allowlist below, not a naming regex, is authoritative.

## V1 schema vocabulary

- Every payload and nested object is strict. `?` is the only marker for an
  optional field; `null` does not mean omitted.
- `NonEmptyString` is already trimmed and contains at least one character.
- `PositiveInt` is a safe integer ≥ 1. `FiniteNumber` excludes NaN and infinity.
- `RFC3339` is a full date-time with `Z` or an explicit offset.
- `Unique<T>` rejects duplicate array entries; `NonEmptyUnique<T>` also requires
  one entry.
- `EventId` is `evt_` plus one canonical uppercase Crockford ULID. `TaskId` is
  `TASK-` plus at least three digits. `KnowledgeId` is `KN-` plus at least three
  digits. Other ids are opaque, already trimmed strings of 1..256 characters
  with no C0 or DEL control characters.
- Subject kind follows event domain: `agent.* → agent`, `task.* → task`,
  `approval.* → approval`, `knowledge.* → knowledge`, `project.* → project`,
  `artifact.* → artifact`, `measurement.* → measurement`, and
  `pulse.* → pulse`. `message.sent` is the scoped exception described below.

Controlled values:

```
ActorKind     human · agent · system
Role          supervisor · architect · developer · researcher · reviewer · designer
Capability    architecture · coding · testing · review · research · design
              writing · data · ops · git
AgentStatus   idle · working · waiting · blocked
PriorityRisk  low · medium · high · critical
MessageType   instruction · question · answer · progress · report · review · warning
KnowledgeType decision · research · technical-note · task-summary · milestone · discussion
ProjectState  active · paused · archived · completed
```

`Integration` is strict
`{ participates, streaming, reasoning, session, usage }`, all booleans.

## agent.*

| Event | V1 payload | Emitted when |
| --- | --- | --- |
| `agent.registered` | `{ id, name, provider, role: Role, parentAgent?, concurrency: PositiveInt, host, capabilities: Unique<Capability>, integration: Integration }` | An authenticated agent placement joins a project |
| `agent.status.changed` | `{ host, from: AgentStatus, to: AgentStatus, reason? }` | idle / working / waiting / blocked transitions; `from != to` |
| `agent.disconnected` | `{ id, host, graceful: boolean }` | Heartbeat lost or clean exit |

`host` is runtime-owned and identifies the authenticated Runner placement. It is
required in formal v1 events. Effective capability belongs to `(agent, host)`;
same-host reconnect is idempotent, while a new host is a new placement fact.
For registration and disconnection, duplicated payload `id` must equal the
agent subject id.

## task.*

| Event | V1 payload | Emitted when |
| --- | --- | --- |
| `task.created` | `{ title, goal, description?, requires: Unique<Capability>, priority: PriorityRisk, dependsOn: Unique<TaskId>, requiresApproval: boolean }` | `create_task` |
| `task.assigned` | `{ executor, matchedBy: "explicit" \| "capability" }` | `assign_task` or capability match |
| `task.started` | `{ executor }` | Executor accepts and begins |
| `task.progress.updated` | `{ progress: FiniteNumber 0..100, note? }` | `update_task` |
| `task.blocked` | `{ reason, severity: PriorityRisk, needs: "human" \| "agent" \| "resource" }` | `notify_blocked` |
| `task.unblocked` | `{ resolution }` | Blocker cleared |
| `task.review.requested` | `{ summary, outputs: Unique<NonEmptyString> }` | A completed result is submitted by `report_result` |
| `task.completed` | `{ acceptedBy }` | Human accepts review |
| `task.failed` | `{ reason, attempts: PositiveInt }` | Executor reports an unrecoverable result |
| `task.cancelled` | `{ by, reason }` | Withdrawn by human or Supervisor |

Task id is the envelope subject, project is the envelope project, owner is the
actor and creation time is envelope `at`; payloads never repeat them. A task may
not depend on its own subject id, and task subjects use canonical `TASK-nnn`
shape. Dependency existence and cycle checks belong to Task Engine.

## message.*

| Event | V1 payload | Emitted when |
| --- | --- | --- |
| `message.sent` | `{ from, to, type: MessageType, task?, content, replyTo?, attachments?: NonEmptyUnique<NonEmptyString> }` | `send_message`, or a human posting into a thread |

`to` is an agent id or `"*"` (every agent on the task). `actor.kind` on the
envelope distinguishes an agent sender from a human one — a human message is
guidance and **never** satisfies a pending approval. Thread membership is derived
from `task`; see [ADR-006](../decisions/ADR-006-threads-as-a-view-in-agents.md).

`replyTo` is a message-level reference used for quoting and answer matching. An
`answer` requires it. `causedBy` is separately runtime-owned and records what
triggered the execution; it may differ from `replyTo`, and caller-supplied
`replyTo` never controls causal budgets. If `task` is present, the envelope
subject is exactly that task; otherwise it is exactly the envelope project.

## approval.*

| Event | V1 payload | Emitted when |
| --- | --- | --- |
| `approval.requested` | `{ action, risk: PriorityRisk, reversible: boolean, requestedBy, task?, detail }` | `request_approval` with complete disclosure |
| `approval.granted` | `{ by, note? }` | Human approves |
| `approval.rejected` | `{ by, reason }` | Human declines |
| `approval.expired` | `{ after: RFC3339 }` | The planned deadline passes — never an implicit grant |

For `approval.expired`, payload `after` is the planned deadline and cannot be
later than envelope `at`. Approval authorization and pending-request lookup are
stateful admission checks, not Event Core schema checks.

## knowledge.*

| Event | V1 payload | Emitted when |
| --- | --- | --- |
| `knowledge.created` | `{ type: KnowledgeType, title, summary, sourceEvents: NonEmptyUnique<EventId>, rationale?, alternatives?: NonEmptyUnique<NonEmptyString>, relatedTasks?: NonEmptyUnique<TaskId> }` | Memory Core extracts or admits an item |
| `knowledge.linked` | `{ from, to, relation }` | A non-self graph edge forms |
| `knowledge.superseded` | `{ old: KnowledgeId, new: KnowledgeId }` | A later decision replaces an earlier one |

Decision knowledge requires `rationale`. Author and time derive from the
envelope. `knowledge.linked` endpoints are general entity ids because a
measurement may validate a knowledge item.

## project.*

| Event | V1 payload | Emitted when |
| --- | --- | --- |
| `project.created` | `{ name, stack: Unique<NonEmptyString> }` | New project |
| `project.state.changed` | `{ from: ProjectState, to: ProjectState }` | Project state changes; `from != to` |
| `project.snapshot.captured` | `{ label, image, at: RFC3339 }` | A visual checkpoint is recorded |
| `project.revived` | `{ dormantDays: PositiveInt, plan: NonEmptyArray<PlanStep> }` | Revival Mode generates a restart plan |

`PlanStep` is strict `{ title, estimateMinutes: PositiveInt, detail }`; array
order is execution order. Snapshot payload `at` is capture time and cannot be
later than envelope admission time. Every `project.*` subject id equals the
envelope project id.

## artifact.*

| Event | V1 payload | Emitted when |
| --- | --- | --- |
| `artifact.produced` | `{ path, kind, task: TaskId }` | An agent produces a document or asset worth keeping |
| `artifact.derived` | `{ path, from: NonEmptyUnique<NonEmptyString>, lens }` | An artifact is produced by digesting sources from one role's perspective |

**Payloads are deliberately minimal.** The content lives on disk and can be
re-analysed; the event records that it existed and where it came from. `from`
lists source paths or artifact references, `lens` names the reader perspective,
and a derived artifact cannot list its own path as a source.

## measurement.*

| Event | V1 payload | Emitted when |
| --- | --- | --- |
| `measurement.recorded` | `{ metric, value: FiniteNumber, unit, source, at: RFC3339 }` | External data about shipped work arrives |

`unit` is explicit and required; it is not embedded in `metric` or `value`.
Payload `at` is observation time and cannot be later than envelope admission
time. Link a measurement to the knowledge it bears on with `knowledge.linked`.

## pulse.*

| Event | V1 payload | Emitted when |
| --- | --- | --- |
| `pulse.story.generated` | `{ headline, body, sourceEvents: NonEmptyUnique<EventId> }` | The daily digest produces a durable sourced story |

KPI and headline ranking remain projections. The generated prose is stored
because an AI output cannot be reconstructed deterministically; `sourceEvents`
makes it auditable. This replaces the former `news.generated`.

## Compensation and evolution

There is no delete, edit or generic “corrected” event. An incorrect fact is
countered by a catalogued domain event whose reducer semantics state the effect,
linked through `causedBy`. If no existing event can express the correction, add
a reviewed type here first; causation alone never means reversal.

V1 payloads are frozen. Additive or breaking shape changes require another
`schemaVersion` (or a new event type) and retained old parsers. The pre-v1 Spike
JSONL omits required fields and contains experimental ones; importing it needs a
one-time migration, not a permissive formal parser.
