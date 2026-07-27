# Agent OS Architecture Overview

## The runtime loop

This cycle is the whole system. Every component exists to serve one arrow.

```
   Human states a Goal
            │
            ▼
   ┌─────────────────┐
   │ Supervisor Agent│  plans, decomposes, assigns
   └────────┬────────┘
            │ create_task / assign_task
            ▼
   ┌─────────────────┐
   │   Task Engine   │  owns lifecycle, dependencies
   └────────┬────────┘
            │ task.assigned
            ▼
   ┌─────────────────┐
   │   MCP Server    │  the only ingress for agents
   └────────┬────────┘
            │ tool calls, both directions
            ▼
   ┌─────────────────┐
   │ Agent Execution │  Claude / Codex / Gemini / any adapter
   └────────┬────────┘
            │ every action emits an event
            ▼
   ┌─────────────────┐
   │   Event Core    │  bus → store → reducers
   └────────┬────────┘
            │
   ┌────────┴──────────────────────────────┐
   ▼                ▼                      ▼
Task State      Project Memory        Human Surfaces
                                  (Pulse / Canvas / Library)
```

The loop closes: what the human sees in Project Pulse is a reduction of the same
events the Task Engine used to advance state. There is no second source of truth.

## Layers

```
┌──────────────────────────────────────────────────────┐
│  apps/macos                Pulse, Canvas, Library    │  presentation
├──────────────────────────────────────────────────────┤
│  mcp-server                protocol ingress          │  boundary
├──────────────────────────────────────────────────────┤
│  agent-sdk  ·  task-engine  ·  memory-core           │  integration + domain
├──────────────────────────────────────────────────────┤
│  event-core                bus, store, reducers      │  kernel
└──────────────────────────────────────────────────────┘
```

Rule: a layer may depend downward only, so `event-core` sits at the **bottom**
and depends on nothing. It must compile with no knowledge that a UI, an AI
vendor, or even the other four packages exist. The domain packages register
reducers into it, never the reverse. See
[ADR-005](../decisions/ADR-005-derived-state-only.md) and
[packages.md](packages.md).

## Components

| Component | Responsibility | Never does |
| --- | --- | --- |
| **Supervisor Agent** | Decompose goals, assign work, detect drift | Execute the work itself |
| **Agent Runtime** | Track agent lifecycle, match capability to task | Know vendor-specific APIs outside an adapter |
| **MCP Server** | Validate and admit agent calls, emit events | Hold state |
| **Event Core** | Append, order, persist, replay, reduce | Interpret domain meaning |
| **Task Engine** | Enforce legal state transitions | Talk to agents directly |
| **Memory Core** | Turn event history into durable knowledge | Store raw transcripts as knowledge |
| **Approval Gate** | Suspend risky actions pending a human | Auto-approve on timeout |

## Why events are the kernel

Three product requirements collapse into one mechanism:

- *Project Pulse* needs a narrative of what happened today → replay the day's events.
- *Revival Mode* needs to explain a project abandoned a year ago → replay everything.
- *Canvas* needs live agent state → subscribe to the same stream.

Building these on a mutable database would require three separate change-tracking
systems. Building them on an event log requires none.

## Trust boundary

Everything an external agent sends crosses one boundary — the MCP Server — and is
validated there. An agent cannot write an event directly, cannot set task status,
and cannot mark its own high-risk action approved. It can only *request*; the
runtime decides and emits.

```
external agent ──▶ MCP Server ──▶ [validate, authorize] ──▶ Event Core
                                            │
                                            └─▶ Approval Gate ──▶ human
```
