# Project Library

Manages every project across its full lifecycle, including the parts of the
lifecycle where nothing is happening.

## Problem

Personal and small-team projects do not end. They go quiet. Six months later the
code is still there but the context is gone: what worked, what was half-built,
why the architecture is the way it is, what to do first. The cost of restarting
exceeds the cost of the remaining work, so the project stays dead.

Agent OS holds the context that makes restarting cheap.

## A project is not code

```
Project
├── source code
├── documents
├── decisions        ← why it looks like this
├── research
├── agent activity
├── timeline
└── memory
```

## States

| State | Meaning |
| --- | --- |
| `active` | Agents are working |
| `paused` | Deliberately stopped, intended to resume |
| `archived` | Finished with, kept for reference |
| `completed` | Shipped |

## Library view

Filter tabs by state, a stat row across the top, then one row per project:

- cover image
- name and state badge
- AI-generated one-line summary
- progress bar with current phase
- technology stack chips
- active agent avatars
- last activity, in human terms ("312 天前")
- recommended next step

Below the list, a **Project Insights** strip: activity trend, stack
distribution across the portfolio, and AI suggestions at portfolio level — for
example flagging that two projects have been paused past three months and
should be evaluated for archival.

## Detail panel

Opens beside the grid without leaving the Library. Tabs: Overview, Timeline,
Memory, Files, Settings. Overview carries the snapshot, the AI brief, the
technology stack, the recommended next steps and the project timeline.

For a dormant project the Overview leads with the Revival Mode card — see
[revival-mode.md](revival-mode.md).

## Snapshots

A project accumulates dated visual checkpoints (`project.snapshot.captured`),
rendered as a filmstrip in the detail view. Seeing what the product looked like
at each stage restores context faster than any summary — it is the difference
between reading that the blog system shipped and recognizing it.
