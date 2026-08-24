# Project Library UI

Visual style is specified in [design-language.md](design-language.md); this doc
covers layout.

## Library page

```
┌────────┬──────────────────────────────────────────┬─────────────────┐
│        │  项目库                    [grid][list] [+ 新建项目]        │
│ side   │  管理和浏览所有项目                                          │
│ bar    ├──────────────────────────────────────────┤   detail        │
│        │  [全部 12][进行中 4][已暂停 3][已归档 4][已完成 1]  │   panel       │
│        ├──────────────────────────────────────────┤   (opens on     │
│        │  stat cards ×5                            │    selection)   │
│        ├──────────────────────────────────────────┤                 │
│        │  project rows                             │                 │
│        ├──────────────────────────────────────────┤                 │
│        │  项目洞察: trend · stack donut · AI 建议    │                 │
└────────┴──────────────────────────────────────────┴─────────────────┘
```

## Project row

Five columns, fixed order so the eye can scan down any one of them:

```
[cover 88×64]  name + state badge      进度 ▓▓▓▓░ 72%    技术栈        最后活动
               AI summary              当前工作: TASK-14 Next.js …    2 小时前
               avatars +3  优先级       开发                          Codex 完成 TASK-014
```

`当前工作` is derived from the Task projection. Do not relabel it `当前阶段`:
no canonical phase field exists. Missing sourced summary or next step gets an
explicit empty state.

## Detail panel

Tabs: 概览 · 时间线 · 记忆 · 文件 · 设置.

Overview blocks, in order:

1. **项目快照** — last updated, state, completion bar, current phase, last
   activity, agent count, health
2. **AI 项目简介** — generated brief, with a link to the full report
3. **Revival Mode** — only when dormant; see
   [product/revival-mode.md](../product/revival-mode.md)
4. **技术栈** — chips
5. **建议下一步** — up to three, each with an estimate and a ▶ control
6. **项目时间线** — dated entries attributed to the agent responsible
7. **决策记录** — decision cards with rationale and date
8. **项目记忆 / 关联知识** — typed knowledge items

Primary action at the foot of the panel: **恢复项目** for paused, **打开项目**
for active.

## Node snapshot filmstrip

Horizontally scrolling strip of dated visual checkpoints, each captioned with
label, date and state. Sits between the summary blocks and the timeline. It is
the fastest available context restorer for a dormant project.

## Reference renders

- `ui/Project_Library/project-library-white-ui.png` — library with detail drawer
- `ui/Project_Detail/project-detail-overview.png` — detail with Revival Mode
- `ui/Project_Detail/project-snapshot-node-overview.png` — detail with filmstrip

The renders are authoritative for spacing and visual detail.
