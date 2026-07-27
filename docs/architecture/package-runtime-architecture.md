# Agent OS Package Runtime Architecture

## Core Packages

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
    v
agent-sdk
    |
    v
event-core
    |
    +---- task-engine
    |
    +---- memory-core
```

## Principle

Core services should be independent from UI and external agent providers.
