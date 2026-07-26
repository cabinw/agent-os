# Agent OS Monorepo Structure

Recommended repository layout:

```
agent-os/

apps/
 └── macos/

packages/
 ├── mcp-server/
 ├── event-core/
 ├── agent-sdk/
 ├── task-engine/
 └── memory-core/

docs/
tests/
```

The architecture separates application UI, reusable runtime packages and protocol layers.
