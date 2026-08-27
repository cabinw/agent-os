# ADR-003: Seven Top-Level Destinations

Status: accepted; landing hierarchy superseded by ADR-047

## Context

The high-fidelity renders in `ui/` show two different sidebars:

| Reference screens | Project Library screens |
| --- | --- |
| Project Pulse, Canvas, Tasks, Runtime, Project Info, Memory, Settings | 项目库, 项目脉冲, 智能画布, 任务中心, 智能体, 记忆库, 知识图谱, 设置 |

Between them: Project Library, Agents and Knowledge Graph appear in one only;
Runtime and Project Info appear in the other only. Neither list was written into
`docs/`, so navigation had no specification at all.

## Decision

Seven destinations:

```
Project Library · Project Pulse · Canvas · Tasks · Agents · Memory · Settings
```

Three candidates are folded in rather than given a slot:

| Folded | Into | Reason |
| --- | --- | --- |
| Runtime | Agents | Runtime status *is* agent status. Two lists of the same agents forces users to ask which is authoritative. |
| Project Info | Project Detail | Its content is per-project metadata. A global slot whose meaning changes with selection is a worse home than the project itself. |
| Knowledge Graph | Memory, as a view toggle | The graph is a rendering of memory, not a separate corpus. Separating them makes the user choose a visualization before choosing a question. |

The original landing was Project Library with no active project and Project
Pulse with one. ADR-047 supersedes that landing: a project-bound Code Agent
session is primary, while these seven destinations remain sourced secondary
project-intelligence views. Its stable shell-root id `execution` sits outside
the destination array; it is not an eighth project-data domain.

## Alternatives

**Ship both sidebars per context.** Rejected: navigation that changes shape is
the fastest way to make an app feel unlearnable.

**Keep all ten items.** Rejected: three of them are views, and a sidebar that
lists views alongside places stops being a map.

## Consequences

- The Agents view must carry runtime detail — health, throughput, heartbeat —
  not just a roster.
- Memory needs a list/graph toggle as a first-class control, not a hidden one.
- Project Detail becomes a substantial surface, since it absorbs Project Info.
- The mockups are now partially out of date; they remain authoritative for
  visual detail, not for navigation.
