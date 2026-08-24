# Project Memory

Supersedes the former `memory-system.md` and `project-memory.md`.

## Goal

Answer *why*, not only *what*. A raw event log records that the project adopted
PostgreSQL. Memory records that it was chosen over MongoDB because the schema
needed relational joins plus JSON columns, that Claude proposed it on 2024-03-25,
and that the alternative is revisitable if the JSON usage grows.

## Pipeline

```
Raw Events
    │  filter: which events carry knowledge?
    ▼
Candidate set  (decisions, results, research, discussions, blockers resolved)
    │  AI summarization with causal context
    ▼
Knowledge Item  (typed, sourced, linked)
    │  link to tasks, agents, other items
    ▼
Project Memory  ──▶ Knowledge Graph view · Revival Mode · agent context
```

Summarization runs on a window of related events, never a single one, so the
result reads as a conclusion rather than a log line.

### Extraction trigger

Memory Core opens a candidate window only from a structural anchor:

| Anchor | Events |
| --- | --- |
| Decision | `approval.granted`, `approval.rejected` |
| Result | `task.review.requested`, `task.completed`, `task.failed`, `task.cancelled`, `measurement.recorded` |
| Resolved blocker | `task.unblocked` |
| Concluded discussion | `message.sent` type `answer`, `report` or `review` |
| Research artifact | `artifact.produced`, `artifact.derived` |

Everything else is context or noise, not an anchor. In particular, active
blockers and approval requests are unresolved; instruction, question, progress
and warning messages are not conclusions; scheduling events are transient; and
existing `knowledge.*`, `pulse.*` and `project.revived` output cannot trigger a
recursive extraction. Classification is structural and never searches text or
artifact names for keywords. See [ADR-020](../decisions/ADR-020-knowledge-candidate-classification.md).

An anchor is still not knowledge. Extraction requires at least one related
supporting event in the same project. Noise events may supply that causal or
task context even though they cannot open a window themselves.

### Causal window

The runtime supplies complete, contiguous project history from sequence 1.
Memory Core validates every backward `causedBy`, same-thread message `replyTo`,
approval request/decision subject, direct task attribution and artifact
derivation before building one deterministic window. The window contains the
anchor plus at least one supporting event; a lone or corrupt anchor is not sent
to a model. See [ADR-021](../decisions/ADR-021-causal-knowledge-windows.md).

The summarizer receives this frozen window and an authority-free strict output
schema. It cannot choose `sourceEvents`, `relatedTasks`, event authority or the
idempotency token. Memory Core attaches the exact ordered window ids and derived
task set, checks the returned type against the anchor's allowed types, reparses
the canonical draft, then hands one command to an injected admission port.

## Knowledge item

```json
{
  "id": "KN-021",
  "type": "decision",
  "title": "Adopt PostgreSQL",
  "summary": "Chosen over MongoDB for relational joins plus JSONB.",
  "rationale": "Schema requires strong relations; JSON support still needed.",
  "alternatives": ["MongoDB", "SQLite"],
  "sourceEvents": ["evt_...", "evt_..."],
  "relatedTasks": ["TASK-012"],
  "author": { "kind": "agent", "id": "claude-architect" },
  "at": "2024-03-25",
  "supersedes": "KN-020"
}
```

Types: `decision`, `research`, `technical-note`, `task-summary`, `milestone`,
`discussion`.

The strict Memory Core draft is exactly the canonical `knowledge.created`
payload. Id, author, time and sequence derive from the admitted event. Explicit
`write_memory` adds runtime-owned causal `sourceEvents`; agents do not supply
envelope authority or a second memory record.

`sourceEvents` is what makes memory auditable — every claim can be traced back to
the events that produced it. In v1 this is an item-level evidence set: every
generated statement is attributed to the same complete window. Memory is never
the only copy of anything.

## Superseding

Knowledge is not edited. `knowledge.superseded { old, new }` targets the old
item and derives reciprocal projection links: `old.supersededBy = new` and
`new.supersedes = old`. Both are decisions; the new item was created later and
was previously unattached. Each item has at most one predecessor and one
successor, so chains cannot fork, merge or cycle. See
[ADR-022](../decisions/ADR-022-linear-knowledge-supersession.md).

The old item and its sources stay readable. "We used to do X, then changed to Y
in month N, here is why" is a first-class query, and the reason Revival Mode can
explain a project's drift.

## Consumption

| Consumer | Uses memory for |
| --- | --- |
| Revival Mode | The welcome-back report for a dormant project |
| Agent context | Injecting prior decisions into a new task's shared context |
| Knowledge Graph | Nodes and edges of the graph view inside Memory |
| Project Pulse | Knowledge Updates section |

The agent-context case is the important one: an agent starting TASK-014 receives
the decisions that constrain it, so it does not re-litigate settled questions or
contradict an earlier choice.

## Consequences

`sourceEvents` traces a claim backwards. Nothing traced it forwards, so a
conclusion could never be scored against what happened after it was adopted.
`measurement.recorded` closes that: external results about shipped work enter the
log and are linked to the knowledge they bear on.

This is the difference between memory that **accumulates** and memory that
**grows**. A role that runs for a year is not valuable because it remembers more
items; it is valuable because its conclusions have been tested, and it knows
which ones were wrong.

## Corpora

Knowledge extraction assumes the raw material is events. It is not always: a
research pass can produce dozens of documents, and those are artifacts on disk,
not chatter in a thread. `artifact.produced` and `artifact.derived` record them.

The consumption pattern differs from knowledge items in a way that matters:

- A **knowledge item** is a conclusion, small, and injected into context.
- A **corpus** is evidence, large, and *read selectively by whoever needs it*.

Summarising a corpus once, for everyone, loses the wrong things — **what a
summary drops depends on who was going to read it**, and the author does not
know that in advance. So a corpus is not compressed once; it is digested per
role, and each digest is itself an artifact (`artifact.derived`) that the next
task of that role can reuse.

Selection therefore belongs to the reader, not the writer: give every document a
short abstract, inject the whole index cheaply, and let the agent choose what to
read in full.

## Retention

Knowledge extraction never permits deleting its evidence. Formal events remain
losslessly replayable per ADR-009; they may move to cold storage, while
discardable snapshots and non-event Runner telemetry may be compacted.
Knowledge items are also permanent and superseded rather than edited.
