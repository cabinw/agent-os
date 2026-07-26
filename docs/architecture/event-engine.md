# Agent OS Event Engine

## Event Driven Architecture

All agent actions are represented as events.

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
- news.generated

The event system is the kernel of Agent OS state management.
