# Agent OS

The operating system for AI-native teams.

A human states a goal. A Supervisor Agent breaks it into tasks. Agents from any
provider execute those tasks over MCP. Every state change becomes an event, and
events are reduced into task state, live views, and durable project knowledge.

Agent OS is not an agent monitor. It is the place where an AI team collaborates,
executes, and accumulates memory that outlives any single session.

## Status

Architecture plus an executable chat / Hub spike. The spike contains the event
log, MCP trust boundary, Hub runtime and four vendor adapters; formal
`packages/*` still contain contracts and foundational types. Hub hardening is
complete. The shared Runner contract now covers durable request-id idempotency,
events, sessions, cancellation, health, retry classification and close; Runner
injection is mandatory and the Hub has no vendor execution fallback. The active
Remote path now runs through the production Server Hub / outbound Worker
composition with durable placement, fenced leases, restart replay and isolated
credentials. The active step is formal Event Core.

## Where to start

| If you want to | Read |
| --- | --- |
| Understand the idea | [docs/vision.md](docs/vision.md) |
| Understand the system | [docs/architecture/overview.md](docs/architecture/overview.md) |
| Understand Hub / Runner deployment | [ADR-008](docs/decisions/ADR-008-server-hub-local-first-runners.md) |
| Integrate an agent | [docs/protocol/mcp-protocol.md](docs/protocol/mcp-protocol.md) |
| Build the UI | [docs/product/navigation.md](docs/product/navigation.md), [docs/design/design-language.md](docs/design/design-language.md) |
| Know what to build next | [docs/development/roadmap.md](docs/development/roadmap.md) |
| Browse everything | [docs/README.md](docs/README.md) |

A full walkthrough — architecture plus a user-facing guide with high-fidelity
interface designs — is in [doc.html](doc.html). Open it in a browser.

Run the current implementation and its full gate from
[apps/chat-spike](apps/chat-spike/README.md).

## Core principles

1. **MCP first** — every external agent connects through one protocol, never a bespoke integration.
2. **Event driven** — state is never mutated directly; it is derived from an immutable event log.
3. **Memory first** — the system must be able to answer *why* a decision was made, months later.
4. **Human in the loop** — irreversible actions stop and wait for a person.
