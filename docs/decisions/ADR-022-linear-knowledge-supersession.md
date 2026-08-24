# ADR-022: Decision Supersession Forms Immutable Linear Chains

Status: accepted

## Context

The canonical event is `knowledge.superseded { old, new }`, but the Memory
example placed a `supersedes` field on an item and said a later decision changed
the earlier item. No reducer defines whether the old or new item is the event
subject, whether non-decisions can supersede, or how forks, merges, cycles and
missing items behave. Permitting several successors would make “the current
decision” ambiguous and break context injection.

## Decision

### Projection

Memory Core registers one `memory` projection. `knowledge.created` derives an
immutable `KnowledgeItem` from its canonical knowledge subject, payload and
envelope:

```
id · project · type · title · summary · rationale? · alternatives?
sourceEvents · relatedTasks? · author · at · createdEvent · createdSeq
supersedes? · supersededBy?
```

The subject id must be a canonical `KN-nnn` id. `author` is the complete actor,
not a caller-supplied string. The payload content and source arrays are never
edited.

For `knowledge.superseded { old, new }`, the event subject is `old`, the item
whose active status changes. Both items must already exist and both must be
`decision`. The new item must have a greater creation sequence than the old item
and both creation sequences must precede the supersession event.

The old item must be the active head of its chain (`supersededBy` absent). The
new item must be unattached (`supersedes` and `supersededBy` both absent). The
reducer derives a new projection state with:

```
old.supersededBy = new
new.supersedes    = old
```

This permits `A → B → C`: when `B` is replaced, it may already point backward
to `A`, but it has no forward successor. It rejects forks, merges, reverse-time
links and cycles. The old item remains addressable with all original content.
`knowledge.linked` remains outside this milestone and is reduced by the graph
projection in RM-2.5.

The strict snapshot parser checks exact fields, canonical ids, event and task
ids, actor, timestamps, creation order and reciprocal chain links. It rejects
dangling, one-sided, non-decision, forked, merged, cyclic or temporally reversed
state. Deleting the snapshot and replaying from sequence 1 remains equivalent.

### Admission

`KnowledgeSuperseder` accepts trusted project, old/new ids, runtime-owned
`causedBy` and an operation token. It reads the current Memory projection,
applies the same pure validation and sends one frozen command to an injected
`KnowledgeSupersessionPort`.

The command includes the old and new creation event ids as optimistic fences.
The port must recheck those identities and the active/unattached link state in
its serialized command boundary before appending exactly one
`knowledge.superseded` event with subject `old`. Caller or model input never
sets actor, subject, payload extras, event id, sequence or time. Invalid state
or port failure produces no successful admission.

## Alternatives

**Edit the old knowledge row.** Rejected: Knowledge is a projection and Event
is the only writable object.

**Store only `new.supersedes`.** Rejected: finding the active head would require
scanning every item, and one old item could silently gain several successors.

**Allow forks and choose the newest by time.** Rejected: wall-clock time is not
project order, and context injection would have two contradictory current
decisions.

**Allow one new item to replace several old items.** Rejected for v1: this is a
merge with different query semantics. A future reviewed event can express it
without weakening the linear invariant.

**Infer replacements from matching title or task.** Rejected: neither text nor
task overlap proves that two decisions answer the same question. Supersession is
an explicit admitted fact.

## Consequences

- Every chain has exactly one active head and complete readable history.
- Current-context selection can exclude items with `supersededBy` without
  deleting their evidence.
- Concurrent replacement attempts require port-level fencing; reducer failure
  after a durable append is not an acceptable concurrency strategy.
- Merge and branch semantics require a future catalogued event rather than an
  overloaded v1 payload.
