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

`assign` · `report` · `block` · `review` · `depend` · `derive`

Edges are drawn from `causedBy` in the event log, so the graph is generated
rather than authored. Nobody arranges the canvas by hand and nobody has to keep
it current.

## Zoom levels

```
Level 0  Project Universe   all projects, health at a glance
Level 1  Mission View       goals and their task graphs
Level 2  Agent Workspace    one agent, its task, its context and outputs
```

Zoom changes the level of detail, not just the scale. Moving in reveals
structure that was aggregated, never just a bigger version of the same picture.

## Live behavior

Nodes update from the event stream. A task turning `blocked` pulses its edge to
the agent once and settles into the risk color — noticeable peripherally,
without motion that pulls the eye away from work.

## Layout

Force-directed within a goal, ordered left-to-right by dependency. Completed
branches recede in opacity so the active frontier stays prominent.
