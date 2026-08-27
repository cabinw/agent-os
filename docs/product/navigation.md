# Navigation and Information Architecture

**Canonical.** Resolves the two conflicting sidebars in the `ui/` mockups. See
[ADR-003](../decisions/ADR-003-navigation-information-architecture.md).

## Execution home

The product opens on a project-bound Code Agent session per
[ADR-047](../decisions/ADR-047-code-session-first-product-entry.md):

```
project / workspace · ready Agent · conversation · active Run · evidence
```

This is the place to start and control work. Its stable shell-root route id is
`execution`; it sits outside the seven-item project-intelligence navigation
array and is not an eighth project-data destination. `apps/macos` owns this
product route in both browser development and Tauri. The 4173 Spike page remains
a diagnostic surface.

## Project intelligence

Seven sourced destinations remain the project map around the execution home.
They may live in secondary navigation; they are not required before the first
prompt.

| # | Destination | Answers |
| --- | --- | --- |
| 1 | **Project Library** 项目库 | Which project? |
| 2 | **Project Pulse** 项目脉冲 | What happened? |
| 3 | **Canvas** 画布 | How does it fit together? |
| 4 | **Tasks** 任务 | What is the work? |
| 5 | **Agents** 智能体 | Who is doing it, are they healthy, and what are they saying? |
| 6 | **Memory** 记忆 | What do we know, and why? |
| 7 | **Settings** 设置 | Configuration |

## Folded in

Three destinations from the mockups were removed. Each was a view, not a place:

| Removed | Now lives in | Reason |
| --- | --- | --- |
| Runtime | Agents | Runtime status *is* agent status. Two lists of the same agents is a maintenance tax and a user question ("which one is authoritative?"). |
| Project Info | Project Detail | Project metadata belongs with the project, not in a global slot that changes meaning per selection. |
| Knowledge Graph | Memory (view toggle) | The graph is one rendering of memory. Splitting them makes users choose a UI before they choose a question. |

## View toggles

Two destinations carry a second view rather than earning a second slot. Both use
the same header-mounted segmented control:

| Destination | Views |
| --- | --- |
| **Memory** | 列表 list · 图谱 graph |
| **Agents** | 目录 roster · 对话 threads ([ADR-006](../decisions/ADR-006-threads-as-a-view-in-agents.md)) |

A view toggle is the escape valve that keeps the sidebar at seven. Use it when a
surface is a *rendering* of a destination's objects; add a destination only for a
genuinely new object domain.

## Landing

- No selected project → project selection / import in the execution home
- Selected project → its most recent Code Agent Conversation or a new composer
- Pulse → secondary answer to "what happened while I was away"

The entry must show Agent readiness before it accepts a prompt. Hub connectivity
alone is not execution readiness. Ready requires sourced facts for executable,
vendor authentication, Runner connection/acceptance, workspace authorization
and capacity. Every failed fact has an actionable diagnosis and observation
time.

## Product entry

- Local browser: `pnpm experience` → `http://localhost:5173/`
- Local native window: `pnpm experience:native`
- Local mode with no configured human token bootstraps a loopback-only web
  session. Deployed Hubs show the connection-key exchange from
  [ADR-046](../decisions/ADR-046-human-web-sessions-and-loopback-bootstrap.md).
- The current implementation still lands on Pulse and exposes **New task**. This
  is the legacy entry being replaced; it is not the ADR-047 acceptance path.
- The target entry selects a real project workspace, shows executable Codex /
  Claude readiness and starts from a prompt. Task and capability fields are not
  first-use requirements.
- Browser mode selects a `(project, runnerHost)` placement already authorized by
  the Runner; it cannot submit an arbitrary filesystem path. Native path picking
  uses narrow feature-owned IPC and the same Runner containment admission.
- A 100% task remains in Review until the human accepts or returns it from
  Tasks. Progress never substitutes for lifecycle state.

## Project Detail

Opened from the Library, as a drawer over the grid or a full page. Tabs:

```
概览 Overview · 时间线 Timeline · 记忆 Memory · 文件 Files · 设置 Settings
```

Overview carries the snapshot, AI brief, Revival Mode card when dormant,
decision log and next-step suggestions.

## Menu-bar extra

The macOS menu bar is a peer surface, not a shortcut. It exists so a user can
answer "is anything waiting on me?" without opening the app. Contents are
specified in [design/menu-bar.md](../design/menu-bar.md).

## Language

The interface ships bilingual (zh-CN / en) from the first release — both appear
in the reference renders. Strings are externalized from day one; no literal
copy in view code.

## Shell contract

The seven project-intelligence route ids and order remain frozen by
[ADR-025](../decisions/ADR-025-macos-shell-and-navigation.md). ADR-047 supersedes
its initial-selection and always-primary-sidebar rules: the execution home is
primary at stable root id `execution`, and those routes are secondary. Runtime,
Project Info and Knowledge Graph remain forbidden as additional
project-intelligence route ids.
