# Agent OS

The operating system for AI-native teams.

A human states a goal. A Supervisor Agent breaks it into tasks. Agents from any
provider execute those tasks over MCP. Every state change becomes an event, and
events are reduced into task state, live views, and durable project knowledge.

Agent OS is not an agent monitor. It is the place where an AI team collaborates,
executes, and accumulates memory that outlives any single session.

## Status

Architecture plus an executable chat / Hub spike. The spike contains the event
log, MCP trust boundary, Hub runtime and four vendor adapters; formal Phase 1
implementation has begun in `packages/event-core`. Hub hardening is
active: the runtime trust boundary is complete while the Ubuntu deployment and
upgrade transaction are being hardened. The shared Runner contract covers durable request-id idempotency,
events, sessions, cancellation, health, retry classification and close; Runner
injection is mandatory and the Hub has no vendor execution fallback. The active
Remote code path now runs through the Server Hub / outbound Worker production
composition root with durable placement, fenced leases, restart replay and
isolated credentials. It remains staging-only rather than production-ready
until the deployment and durable-store gates are complete. The versioned strict
Event Core contract (`RM-1.1a`) is complete;
the active operational step is `SVR-02`, followed by the formal SQLite event
store (`RM-1.1b`).

## Where to start

| If you want to | Read |
| --- | --- |
| Understand the idea | [docs/vision.md](docs/vision.md) |
| Understand the system | [docs/architecture/overview.md](docs/architecture/overview.md) |
| Understand Hub / Runner deployment | [ADR-008](docs/decisions/ADR-008-server-hub-local-first-runners.md) |
| Understand permanent event compatibility | [ADR-009](docs/decisions/ADR-009-versioned-strict-event-contract.md) |
| Operate a staging Hub / Worker | [deploy/README.md](deploy/README.md) |
| Integrate an agent | [docs/protocol/mcp-protocol.md](docs/protocol/mcp-protocol.md) |
| Build the UI | [docs/product/navigation.md](docs/product/navigation.md), [docs/design/design-language.md](docs/design/design-language.md) |
| Know what to build next | [docs/development/roadmap.md](docs/development/roadmap.md) |
| Browse everything | [docs/README.md](docs/README.md) |

A full walkthrough — architecture plus a user-facing guide with high-fidelity
interface designs — is in [doc.html](doc.html). Open it in a browser.

Run the full repository gate from the repository root with
`corepack pnpm verify`. Hub / Runner usage is documented in
[apps/chat-spike](apps/chat-spike/README.md).

## Core principles

1. **MCP first** — every external agent connects through one protocol, never a bespoke integration.
2. **Event driven** — state is never mutated directly; it is derived from an immutable event log.
3. **Memory first** — the system must be able to answer *why* a decision was made, months later.
4. **Human in the loop** — irreversible actions stop and wait for a person.
