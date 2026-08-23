# Project Pulse

The AI-native briefing for a project. The default landing page when work is in
flight.

## Premise

An AI team produces more activity in a day than a person can read. Pulse is the
editorial layer: it reduces the day's events into a page that can be understood
in ninety seconds, and it leads with the single most important thing.

## Sections

```
┌──────────────────────────────────────────────────────────┐
│  KPI row: active agents · active tasks · done today ·    │
│           blockers · date                                │
├──────────────────────────────────────────────────────────┤
│  TOP STORY — the headline, with hero image and detail    │
├──────────────┬──────────────────┬────────────────────────┤
│ Today's      │ Agent Activity   │ Risks & Blockers       │
│ Progress     │                  │                        │
├──────────────┼──────────────────┼────────────────────────┤
│ Knowledge    │ Research         │ AI Moments             │
│ Updates      │ Discovery        │                        │
└──────────────┴──────────────────┴────────────────────────┘
```

| Section | Content | Source |
| --- | --- | --- |
| Top Story | The day's most consequential event, written as news | `pulse.story.generated` |
| Today's Progress | Per-workstream completion bars | `task.progress.updated` |
| Agent Activity | Timestamped feed of what each agent did | `agent.*`, `task.*` |
| Risks & Blockers | Open blockers with impact and age | `task.blocked` |
| Knowledge Updates | New documents and decisions | `knowledge.created` |
| Research Discovery | External findings agents surfaced | `knowledge.created` type=research |
| AI Moments | Quantified wins — time saved, performance gained | derived |

## Headline selection

Ranked by consequence, not recency:

1. A blocker aging past its severity threshold
2. A milestone completion
3. A decision that changes architecture
4. Largest aggregate progress delta

Ties break toward the item a human can act on. Pulse is a call to attention, not
a changelog.

## AI Moments

The section that makes the value legible: "Codex automated 120+ asset imports,
saving ~3.5 hours of manual work." Every moment must trace to events, with the
saving computed from measured task durations rather than asserted.

## Constraint

Pulse never introduces state. It is a reducer output — if a number appears here
it must be derivable from the log, and clicking it must reach the underlying
events.

The one durable output is `pulse.story.generated`: headline prose is
non-deterministic and therefore recorded with non-empty `sourceEvents`. KPI
values and headline ranking remain projections.
