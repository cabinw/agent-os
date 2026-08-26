# Agent OS

The operating system for AI-native teams.

A human states a goal. A Supervisor Agent breaks it into tasks. Agents from any
provider execute those tasks over MCP. Every state change becomes an event, and
events are reduced into task state, live views, and durable project knowledge.

Agent OS is not an agent monitor. It is the place where an AI team collaborates,
executes, and accumulates memory that outlives any single session.

## Try the product

From the repository root, run:

```sh
pnpm experience
```

Then open [http://localhost:5173/](http://localhost:5173/). The local product
entry needs no token: it starts the Hub and interface together, discovers the
supported agent CLIs already installed on this Mac, and stores local event and
session state under the ignored `.agent-os/local/` directory. Create a task,
watch its event-derived progress, and explicitly accept or return results from
the Tasks view. Stop both processes with `Ctrl-C`.

For the native macOS development window, use `pnpm experience:native`.
Production Hub access still requires the separately delivered connection key;
the browser exchanges it for an HttpOnly session and does not retain the bearer
in URL or browser storage.

## Status

The local product entry, event-derived desktop surfaces, Hub / Runner runtime,
formal Event Core and remote Windows Worker are executable. The production Hub
is deployed at `agent.zeroplus.fun`; access is intentionally authenticated.
See the live [project board](board.html) for exact evidence, open problems and
current completion rather than relying on a stale milestone summary here.

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
