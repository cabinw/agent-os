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
| `pnpm verify` | build + type-contract check + Biome + check:layers + tests. Run before every commit. |

**There is no CI by decision.** `pnpm verify` is the only gate, and it is manual — run it. `check:layers` enforces four rules mechanically: no vendor names below `agent-sdk` (ADR-004), dependency direction, `task-engine` ⇄ `memory-core` isolation, and no event type absent from the catalog. It also runs inside `pnpm test`, so the suite cannot go green while a layering rule is broken.

**Picking this up cold?** Read [HANDOFF.md](HANDOFF.md) first. The executable
Hub / Runner is in `apps/chat-spike/`; formal Event Core work is in `packages/`.

## Repository status

The executable Hub / Runner implementation is in `apps/chat-spike/`. The formal
Event Core, SQLite store, Task Engine, MCP, SDK and memory packages plus approval,
Supervisor and human-surface implementations are covered by the repository gate.

Alongside the code: Markdown specs under `docs/`, high-fidelity renders under `ui/`, a generated walkthrough at `doc.html`, an implementation plan at `todo.html`.

Stack: TypeScript + Tauri 2 + SQLite. Deployment is Server Hub plus outbound
Runners ([ADR-008](docs/decisions/ADR-008-server-hub-local-first-runners.md));
ADR-007's single-machine scope is superseded. Gates / auth, Local Runner, the
shared contract, Remote Runner, formal kernel and server deployment tracks are
complete. The active track is ENTRY: refactor the existing runtime into a
project-bound Code Agent session; see ADR-047 and the roadmap.

The Local Runner has strict request / result / event / error shapes, durable
request-id idempotency, cancellation / health / close semantics, workspace
containment and persistent `(user, project, agent)` sessions. Runner injection
is mandatory: the Hub has no direct-adapter, working-copy or vendor execution
path.

That session key is the legacy task/Spike contract. ENTRY-1 scopes visible Code
Conversations as `(user, project, conversation, agent)`; do not let two
Conversations reuse one opaque vendor handle.

Remote mode uses an independent host principal, an outbound-only Worker,
durable host placement and request replay, random lease fencing and heartbeat.
The Hub owns no remote working copy or vendor credential; vendor children do
not inherit Agent OS control-plane credentials.

## What Agent OS is

A persistent project environment for Code Agents. A human opens a repository,
prompts a real Codex or Claude Agent, observes and controls execution, and keeps
evidence and project memory across sessions. Tasks, Supervisor planning and
multi-agent delegation remain deeper execution semantics, not the first-use
entry. Herdr is a product reference only; never add it as a substrate or
dependency.

The four principles in [AGENTS.md](AGENTS.md) — MCP first, event driven, memory first, human in the loop — are load-bearing constraints. Reject designs that mutate state outside the event stream, integrate a provider outside MCP, or perform an irreversible action without an approval step.

## Canonical sources

The specs were rewritten to remove conflicts. When anything disagrees, these win:

| Topic | Authority |
| --- | --- |
| Task states | [ADR-002](docs/decisions/ADR-002-task-lifecycle.md) |
| Event names and payloads | [event-catalog.md](docs/protocol/event-catalog.md) |
| Event envelope and versioning | [ADR-009](docs/decisions/ADR-009-versioned-strict-event-contract.md) / [event-core.md](docs/architecture/event-core.md) |
| MCP tools | [mcp-protocol.md](docs/protocol/mcp-protocol.md) (v0.3) |
| Navigation | [navigation.md](docs/product/navigation.md) / [ADR-003](docs/decisions/ADR-003-navigation-information-architecture.md) |
| Product entry | [ADR-047](docs/decisions/ADR-047-code-session-first-product-entry.md) / [HANDOFF](HANDOFF.md) |
| Visual style | [design-language.md](docs/design/design-language.md) |
| Build order | [roadmap.md](docs/development/roadmap.md) |
| Hub / Runner deployment | [ADR-008](docs/decisions/ADR-008-server-hub-local-first-runners.md) |

[docs/README.md](docs/README.md) is the full index.

## The runtime loop

Everything serves one cycle ([overview.md](docs/architecture/overview.md)):

```
Project Conversation / Run ────────────────────────┐
optional Goal → Supervisor → Task Engine ─────────┤
                                                   ▼
Server Hub → Local / Remote Runner → Agent → Event Core
           → { run/task state, memory, human surfaces }
```

