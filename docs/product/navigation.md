# Navigation and Information Architecture

**Canonical.** Resolves the two conflicting sidebars in the `ui/` mockups. See
[ADR-003](../decisions/ADR-003-navigation-information-architecture.md).

## Top level

Seven destinations. Nothing else earns a sidebar slot.

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

- No active project → **Project Library**
- Active project → **Project Pulse**

Pulse is the daily answer to "what happened while I was away", so it is the
default for anyone with work in flight.

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

The executable route ids and order are frozen by
[ADR-025](../decisions/ADR-025-macos-shell-and-navigation.md). The sidebar is
always visible at the supported native window sizes. Initial selection is
Project Library without an active project and Project Pulse with one; Runtime,
Project Info and Knowledge Graph are forbidden as top-level route ids.
