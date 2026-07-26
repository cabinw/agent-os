# Agent OS Event Core Design

## Purpose

Event Core is the kernel of Agent OS.

All agent activities are represented as events.

## Flow

```
Agent
 ↓
Event Bus
 ↓
Event Store
 ↓
State Reducer
 ↓
Canvas / Project Pulse / Memory
```

## Event Examples

- agent.registered
- agent.started
- task.created
- task.progress.updated
- message.sent
- agent.blocked
- task.completed
- knowledge.created

## Principles

- Event first architecture
- Replayable history
- Derived state instead of duplicated state
