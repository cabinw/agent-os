# ADR-029: Sourced Project Library Read Model

Status: accepted

## Context

Project Library spans projects, while every stored event sequence is scoped to
one project. The UI specification also asks for AI copy, current phase and next
steps that do not all exist as canonical fields.

## Decision

Build one derived `ProjectLibrary` from independently complete, contiguous
project histories plus an explicit `now` timestamp.

For each project:

```
project.created + project.state.changed       → identity and state
Task projection                               → progress, work and blockers
Agent Catalog                                 → connected agents
project.snapshot.captured                     → cover and filmstrip
pulse.story.generated                         → sourced AI brief
project.revived                               → sourced next steps
knowledge.created / artifact.produced         → detail tabs
```

Every displayed derived value carries its source event ids. Histories are
validated independently; there is no portfolio-wide sequence or event order.
Projects sort by last activity descending, then name and project id.

Progress is the mean of current task progress, or zero with no tasks. Current
work is the highest-consequence non-terminal task, not an invented phase.
Health is `blocked` with an unresolved blocker, `attention` with failed or
review work, and `healthy` otherwise.

An AI brief exists only when a sourced `pulse.story.generated` event exists.
Recommended next steps exist only in the latest `project.revived` plan. Missing
values render honest empty states. Project Insights remains explicitly
unavailable in RM-3.5.

Project Detail is a drawer over Library with exactly five tabs:

```
Overview · Timeline · Memory · Files · Settings
```

Filters and the selected project/tab are local UI state. They are not events.

## Alternatives

**One global portfolio log.** Rejected: canonical sequence numbers are
project-scoped and cannot define a global order.

**Generate summaries and next steps while rendering.** Rejected: the output
would be non-replayable and have no immutable source evidence.

**Persist filters and drawer selection.** Rejected: these are per-person view
preferences, not project state.

## Consequences

- The composition layer must reject mixed projects, gaps, duplicate events,
  duplicate project sources and inconsistent lifecycle transitions.
- Five-column rows may say current work; they must not label it current phase.
- Future Project Insights needs a separate sourced contract before it can show
  portfolio claims.
