# ADR-027: Project Pulse Is a Sourced Cross-Projection Read Model

Status: accepted

## Context

Project Pulse combines task, agent, knowledge, artifact and measurement facts.
No single domain projection owns that view. Computing counts in React would
create a second implementation of event semantics, while storing KPI rows would
violate ADR-005.

The reference render contains illustrative images and business values that are
not event fields. The canonical story payload contains prose and source event
ids, but no image. “Today” is also ambiguous without a timezone boundary.

## Decision

The formal composition layer builds one immutable `ProjectPulse` from a complete
contiguous project event history and an explicit half-open RFC3339 window:

```
[startInclusive, endExclusive)
```

It rejects mixed projects, sequence gaps, duplicate event ids, reversed windows
and story sources absent from or later than the story event. The window is a
caller decision; the reducer never reads the machine clock or timezone.

Every KPI, card row and story exposes non-empty `sourceEvents` when its value is
non-zero or its content is present. Zero and empty sections use an empty source
list. UI selection passes these ids to the event-detail surface; it never
reconstructs evidence from titles or timestamps.

Current connected Agent placements count as active agents. Active tasks are
assigned, running, blocked or in review. “Done today” counts accepted
`task.completed` events in the window. Blockers count tasks whose current state
is blocked, even when the blocking event predates the window.

Headline consequences rank in this exact order:

1. current blockers older than their severity threshold;
2. milestone knowledge created in the window;
3. decision knowledge created in the window and related to at least one task
   requiring the canonical `architecture` capability;
4. positive task progress deltas in the window.

Thresholds are critical 0 hours, high 24, medium 72 and low 168. Within a class,
human-needed blockers rank first, then higher severity, larger age or progress,
then lower source sequence for deterministic ties. The displayed Top Story must
be a stored `pulse.story.generated` whose `sourceEvents` include the winning
consequence. Without that sourced story, the UI shows the ranked attention item
and an honest “story pending” state; it does not generate prose locally.

The six cards are derived as follows: task progress events, agent/task activity,
current blockers, non-research knowledge, research knowledge, and measurements.
AI Moments display recorded metric/value/unit/source facts only. They never
convert a measurement into invented time or money savings.

The macOS app consumes this view model. It may render an empty no-project or
projection-pending state, but it may not embed dashboard fixture counts. The
reference hero image is visual guidance only until an event contract supplies a
sourced asset.

## Alternatives

**Compute Pulse in React.** Rejected: event ordering, task status and evidence
validation belong to the formal composition boundary.

**Persist KPI snapshots.** Rejected: deterministic values are replayable and
must remain derived.

**Use the latest event as the headline.** Rejected: recency is not consequence.

**Invent a local story or hero image.** Rejected: non-deterministic prose is
durable only as `pulse.story.generated`; no current event owns a hero asset.

## Consequences

- Pulse is reproducible for the same history and day window.
- Every visible fact has an event-detail path.
- Bad or partial history fails closed instead of showing plausible wrong KPIs.
- Timezone choice stays explicit at the caller boundary.
- A future sourced hero image requires an event-catalog change before UI use.
