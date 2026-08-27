# Agent OS

The persistent project environment for Code Agents.

A human opens a repository, prompts a real Code Agent and retains the execution
evidence, decisions and project memory after that vendor session ends. Tasks,
approvals and multi-agent delegation build on the same event log when the work
needs them.

Agent OS is not a terminal multiplexer and does not build on Herdr. Its existing
Hub, Local / Remote Runner and vendor adapters are the execution substrate.
ADR-047 moves the product entry to a Codex / Claude-style project session;
multi-agent coordination remains a background execution strategy. The Hub /
Runner stay in `apps/chat-spike`; `apps/macos` is the single product client, and
the Spike 4173 page remains diagnostic.

## Run the current baseline

From the repository root, run:

```sh
pnpm experience
```

Then open [http://localhost:5173/](http://localhost:5173/). The local composition
starts the Hub and interface together, discovers supported Agent CLIs and stores
local event / session state under ignored `.agent-os/local/`.

This runnable baseline still lands on Project Pulse and starts work through
`New task`. That is the legacy entry being refactored, not the target experience.
Read [HANDOFF.md](HANDOFF.md) before changing it. Stop both processes with
`Ctrl-C`.

For the native macOS development window, use `pnpm experience:native`.
Production Hub access still requires the separately delivered connection key;
the browser exchanges it for an HttpOnly session and does not retain the bearer
in URL or browser storage.

## Status

The event-derived desktop surfaces, Hub / Runner runtime, formal Event Core,
memory packages and remote Windows Worker are executable. The production Hub is
deployed at `agent.zeroplus.fun`; access is intentionally authenticated.

First-use testing reopened the product entry despite completion of the former
roadmap. See the [project board](board.html) and [handoff](HANDOFF.md) for the
current ENTRY track rather than treating historical 100% as present product
completion.

## Where to start

| If you want to | Read |
| --- | --- |
| Understand the idea | [docs/vision.md](docs/vision.md) |
| Understand the current product decision | [ADR-047](docs/decisions/ADR-047-code-session-first-product-entry.md) |
| Understand the system | [docs/architecture/overview.md](docs/architecture/overview.md) |
| Understand Hub / Runner deployment | [ADR-008](docs/decisions/ADR-008-server-hub-local-first-runners.md) |
| Understand permanent event compatibility | [ADR-009](docs/decisions/ADR-009-versioned-strict-event-contract.md) |
| Operate a staging Hub / Worker | [deploy/README.md](deploy/README.md) |
| Integrate an agent | [docs/protocol/mcp-protocol.md](docs/protocol/mcp-protocol.md) |
| Build the product entry | [HANDOFF](HANDOFF.md), [navigation](docs/product/navigation.md), [design language](docs/design/design-language.md) |
| Know what to build next | [docs/development/roadmap.md](docs/development/roadmap.md) |
| Browse everything | [docs/README.md](docs/README.md) |

The generated [doc.html](doc.html) and high-fidelity `ui/` renders predate
ADR-047. Use them as historical visual reference, not as the current landing
contract, until regenerated.

Run the full repository gate from the repository root with
`corepack pnpm verify`. Hub / Runner usage is documented in
[apps/chat-spike](apps/chat-spike/README.md).

## Core principles

1. **MCP first** — every external agent connects through one protocol, never a bespoke integration.
2. **Event driven** — state is never mutated directly; it is derived from an immutable event log.
3. **Memory first** — the system must be able to answer *why* a decision was made, months later.
4. **Human in the loop** — irreversible actions stop and wait for a person.
