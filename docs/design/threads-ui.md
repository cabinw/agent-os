# Threads UI

Visual style is [design-language.md](design-language.md); behavior is
[product/threads.md](../product/threads.md).

## Placement

Agents becomes a two-view destination. The toggle sits in the page header, in the
same position as Memory's list/graph control:

```
智能体          [ 目录 | 对话 ]              [＋ 注册智能体]
```

Task Detail embeds the same thread inline, below the task's outputs. Same
reducer, same components, no second implementation.

## Layout

Three columns inside the content area:

```
┌────────┬───────────────┬──────────────────────────────────┐
│ side   │ 会话列表 264px │ 消息面板 flex                     │
│ bar    │               │                                  │
│ 220px  │ ⌕ 搜索         │ TASK-014 实现 webhook 处理  ▸打开 │
│        │ [全部][未读]   │ Claude · Codex · 你   · running  │
│        │ ─────────────  │ ─────────────────────────────── │
│        │ ● TASK-014     │                                  │
│        │   Codex: 重复… │   消息流（可滚动，倒序加载）        │
│        │   4分钟前  ②   │   · 消息气泡                      │
│        │ ─────────────  │   · 生命周期分隔线                 │
│        │   TASK-017     │   · 折叠的 progress 段            │
│        │   Grok: 等待…  │                                  │
│        │   2天前        │ ─────────────────────────────── │
│        │ ─────────────  │ [ 输入框 · 仅在允许人工发言时显示 ] │
│        │   项目会话      │                                  │
└────────┴───────────────┴──────────────────────────────────┘
```

Below 1100px the thread list collapses to a back-button master/detail flow. The
sidebar never collapses (ADR-003).

## Thread list row

```
● TASK-014  实现 webhook 处理          4分钟前
  Codex: 重复投递的重试语义没定义…        ②
  [C][✳][人]                    ⚠ blocked
```

- Leading dot: unread indicator, accent
- Preview: last message, one line, ellipsized, prefixed by sender
- Trailing: relative time; unread count badge; task status chip when not `running`
- Avatars: up to 3 participants, `+N` beyond

Ordered by last activity. The project thread pins to the bottom.

## Message row

```
┌──┐  Codex  [question]  09:41
│C │  重复投递的重试语义没定义,按 at-least-once 还是去重?
└──┘  ↳ 回复 Claude 09:02 的 instruction
      [▤ handler.ts]  [◆ KN-052]
```

| Part | Spec |
| --- | --- |
| Avatar | 26px, provider mark, status dot only if disconnected |
| Name | 13px/620. Human messages show 你 / the person's name |
| Type chip | 10.5px, colored per the table in product/threads.md |
| Time | 11px muted, absolute on hover |
| Content | 13.5px/1.6, markdown, code fences highlighted |
| Reply quote | One collapsed line linking to the parent message |
| Attachments | Chips: outputs link to files, `KN-*` link into Memory |

Consecutive messages from the same sender within 2 minutes collapse the avatar
and header — standard chat grouping, keeps long agent monologues readable.

Human messages are **left-aligned like every other message**, differentiated by
an accent left border and a 你 label. They are not right-aligned: this is a
transcript of a team, not a two-party chat, and right-alignment would falsely
imply the human is one side of a dialogue.

## Lifecycle dividers

```
──────────  TASK-014 · blocked · 等待人工决策  ⚠  09:44  ──────────
```

Full-width hairline with a centered label. Colored by severity: neutral for
`started`/`completed`, amber for `blocked`/approval-pending, risk for `failed`.
Never rendered as a message bubble — the visual distinction between "someone
said" and "something happened" is load-bearing.

## Progress collapsing

Runs of consecutive `progress` messages collapse into one line:

```
⋯ Codex 的 6 条进度更新（65% → 100%）          展开
```

Expanded state is per-thread and remembered locally. This is the single highest-
leverage decision for long-run readability.

## Filters

Header row above the message pane, hidden until used:

```
[ 全部类型 ▾ ]  [ 全部参与者 ▾ ]  [ ⌕ 在本会话中搜索 ]
```

Participant filter applied from the Agents roster produces a cross-thread view:
the message pane shows matching messages from every thread, each carrying its
task label. The thread list dims to indicate the filter is global.

## Composer

Only present when the project allows human participation. Single-line growing
to multi-line, `⌘↵` to send, `@` to address a specific agent (sets `to`;
omitting it addresses the task's executor).

**No approval affordance.** The composer must not offer 批准 / 拒绝 buttons even
when an approval is pending in the thread — the pending approval renders as a
divider linking to the approval surface. See
[product/approvals.md](../product/approvals.md).

## Empty states

| State | Shows |
| --- | --- |
| No threads yet | The one action that produces them — assign a task to a second agent |
| Thread with only lifecycle events | The task's timeline, plus "尚无智能体对话" — not a blank pane |
| Filter matches nothing | The active filters, each individually clearable |

## Live behavior

New messages animate in with the standard 200ms fade + 8px rise. If the user has
scrolled up, new messages do **not** yank the viewport — a "N 条新消息 ↓" pill
appears at the bottom edge instead.
