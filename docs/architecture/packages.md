# Packages and Monorepo Layout

Supersedes the former `monorepo.md`, `package-architecture.md` and
`package-runtime-architecture.md`.

## Layout

```
agent-os/
├── apps/
│   ├── hub/            server composition root; dispatch only
│   ├── runner/         Local / Remote Runner composition root
│   ├── core-demo/      deterministic Phase 1 acceptance composition
│   └── macos/          native client: Pulse, Canvas, Library, menu bar
├── packages/
│   ├── event-core/     kernel
│   ├── event-store-sqlite/ Hub-only durable adapter
│   ├── task-engine/    task lifecycle
│   ├── supervisor/     goal planning and atomic plan admission
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
                    ┌────────┴────────┐                     │
                    ▼                 ▼                     ▼
               mcp-server    event-store-sqlite         agent-sdk
                    │                 │                     │
             ┌──────┼──────────────┐  │                     │
             ▼      ▼              ▼  │                     │
        agent-sdk  task-engine  memory-core                │
             └──────┴──────────────┴──┴─────────────────────┘
                                  ▼
                             event-core   ← kernel, zero workspace dependencies
```

Only `apps/hub` composes the event store. `apps/runner` uses shared event types
through `agent-sdk` and sends requests to the Hub; it never opens the store.
`apps/macos` is an authenticated Hub client, not part of this server import
graph.

`event-store-sqlite` is the only package allowed to depend on
`better-sqlite3`. It depends downward on `event-core`; the kernel does not
import the adapter. A filtered Runner or UI deployment must contain neither the
adapter package nor the native driver. This closure is a release gate, not an
assumption based on unused imports.

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
- `supervisor` depends on Task Engine graph validation and Event Core types. Its
  PlannerModel and atomic command admission are injected ports; it imports no
  vendor adapter or event store.

Mechanically checked by `pnpm check:layers`.

## Package contracts

| Package | Exports | Owns |
| --- | --- | --- |
| `event-core` | v1 event schemas and types; `createEventBus`, `append`, `subscribe`, `replay`, `registerReducer` | Permanent record contract and deterministic projection semantics |
| `event-store-sqlite` | `openSqliteEventStore`, transactional `append`, ordered `read`, online `backup`; separate `openSqliteSnapshotStore` cache | Hub-only durable log plus discardable projection cache |
| `task-engine` | lifecycle and Agent Catalog reducers; dependency selectors; `rankAgentPlacements`, `selectAgentPlacement` | ADR-002 lifecycle, immutable dependency graph, derived readiness and provider-neutral routing |
| `memory-core` | knowledge reducer, `parseKnowledgeDraft`, `classifyKnowledgeEvent`, `buildKnowledgeWindow`, `createKnowledgeExtractor`, `createKnowledgeSuperseder`; then `query`, `graph` | Knowledge candidates, causal windows, immutable items and linear supersession |
| `agent-sdk` | AgentClient named MCP calls; strict Runner `dispatch/cancel/health/session/close`; normalized adapter `send` and subprocess seam | Shared one-way client, Runner and adapter contracts; vendor values stop at the adapter |
| `supervisor` | strict plan parser; local-key Task id mapping; `createSupervisorPlanner` | Vendor-neutral decomposition and atomic decision + task-plan admission |
| `mcp-server` | canonical tool schemas, JSON Schema listing, `createMcpToolRouter`, `RuntimePort` | Transport-neutral MCP validation and authenticated call admission; no state or direct event append |

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
