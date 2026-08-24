# ADR-020: Knowledge Extraction Starts from Structural Triggers

Status: accepted

## Context

Project Memory names six knowledge types and says extraction considers
decisions, results, research, discussions and resolved blockers. It does not
define which of the 29 permanent events may open an extraction window. A text
keyword filter would be nondeterministic, language-dependent and easy to trigger
with progress chatter. Treating every event as a candidate would recursively
summarize existing knowledge and generated Pulse prose.

The permanent `knowledge.created` payload is already strict and versioned in
Event Core. Memory Core must not create a second, drifting knowledge schema.

## Decision

Memory Core exposes two Phase 2.1 boundaries:

- `parseKnowledgeDraft(value)` delegates to the canonical
  `knowledge.created` payload schema. Its output is exactly the six controlled
  types, sourced title and summary fields, decision rationale, optional unique
  alternatives and optional unique related tasks. It contains no id, author,
  time, sequence or superseding field; those derive from admitted events.
- `classifyKnowledgeEvent(value)` strictly parses one stored event and returns a
  frozen candidate or noise classification. Classification uses event structure
  only. It never reads free-form content, paths, artifact kinds, actor names or
  provider values for keywords.

Candidate anchors are exhaustive:

| Trigger | Event structure | Possible conclusion types |
| --- | --- | --- |
| `decision-recorded` | `approval.granted`, `approval.rejected` | `decision`, `discussion` |
| `result-recorded` | `task.review.requested`, `task.completed`, `task.failed`, `task.cancelled`, `measurement.recorded` | `task-summary`, `milestone`, `technical-note` |
| `blocker-resolved` | `task.unblocked` | `technical-note`, `task-summary` |
| `discussion-concluded` | `message.sent` with type `answer`, `report` or `review` | `discussion`, `research`, `technical-note`, `decision` |
| `research-produced` | `artifact.produced`, `artifact.derived` | `research`, `technical-note` |

All other structures are noise. In particular, instructions, questions,
progress and warnings are context rather than conclusions; active blockers and
approval requests are unresolved; agent/task scheduling events are transient;
snapshots and project administration are not knowledge; and `knowledge.*`,
`pulse.*` and `project.revived` are derived output that must not feed extraction
recursively.

A candidate anchor is not a knowledge item. RM-2.2 must construct a related,
same-project causal/task window containing at least two distinct stored events
before asking the injected summarizer for a draft. The anchor's possible types
are guidance, not authority: the summarizer still has to produce a strict draft,
and admission rejects a type outside the anchor's allowed set. Supporting events
classified as noise may belong to that window; they cannot open one.

Explicit `write_memory` is a separate admission path. The runtime adds a
non-empty causal `sourceEvents` set, parses the resulting draft through the same
schema and emits `knowledge.created`. Callers never supply envelope authority.

## Alternatives

**Scan content for words such as “decided” or “research”.** Rejected: wording
and language are not a protocol, and quoted or negated text produces false
positives.

**Make every event a candidate and let the model filter it.** Rejected: this
spends inference on routine progress and permits recursive summaries of derived
prose.

**Add a `knowledgeCandidate` flag to v1 events.** Rejected: v1 payloads are
frozen, and candidacy is derived policy rather than a permanent fact.

**Copy the knowledge payload schema into Memory Core.** Rejected: two strict
schemas can drift while both continue to compile.

## Consequences

- All 29 v1 event types have deterministic candidate/noise behavior.
- Progress chatter and generated memory cannot cause extraction loops.
- Noise events remain available as causal context; filtering does not delete or
  compact evidence.
- RM-2.2 owns window construction and summarization. RM-2.3 owns
  `knowledge.superseded`; neither concern is smuggled into this milestone.
