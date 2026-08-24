# ADR-035: Canvas Semantic Zoom Is One Sourced Graph

Status: accepted

## Context

The memory graph is event-level: nodes are immutable events and edges are
`causedBy`. Canvas needs project, goal, task, agent, resource and knowledge
entities without inventing a second graph or presenting task dependencies as
causal evidence.

## Decision

Canvas builds one semantic projection from independently validated project
histories. Every semantic node retains its source event ids. Every drawn edge
maps an event and its prior `causedBy` event to semantic endpoints:

```
stored histories
  → Memory Graph validation
  → Task + Agent projections
  → semantic nodes + causedBy edges
  → Universe / Mission / Workspace disclosure
```

Project Universe aggregates projects. Mission View discloses the selected
project graph. Agent Workspace selects an agent, its assigned tasks and their
causal neighborhood. These levels filter or aggregate the same projection;
they do not author new nodes or edges.

`dependsOn` is retained on task nodes for deterministic layout only. It never
becomes a Canvas edge. Goal labels use the stable goal id until a canonical
goal title event exists. Visual zoom and pan change the viewport independently
of semantic zoom.

## Alternatives

**Store Canvas documents.** Rejected: authored graph state can diverge from the
event log.

**Draw dependency edges as causality.** Rejected: scheduling constraints do not
prove which event caused another.

**Use scale alone for zoom.** Rejected: larger pixels do not reveal additional
semantic structure.

## Consequences

- Canvas is replayable and every edge has event evidence.
- Completed task nodes can recede without deleting history.
- Empty and partial histories remain honest rather than fabricating entities.
- New entity labels require a canonical event contract, not UI-only metadata.
