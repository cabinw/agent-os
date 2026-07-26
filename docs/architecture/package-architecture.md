# Agent OS Package Architecture

## Goal

Define the core package boundaries for Agent OS implementation.

## Packages

```
packages/
├── event-core
├── mcp-server
├── agent-sdk
├── task-engine
└── memory-core
```

## Dependency Direction

```
mcp-server
    |
agent-sdk
    |
event-core ---- task-engine
    |
memory-core
```

Principle: lower layers should not depend on UI or external agent providers.
