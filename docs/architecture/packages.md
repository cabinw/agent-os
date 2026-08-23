# Packages and Monorepo Layout

Supersedes the former `monorepo.md`, `package-architecture.md` and
`package-runtime-architecture.md`.

## Layout

```
agent-os/
├── apps/
│   ├── hub/            server composition root; dispatch only
│   ├── runner/         Local / Remote Runner composition root
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
                  apps/hub                       apps/runner
                     │                                │
                     ▼                                ▼
                mcp-server ────────────────▶      agent-sdk
                     │                                │
              ┌──────┼──────────────┐                 │
              ▼      ▼              ▼                 │
         agent-sdk  task-engine  memory-core          │
              └──────┴──────────────┴─────────────────┘
                              ▼
                         event-core      ← kernel, zero workspace dependencies
```

Only `apps/hub` composes the event store. `apps/runner` uses shared event types
through `agent-sdk` and sends requests to the Hub; it never opens the store.
`apps/macos` is an authenticated Hub client, not part of this server import
graph.

`event-core` is the **bottom** of the stack, not the middle. It currently exports
the versioned event schemas; RM-1.1c adds `registerReducer`, through which domain
packages register into it.
Knowing permanent record shapes does not give the kernel task transitions or
authorization rules. A kernel that imported its own consumers could not be
tested in a bare runtime, and could not be the thing every projection is derived
from.

Three consequences worth stating explicitly:

- `event-core` has zero workspace dependencies. No vendor SDK, UI import or
  sibling package. Pure runtime libraries for schema validation and storage do
  not reverse the internal dependency graph.
- `task-engine` and `memory-core` are siblings and must not import each other.
  They communicate only by emitting and reducing events.
- `agent-sdk` sits beside the domain packages. It defines the shared Runner and
  adapter contract. A Runner reports through that contract; only the Hub admits
  a request and appends an event.

Mechanically checked by `pnpm check:layers`.

## Package contracts

| Package | Exports | Owns |
| --- | --- | --- |
| `event-core` | v1 event schemas and types; then `append`, `subscribe`, `replay`, `registerReducer` in RM-1.1b/c | Permanent record contract, log, ordering, snapshots |
| `task-engine` | `createTask`, `assignTask`, `transition`, `taskState` | Legal transitions, dependencies |
| `memory-core` | `extract`, `query`, `graph` | Knowledge items and links |
| `agent-sdk` | strict `dispatch`, normalized result / event / error shapes, `cancel`, adapter `send` | Shared Local / Remote Runner and adapter contract |
| `mcp-server` | MCP tool handlers | Validation, authorization, rate limits |

## Rules

- Define the contract before the implementation; the contract lives in this doc.
- No package reaches into another's storage. Cross-package reads go through the
  exported API or through events.
- A package that needs data it cannot derive from events is a design smell —
  raise it rather than adding a table.
- `apps/hub` may compose execution but may not import a vendor adapter or open a
  project working copy.
- `apps/runner` may own vendor and filesystem details but may not write the Hub
  event store.
- Local and Remote Runner transports must pass the same contract suite.
