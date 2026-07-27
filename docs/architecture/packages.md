# Packages and Monorepo Layout

Supersedes the former `monorepo.md`, `package-architecture.md` and
`package-runtime-architecture.md`.

## Layout

```
agent-os/
├── apps/
│   └── macos/          native client: Pulse, Canvas, Library, menu bar
├── packages/
│   ├── event-core/     kernel
│   ├── task-engine/    task lifecycle
│   ├── memory-core/    knowledge pipeline
│   ├── agent-sdk/      adapters and agent-facing API
│   └── mcp-server/     protocol ingress
├── docs/
├── ui/
└── tests/
```

## Dependency direction

```
        apps/macos
             │
        mcp-server
             │
        agent-sdk
             │
        event-core
         ┌───┴────┐
   task-engine  memory-core
```

Strictly downward. Two consequences worth stating explicitly:

- `event-core` has no dependency on any AI vendor SDK and no UI import. It should
  be testable in a bare runtime.
- `task-engine` and `memory-core` are siblings and must not import each other.
  They communicate only by emitting and reducing events.

## Package contracts

| Package | Exports | Owns |
| --- | --- | --- |
| `event-core` | `append`, `subscribe`, `replay`, `registerReducer` | The log, ordering, snapshots |
| `task-engine` | `createTask`, `assignTask`, `transition`, `taskState` | Legal transitions, dependencies |
| `memory-core` | `extract`, `query`, `graph` | Knowledge items and links |
| `agent-sdk` | `register`, `receiveTask`, `reportProgress`, `reportResult`, `sendEvent` | Adapter surface |
| `mcp-server` | MCP tool handlers | Validation, authorization, rate limits |

## Rules

- Define the contract before the implementation; the contract lives in this doc.
- No package reaches into another's storage. Cross-package reads go through the
  exported API or through events.
- A package that needs data it cannot derive from events is a design smell —
  raise it rather than adding a table.
