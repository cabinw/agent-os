# Revival Mode

The feature that pays off "memory first". Opening a dormant project produces a
welcome-back report instead of a cold repository.

## Trigger

A project with no activity beyond a dormancy threshold (default 30 days) shows
the Revival card at the top of its Overview. Longer dormancy makes the report
more thorough, not less.

## The report

```
┌─────────────────────────────────────────────────────────┐
│ ✦ Revival Mode / 欢迎回来                                │
│ 项目已 inactive 312 天。让我们帮你快速回到状态。            │
│                                                         │
│   ✓ 已完成 42      ◐ 未完成 18      ⚠ 已知问题 7          │
│                                                         │
│ 推荐重启计划:                                            │
│  1) 环境检查  2) 依赖更新  3) 修复失效问题  4) 性能优化     │
│                                                         │
│ [ 恢复项目并制定重启计划 ]                                │
└─────────────────────────────────────────────────────────┘
```

## Contents

| Part | Answers | Derived from |
| --- | --- | --- |
| What was built | "Core pages, blog system, contact form" | `task.completed` |
| Current state | Phase, completion, health | Task reducer |
| Previous decisions | "PostgreSQL over MongoDB, because…" | Knowledge, type=decision |
| Unfinished work | Open tasks, ranked | Task reducer |
| Known issues | Failures and unresolved blockers | `task.failed`, open `task.blocked` |
| Restart plan | Ordered, estimated first steps | Supervisor, from the above |

## Restart plan

Not a task list dump. The Supervisor produces a short ordered plan with time
estimates, front-loading the work that unblocks everything else:

```
1  环境与依赖检查     预计 30 分钟    Node 版本、依赖更新、能否启动
2  修复关键问题       预计 2 小时     7 个已知问题中阻断运行的部分
3  SEO 与性能优化     预计 3 小时     原计划的下一步
```

Each step has a ▶ control that turns it into real tasks and assigns them.

## Staleness

The report states what it cannot know. Dependencies published after the last
activity, deprecated APIs, and expired credentials are flagged as *likely stale*
rather than asserted as broken — the environment check in step 1 exists to
convert those guesses into facts.

## Why it works

Every input already exists as events and knowledge. Revival Mode adds no new
data collection — it is a query over memory that happens to be the most valuable
query in the product.