Current formal object spine: `Project → Goal → Task → Agent → Event →
Knowledge`. ENTRY-1 must add or explicitly limit `Conversation → Run` without
overloading Task or Vendor Session.

## Five rules that constrain implementation

1. **Event is the only writable object.** Tasks, agents, projects, knowledge and approvals are reducer outputs. A component that needs data it cannot derive from the log is a design smell — raise it, don't add a table. ([ADR-005](docs/decisions/ADR-005-derived-state-only.md))
2. **Never branch domain logic or autonomous Task routing on `provider`.** Routing reads `capabilities` only, from [agent-schema.md](docs/protocol/agent-schema.md). A product client may display and directly select a configured Agent such as Codex or Claude; vendor invocation stays in adapter/integration code and UI behavior follows declared capabilities. ([ADR-004](docs/decisions/ADR-004-capability-first-agent-catalog.md), [ADR-047](docs/decisions/ADR-047-code-session-first-product-entry.md))
3. **Agents request; the runtime decides.** An agent cannot write an event, set task status, or approve anything — including its own request. Validation happens at the MCP Server boundary.
4. **`progress` never causes a transition.** A task at 100% is still `running` until `report_result` arrives.
5. **Approvals never auto-grant.** An unanswered request emits `approval.expired` and the task stays blocked. A human message in a thread is guidance, never an approval ([threads.md](docs/product/threads.md)).

## Package architecture

Formal target layout: `apps/hub/`, `apps/runner/`, `apps/macos/`, `packages/`,
`docs/`, `ui/`, `tests/`. The executable Hub and Runner are still composed in
`apps/chat-spike/`. The Hub composes state and dispatches only; Runners own
adapters, vendor sessions and working copies.

`A → B` reads **A imports B**:

```
apps/macos / apps/hub → mcp-server → { agent-sdk, task-engine, memory-core } → event-core
apps/runner → agent-sdk → event-core types
```

`event-core` is the bottom of the stack and has zero internal workspace
dependencies. It exports the versioned event contract and reducer registration.
Domain packages register into it, never the reverse. `task-engine` and
`memory-core` are siblings and must not import each other. Enforced by
`pnpm check:layers`.

Build order is `event-core → task-engine → mcp-server → agent-sdk → memory-core` — a UI written before the reducers exist will invent state.

| Package | Owns |
| --- | --- |
| `event-core` | Versioned strict event contract, log, ordering, snapshots, replay, reducer registration |
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

The product entry is a project-bound Code Agent execution home: project,
executable Agent readiness, prompt, Run state and evidence. Project Library,
Project Pulse, Canvas, Tasks, Agents, Memory and Settings remain seven sourced
secondary project-intelligence destinations. Runtime folds into Agents and
Knowledge Graph into Memory. Do not make Pulse, a capability form or multi-agent
team setup the first-use path.

`apps/macos` owns the one product client at 5173 and in Tauri; the 4173 Spike
page is diagnostic. The execution home uses stable shell-root id `execution`
outside the frozen seven-item secondary navigation array. Browser project
selection is limited to Runner-authorized `(project, host)` placements.

Before implementing the new composer, distinguish user-visible Conversation,
one prompt's durable Run, Runner-owned Vendor Session and optional Task. Direct
`/say` does not currently supply a complete persistent Run lifecycle; do not
paper over that protocol gap in React.

`ui/` holds six high-fidelity renders — they are authoritative for spacing and visual detail, but **not for navigation** (they predate ADR-003) and **not for the provider list** (they show agents the old specs didn't list, which is why routing is capability-based). Bilingual zh-CN/en from the first release; externalize strings from day one.

[doc.html](doc.html) and the high-fidelity renders predate ADR-047. They remain
historical visual reference until regenerated and cannot override the current
entry contract.

## Working in this repo

- Follow the documentation rules in [AGENTS.md](AGENTS.md): update related docs in the same change, add an ADR for decisions that constrain future work (Context / Decision / Alternatives / Consequences), keep product, protocol and design synchronized.
- **One concept, one document.** The previous doc set had three copies of the event architecture, two of memory, three of the package layout and four overlapping phase plans. Extend the existing doc; do not add a second one.
- Adding an event type: catalog entry first, then reducer, then a replay test, then emit. Events are permanent — a type that ships wrong stays in old logs forever.
- Commit convention: `docs: …`, `architecture: …`, `design: …` — lowercase area prefix, imperative summary, no body.
- Specs are terse: ASCII diagrams, tables, no filler. Match that register.
