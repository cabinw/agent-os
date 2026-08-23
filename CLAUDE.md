# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

pnpm is provided by corepack (`corepack pnpm …`); there is no global install.

| Command | Does |
| --- | --- |
| `pnpm install` | Install workspace deps. `pnpm-workspace.yaml` allowlists install scripts — approve new ones deliberately. |
| `pnpm build` | `tsc --build` across project references |
| `pnpm test` | Vitest. `pnpm test -- tests/layering.test.ts` for one file |
| `pnpm check` / `check:fix` | Biome lint + format |
| `pnpm check:layers` | Layering guard — see below |
| `pnpm verify` | build + check + check:layers + test. Run before every commit. |

**There is no CI by decision.** `pnpm verify` is the only gate, and it is manual — run it. `check:layers` enforces four rules mechanically: no vendor names below `agent-sdk` (ADR-004), dependency direction, `task-engine` ⇄ `memory-core` isolation, and no event type absent from the catalog. It also runs inside `pnpm test`, so the suite cannot go green while a layering rule is broken.

**Picking this up cold?** Read [HANDOFF.md](HANDOFF.md) first — the working code
is in `apps/chat-spike/`, not in `packages/`.

## Repository status

The executable implementation is in `apps/chat-spike/`: event log, MCP boundary,
Hub runtime and four vendor adapters. `packages/*/src/index.ts` still hold formal
contracts and foundational types, not the Phase 1 kernel.

Alongside the code: Markdown specs under `docs/`, high-fidelity renders under `ui/`, a generated walkthrough at `doc.html`, an implementation plan at `todo.html`.

Stack: TypeScript + Tauri 2 + SQLite. Deployment is Server Hub plus outbound
Runners ([ADR-008](docs/decisions/ADR-008-server-hub-local-first-runners.md));
ADR-007's single-machine scope is superseded. Gates / auth and the Local Runner
vertical slice are complete; current order is shared contract → Remote Runner → formal Event Core
([roadmap](docs/development/roadmap.md)).

The Local Runner has strict request / result / event / error shapes, workspace
containment and persistent `(user, project, agent)` sessions. The Hub supports
Runner injection and has vertical-slice regression coverage. The default
composition still permits a direct-adapter fallback; make Runner injection
mandatory while finishing the shared contract so the Hub becomes dispatch-only.

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
| Hub / Runner deployment | [ADR-008](docs/decisions/ADR-008-server-hub-local-first-runners.md) |

[docs/README.md](docs/README.md) is the full index.

## The runtime loop

Everything serves one cycle ([overview.md](docs/architecture/overview.md)):

```
Goal → Supervisor → Task Engine → Server Hub → Local / Remote Runner
     → MCP requests / result stream → Event Core
     → { task state, memory, human surfaces }
```

Object spine: `Project → Goal → Task → Agent → Event → Knowledge`.

## Five rules that constrain implementation

1. **Event is the only writable object.** Tasks, agents, projects, knowledge and approvals are reducer outputs. A component that needs data it cannot derive from the log is a design smell — raise it, don't add a table. ([ADR-005](docs/decisions/ADR-005-derived-state-only.md))
2. **Never branch on `provider`.** Routing reads `capabilities` only, from the controlled vocabulary in [agent-schema.md](docs/protocol/agent-schema.md). Provider names may appear in adapters and nowhere else. ([ADR-004](docs/decisions/ADR-004-capability-first-agent-catalog.md))
3. **Agents request; the runtime decides.** An agent cannot write an event, set task status, or approve anything — including its own request. Validation happens at the MCP Server boundary.
4. **`progress` never causes a transition.** A task at 100% is still `running` until `report_result` arrives.
5. **Approvals never auto-grant.** An unanswered request emits `approval.expired` and the task stays blocked. A human message in a thread is guidance, never an approval ([threads.md](docs/product/threads.md)).

## Package architecture

Target layout: `apps/hub/`, `apps/runner/`, `apps/macos/`, `packages/`, `docs/`,
`ui/`, `tests/`. The Hub composes state and dispatches only; Runners own adapters,
vendor sessions and working copies.

`A → B` reads **A imports B**:

```
apps/macos / apps/hub → mcp-server → { agent-sdk, task-engine, memory-core } → event-core
apps/runner → agent-sdk → event-core types
```

`event-core` is the bottom of the stack and depends on nothing — it exports `registerReducer` and the domain packages register into it, never the reverse. `task-engine` and `memory-core` are siblings and must not import each other. Enforced by `pnpm check:layers`.

Build order is `event-core → task-engine → mcp-server → agent-sdk → memory-core` — a UI written before the reducers exist will invent state.

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
