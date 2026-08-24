# Canvas

The spatial view of a project. Where Pulse answers "what happened", Canvas
answers "how does this fit together".

## Nodes

| Node | Represents | Shows |
| --- | --- | --- |
| Goal | A stated outcome | Statement, completion rollup |
| Task | A unit of work | Title, status color, progress, executor avatar |
| Agent | A worker | Identity, status dot, current task |
| Resource | A document, file, or external source | Type, name |
| Knowledge | A decision or finding | Type, title |

## Edges

Every drawn edge is `causedBy`. Its endpoints are semantic nodes, but its
evidence is the child event and prior cause event in the immutable log.
`dependsOn` affects deterministic task layout only; it is not rendered as
causality. The graph is generated rather than authored.

## Zoom levels

```
Level 0  Project Universe   all projects, health at a glance
Level 1  Mission View       goals and their task graphs
Level 2  Agent Workspace    one agent, its task, its context and outputs
```

Zoom changes the level of detail, not just the scale. Moving in reveals
structure that was aggregated, never just a bigger version of the same picture.
All three levels disclose or aggregate one sourced semantic projection. Visual
pan and scale are independent viewport controls.

## Live behavior

Nodes update from the event stream. A task turning `blocked` pulses its edge to
the agent once and settles into the risk color — noticeable peripherally,
without motion that pulls the eye away from work.

## Layout

Columns are deterministic by node kind. Tasks may be ordered left-to-right by
dependency without drawing dependency edges. Completed branches recede in
opacity so the active frontier stays prominent.
