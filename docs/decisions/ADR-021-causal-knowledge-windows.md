# ADR-021: Knowledge Sources Are Runtime-Owned Causal Windows

Status: accepted

## Context

RM-2.1 identifies structural candidate anchors, but an anchor alone reads like a
log line. Event Core validates the shape of `causedBy`; it deliberately does not
prove that the reference exists, precedes the child or belongs to the same
project. `message.replyTo`, approval subjects, task scope and artifact lineage
are separate semantic relations. Selecting adjacent events by sequence would
mix unrelated work and make `sourceEvents` decorative.

The v1 `knowledge.created` payload has one item-level `sourceEvents` set. It
cannot persist model-authored sentence citations without a new event version.
The extraction boundary must therefore own one exact evidence window for every
statement in the item.

## Decision

### Complete history and window construction

`buildKnowledgeWindow(history, anchorId)` accepts the complete project history
from sequence 1 through the current head. It strictly reparses every stored
event and requires one project, contiguous increasing sequence numbers, unique
event ids and one candidate anchor. Events after the anchor may be present but
never enter the window.

For every event through the anchor, `causedBy` must identify an earlier event in
that project. A message `replyTo` must identify an earlier message in the same
project/task thread. Missing, future, cross-thread or non-message references
fail closed. `replyTo` supplements the causal graph; it never replaces
runtime-owned `causedBy`.

The deterministic window is the sequence-ordered union of:

1. the anchor;
2. the transitive backward `causedBy` and message `replyTo` closure;
3. the earlier request for an approval decision with the same approval subject;
4. prior events through the anchor in each task directly named by the anchor,
   its reference closure or the matched approval request; and
5. transitive prior artifact events whose `path` is named by an
   `artifact.derived.from` entry already in the closure.

Direct task attribution is only `task.*` subject, `message.task`,
`approval.requested.task`, `artifact.produced.task` and
`knowledge.created.relatedTasks`. A dependency id or free-form string does not
expand the window. Task ids learned from an already included multi-task
knowledge item do not recursively pull another task history into this window.

The window must contain at least two distinct events. Its anchor is last, its
`sourceEvents` is exactly the ordered event-id list, and its `relatedTasks` is
the sorted set of directly seeded task ids. A candidate without supporting
events is skipped with an explicit error; it is never summarized alone.

### Summarization and admission

`KnowledgeSummarizer` is an injected, provider-neutral port. It receives the
frozen window, trigger, allowed knowledge types and one strict output JSON
Schema. It does not receive the operation token, an event id, actor, sequence,
time, `sourceEvents` or `relatedTasks`.

The model output is strict `{ type, title, summary, rationale?, alternatives? }`.
Memory Core rejects unknown fields, a decision without rationale and a type not
allowed by the anchor. It then creates the canonical draft by attaching the
window's runtime-owned `sourceEvents` and `relatedTasks` and reparsing through
the Event Core `knowledge.created` schema.

`KnowledgeAdmissionPort` receives one frozen command containing project,
anchor as `causedBy`, operation token and canonical draft. The composition root
allocates the knowledge subject, authenticates the actor and performs the
idempotent append. Model, parse, window or admission failure produces no partial
command. Explicit `write_memory` remains a separate runtime admission path.

The v1 evidence guarantee is item-level: every generated statement is
attributed to the same complete `sourceEvents` window. Semantic truth still
depends on the summarizer and review; structural provenance does not claim that
a model interpreted evidence correctly.

## Alternatives

**Use the preceding N events.** Rejected: sequence proximity is not relevance,
and arbitrary limits silently lose the reason an event occurred.

**Follow only `causedBy`.** Rejected: answer matching, approval attribution,
task history and artifact derivation have canonical relations outside the
single-parent causal edge.

**Let the model return source ids.** Rejected: it could invent, omit or select
future ids, and permanent provenance would no longer be runtime-owned.

**Persist per-sentence citation objects in v1.** Rejected: the v1 event payload
is frozen. A future version may add finer claim citations without weakening the
current item-level guarantee.

**Import Task Engine or Approval Gate into Memory Core.** Rejected: Memory Core
is a sibling domain package. It derives only the minimal relations present in
events and does not duplicate their lifecycle reducers.

## Consequences

- Window membership is deterministic under replay and independent of model or
  provider behavior.
- Corrupt references fail before model invocation or event admission.
- Large task windows are preserved rather than truncated by recency. Future
  relevance bounding needs a measured, reviewed policy rather than a hidden
  default.
- All model prose in one item shares one durable evidence set. Finer citation
  granularity requires a future event schema version.
