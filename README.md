# Agent OS

The operating system for AI-native teams.

A human states a goal. A Supervisor Agent breaks it into tasks. Agents from any
provider execute those tasks over MCP. Every state change becomes an event, and
events are reduced into task state, live views, and durable project knowledge.

Agent OS is not an agent monitor. It is the place where an AI team collaborates,
executes, and accumulates memory that outlives any single session.

## Status

Specification stage. No implementation yet — this repository contains the
architecture, protocol, product and design specs that Phase 1 will build from.

## Where to start

| If you want to | Read |
| --- | --- |
| Understand the idea | [docs/vision.md](docs/vision.md) |
| Understand the system | [docs/architecture/overview.md](docs/architecture/overview.md) |
| Integrate an agent | [docs/protocol/mcp-protocol.md](docs/protocol/mcp-protocol.md) |
| Build the UI | [docs/product/navigation.md](docs/product/navigation.md), [docs/design/design-language.md](docs/design/design-language.md) |
| Know what to build next | [docs/development/roadmap.md](docs/development/roadmap.md) |
| Browse everything | [docs/README.md](docs/README.md) |

A full walkthrough — architecture plus a user-facing guide with high-fidelity
interface designs — is in [doc.html](doc.html). Open it in a browser.

## Core principles

1. **MCP first** — every external agent connects through one protocol, never a bespoke integration.
2. **Event driven** — state is never mutated directly; it is derived from an immutable event log.
3. **Memory first** — the system must be able to answer *why* a decision was made, months later.
4. **Human in the loop** — irreversible actions stop and wait for a person.
