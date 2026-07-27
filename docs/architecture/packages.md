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

`A ──▶ B` reads **A imports B**. Arrows only ever point downward.

```
                    apps/macos
                         │
                         ▼
                    mcp-server
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
     agent-sdk     task-engine     memory-core
          └──────────────┼──────────────┘
                         ▼
                    event-core          ← kernel, zero dependencies
```

`event-core` is the **bottom** of the stack, not the middle. It exports
`registerReducer`; the domain packages register into it. A kernel that imported
its own consumers could not be tested in a bare runtime, and could not be the
thing every projection is derived from.

Three consequences worth stating explicitly:

- `event-core` depends on nothing in this repo. No vendor SDK, no UI import, no
  sibling package. It should be testable with the other four absent.
- `task-engine` and `memory-core` are siblings and must not import each other.
  They communicate only by emitting and reducing events.
- `agent-sdk` sits beside them, not above them. It needs the log to emit onto;
  it does not need task state.

Mechanically checked by `pnpm check:layers`.

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
