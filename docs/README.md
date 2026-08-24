# Agent OS Documentation

## Reading order

New to the project: [vision](vision.md) → [architecture/overview](architecture/overview.md) →
[ADR-008](decisions/ADR-008-server-hub-local-first-runners.md) →
[ADR-009](decisions/ADR-009-versioned-strict-event-contract.md) →
[protocol/event-catalog](protocol/event-catalog.md) →
[protocol/mcp-protocol](protocol/mcp-protocol.md) → [development/roadmap](development/roadmap.md).

## Index

### Architecture

| Doc | Covers |
| --- | --- |
| [overview](architecture/overview.md) | The runtime loop, layers, and how components fit |
| [event-core](architecture/event-core.md) | Versioned event contract; bus, store, replay, reduction |
| [task-engine](architecture/task-engine.md) | Task lifecycle, assignment, dependencies |
| [agent-runtime](architecture/agent-runtime.md) | Local / Remote Runners, sessions, host capability, adapters |
| [supervisor-agent](architecture/supervisor-agent.md) | The AI project manager |
| [memory](architecture/memory.md) | Events → knowledge → project memory |
| [packages](architecture/packages.md) | Monorepo layout and dependency direction |
| [data-model](architecture/data-model.md) | Project / Goal / Task / Agent / Event / Knowledge |

### Protocol

| Doc | Covers |
| --- | --- |
| [mcp-protocol](protocol/mcp-protocol.md) | **Canonical.** All MCP tools, v0.3 |
| [event-catalog](protocol/event-catalog.md) | **Canonical.** Every event name and payload |
| [task-schema](protocol/task-schema.md) | Task object |
| [agent-schema](protocol/agent-schema.md) | Agent object and capability vocabulary |

### Product

| Doc | Covers |
| --- | --- |
| [navigation](product/navigation.md) | **Canonical.** Information architecture |
| [project-pulse](product/project-pulse.md) | The daily briefing surface |
| [project-library](product/project-library.md) | Managing projects across their lifecycle |
| [revival-mode](product/revival-mode.md) | Restarting a dormant project |
| [threads](product/threads.md) | The record of agent-to-agent conversation |
| [approvals](product/approvals.md) | Human-in-the-loop gate |

### Design

| Doc | Covers |
| --- | --- |
| [design-language](design/design-language.md) | **Canonical.** Color, type, elevation, motion |
| [project-library-ui](design/project-library-ui.md) | Library and project detail layouts |
| [threads-ui](design/threads-ui.md) | Thread reader layout |
| [canvas](design/canvas.md) | The spatial workspace |
| [menu-bar](design/menu-bar.md) | macOS menu-bar extra |

### Development

| Doc | Covers |
| --- | --- |
| [roadmap](development/roadmap.md) | **Canonical.** Phases and milestones |
| [package-development-guide](development/package-development-guide.md) | Build order and package rules |
| [testing-strategy](development/testing-strategy.md) | What gets tested and how |

### Decisions

| ADR | Decision |
| --- | --- |
| [ADR-001](decisions/ADR-001-mcp-as-agent-communication-layer.md) | MCP is the agent communication layer |
| [ADR-002](decisions/ADR-002-task-lifecycle.md) | One task lifecycle, `blocked` as a bypass state |
| [ADR-003](decisions/ADR-003-navigation-information-architecture.md) | Seven top-level destinations |
| [ADR-004](decisions/ADR-004-capability-first-agent-catalog.md) | Agents are matched by capability, never by provider |
| [ADR-005](decisions/ADR-005-derived-state-only.md) | No component stores state the event log can derive |
| [ADR-006](decisions/ADR-006-threads-as-a-view-in-agents.md) | Threads live in Agents and are scoped to tasks |
| [ADR-007](decisions/ADR-007-implementation-stack.md) | TypeScript + Tauri 2 + SQLite; deployment scope superseded |
| [ADR-008](decisions/ADR-008-server-hub-local-first-runners.md) | Server Hub; Local Runner first, Remote Runner next |
| [ADR-009](decisions/ADR-009-versioned-strict-event-contract.md) | Versioned strict events; draft/stored boundary; lossless replay |
| [ADR-010](decisions/ADR-010-projection-snapshots-as-sidecar-cache.md) | Projection snapshots are versioned, validated, discardable sidecar cache |
| [ADR-011](decisions/ADR-011-task-dependency-admission.md) | Batch dependency graphs validate before append; readiness stays derived |
| [ADR-012](decisions/ADR-012-event-catalog-live-routing.md) | Event-derived Agent Catalog joins live placement telemetry for deterministic routing |
| [ADR-013](decisions/ADR-013-mcp-call-admission-boundary.md) | Authenticated call context and strict schemas feed one transport-neutral Runtime Port |
| [ADR-014](decisions/ADR-014-mcp-agent-authorization-matrix.md) | MCP uses a fixed registered/owner/executor matrix; role never grants authority |
| [ADR-015](decisions/ADR-015-blocking-approval-gate.md) | Approval calls block behind atomic event groups; timeout only expires and never grants |
| [ADR-016](decisions/ADR-016-agent-sdk-boundaries.md) | AgentClient, Runner and Adapter are separate one-way contracts; no generic event append exists |
| [ADR-017](decisions/ADR-017-supervisor-plan-admission.md) | Supervisor maps local plan keys to Task ids and atomically admits decisions with the graph |
| [ADR-018](decisions/ADR-018-thread-projection-attribution.md) | Thread projection derives cross-event attribution and keeps progress runs lossless |
| [ADR-019](decisions/ADR-019-phase-one-demo-composition.md) | Phase 1 acceptance is an offline formal-package composition with atomic event groups |
| [ADR-020](decisions/ADR-020-knowledge-candidate-classification.md) | Memory extraction opens only from exhaustive structural anchors; strict drafts reuse Event Core |

## Assets

`ui/` holds high-fidelity renders. They are the authority for layout and visual
detail; the design docs describe intent, not pixels.
