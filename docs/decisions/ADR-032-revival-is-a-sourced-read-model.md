# ADR-032: Revival Is a Sourced Read Model

Status: accepted

## Context

Revival Mode must explain a dormant project without collecting fresh data.
The existing Library exposed only dormancy and the latest durable restart plan.
A newly emitted `project.revived` event also appeared to erase dormancy when it
became the last event.

## Decision

Derive one six-part report from a validated project history:

```
task.completed                         → built
task projection + project state       → current
knowledge.created(type=decision)       → decisions
non-terminal task projection           → unfinished
open blockers + failed tasks           → issues
latest project.revived.plan            → ordered plan
```

Every item carries source event ids. `project.revived` is derived output and is
excluded from the dormancy clock; it remains visible as last activity. Missing
history renders empty sections rather than generated claims.

The ▶ control emits a narrow, immutable `createAndAssignStep` intent containing
the persisted plan position and first connected executor. It cannot create an
arbitrary task or optimistically alter the report. The composition client owns
the actual task creation and assignment transaction.

## Alternatives

**Generate the report on view open.** Rejected: claims would not be replayable
or attributable.

**Treat `project.revived` as activity.** Rejected: generating the welcome-back
report would immediately hide it.

**Expose generic task commands to the view.** Rejected: the UI needs one narrow
restart-step operation, not the Supervisor command surface.

## Consequences

- Revival remains a query over existing events and knowledge.
- Task and knowledge projection changes must keep the six-part report in sync.
- A project with no connected executor cannot activate a restart step.
- Step creation failures leave the sourced view unchanged and visible.
