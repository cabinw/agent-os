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
  "author": "claude-architect",
  "at": "2024-03-25",
  "supersedes": null
}
```

Types: `decision`, `research`, `technical-note`, `task-summary`, `milestone`,
`discussion`.

`sourceEvents` is what makes memory auditable — every claim can be traced back to
the events that produced it. Memory is never the only copy of anything.

## Superseding

Knowledge is not edited. A later decision sets `supersedes` on the earlier item,
which stays readable. "We used to do X, then changed to Y in month N, here is
why" is a first-class query, and the reason Revival Mode can explain a project's
drift.

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

## Retention

Events may be compacted after knowledge extraction; knowledge items are never
compacted. Storage grows with meaningful output, not with chatter.
