# Agent OS Testing Strategy

## Testing Layers

### Unit Tests

Validate:

- Event handling
- Task transitions
- Agent registry

### Integration Tests

Validate:

- MCP communication
- Agent adapter behavior
- Event propagation

### End-to-End Demo

Scenario:

User Goal
→ Supervisor
→ Codex Agent
→ Task Completion
→ Project Pulse Update

## Principle

The system should be tested through observable events and outcomes.
