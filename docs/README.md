# Agent OS Documentation

## Reading order

New to the project: [vision](vision.md) → [architecture/overview](architecture/overview.md) →
[protocol/mcp-protocol](protocol/mcp-protocol.md) → [development/roadmap](development/roadmap.md).

## Index

### Architecture

| Doc | Covers |
| --- | --- |
| [overview](architecture/overview.md) | The runtime loop, layers, and how components fit |
| [event-core](architecture/event-core.md) | The kernel: bus, store, replay, reduction |
| [task-engine](architecture/task-engine.md) | Task lifecycle, assignment, dependencies |
| [agent-runtime](architecture/agent-runtime.md) | Agent lifecycle, registry, capability matching, adapters |
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
| [ADR-007](decisions/ADR-007-implementation-stack.md) | TypeScript + Tauri 2 + SQLite, single-machine |

## Assets

`ui/` holds high-fidelity renders. They are the authority for layout and visual
detail; the design docs describe intent, not pixels.
