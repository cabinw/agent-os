# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repo is **specification-only**. There is no source code, no `package.json`, no build system, no tests, and no CI — the content is Markdown specs under `docs/`, high-fidelity design renders under `ui/`, a generated walkthrough at `doc.html`, an implementation plan at `todo.html`, plus [AGENTS.md](AGENTS.md) and [README.md](README.md). There are therefore no build/lint/test commands to run yet; do not invent them.

The stack is chosen but not yet built: TypeScript + Tauri 2 + SQLite, single-machine ([ADR-007](docs/decisions/ADR-007-implementation-stack.md)). Phase 0 creates the tooling. When it does, replace this section with the real commands.

## What Agent OS is

An AI-native operating system for running teams of autonomous AI agents. A human states a goal; a Supervisor Agent decomposes it into tasks; agents from any provider execute them over MCP; every state change is emitted as an event; events are reduced into task state, UI views, and durable project knowledge.

The four principles in [AGENTS.md](AGENTS.md) — MCP first, event driven, memory first, human in the loop — are load-bearing constraints. Reject designs that mutate state outside the event stream, integrate a provider outside MCP, or perform an irreversible action without an approval step.

## Canonical sources

The specs were rewritten to remove conflicts. When anything disagrees, these win:

| Topic | Authority |
| --- | --- |
| Task states | [ADR-002](docs/decisions/ADR-002-task-lifecycle.md) |
| Event names and payloads | [event-catalog.md](docs/protocol/event-catalog.md) |
| MCP tools | [mcp-protocol.md](docs/protocol/mcp-protocol.md) (v0.3) |
| Navigation | [navigation.md](docs/product/navigation.md) / [ADR-003](docs/decisions/ADR-003-navigation-information-architecture.md) |
| Visual style | [design-language.md](docs/design/design-language.md) |
| Build order | [roadmap.md](docs/development/roadmap.md) |

[docs/README.md](docs/README.md) is the full index.

## The runtime loop

Everything serves one cycle ([overview.md](docs/architecture/overview.md)):

```
Goal → Supervisor → Task Engine → MCP Server → Agent Execution
     → Event Core → { task state, memory, human surfaces }
```

Object spine: `Project → Goal → Task → Agent → Event → Knowledge`.

## Five rules that constrain implementation

1. **Event is the only writable object.** Tasks, agents, projects, knowledge and approvals are reducer outputs. A component that needs data it cannot derive from the log is a design smell — raise it, don't add a table. ([ADR-005](docs/decisions/ADR-005-derived-state-only.md))
2. **Never branch on `provider`.** Routing reads `capabilities` only, from the controlled vocabulary in [agent-schema.md](docs/protocol/agent-schema.md). Provider names may appear in adapters and nowhere else. ([ADR-004](docs/decisions/ADR-004-capability-first-agent-catalog.md))
3. **Agents request; the runtime decides.** An agent cannot write an event, set task status, or approve anything — including its own request. Validation happens at the MCP Server boundary.
4. **`progress` never causes a transition.** A task at 100% is still `running` until `report_result` arrives.
5. **Approvals never auto-grant.** An unanswered request emits `approval.expired` and the task stays blocked. A human message in a thread is guidance, never an approval ([threads.md](docs/product/threads.md)).

## Package architecture

Target layout: `apps/macos/`, `packages/`, `docs/`, `ui/`, `tests/`.

```
apps/macos → mcp-server → agent-sdk → event-core → { task-engine, memory-core }
```

Strictly downward. `event-core` must compile with no knowledge that a UI or an AI vendor exists; `task-engine` and `memory-core` are siblings and must not import each other. Build in that order — a UI written before the reducers exist will invent state.

| Package | Owns |
| --- | --- |
| `event-core` | The log, ordering, snapshots, replay, reducer registration |
| `task-engine` | Legal transitions, dependencies, capability routing |
| `memory-core` | Knowledge items, links, superseding |
| `agent-sdk` | Adapter surface; the lowest layer allowed to name a vendor |
| `mcp-server` | Validation, authorization, the v0.3 tools |

## Task lifecycle

```
created → assigned → running → review → completed
                        ⇅
                     blocked                    (+ failed, cancelled)
```

Lowercase everywhere including JSON. `blocked` is a bypass that returns to `running` with progress intact, not a stage. Terminal: `completed`, `failed`, `cancelled`. The transition matrix is small enough to test exhaustively — do that, it is the guard against this drifting again.

## UI

Seven top-level destinations: Project Library · Project Pulse · Canvas · Tasks · Agents · Memory · Settings. Runtime folds into Agents, Project Info into Project Detail. Two destinations carry a second view instead of earning a slot: Memory (list/graph) and Agents (roster/threads, [ADR-006](docs/decisions/ADR-006-threads-as-a-view-in-agents.md)). The toggle is the escape valve that keeps the sidebar at seven — reach for it before adding a destination.

`ui/` holds six high-fidelity renders — they are authoritative for spacing and visual detail, but **not for navigation** (they predate ADR-003) and **not for the provider list** (they show agents the old specs didn't list, which is why routing is capability-based). Bilingual zh-CN/en from the first release; externalize strings from day one.

[doc.html](doc.html) is the generated walkthrough: architecture, a user-facing guide, and inline high-fidelity mockups built from these specs. Regenerate it when the specs change materially.

## Working in this repo

- Follow the documentation rules in [AGENTS.md](AGENTS.md): update related docs in the same change, add an ADR for decisions that constrain future work (Context / Decision / Alternatives / Consequences), keep product, protocol and design synchronized.
- **One concept, one document.** The previous doc set had three copies of the event architecture, two of memory, three of the package layout and four overlapping phase plans. Extend the existing doc; do not add a second one.
- Adding an event type: catalog entry first, then reducer, then a replay test, then emit. Events are permanent — a type that ships wrong stays in old logs forever.
- Commit convention: `docs: …`, `architecture: …`, `design: …` — lowercase area prefix, imperative summary, no body.
- Specs are terse: ASCII diagrams, tables, no filler. Match that register.
