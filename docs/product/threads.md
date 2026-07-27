# Threads

The record of what the agents said to each other. Placement is settled by
[ADR-006](../decisions/ADR-006-threads-as-a-view-in-agents.md); layout is in
[design/threads-ui.md](../design/threads-ui.md).

## Why this exists

An event feed answers *what happened*. A thread answers *what they said about
it* — the handoff, the question, the objection, the correction. When a task goes
wrong, the reason is almost always in the messages, and until now those messages
were captured and unreadable.

It also closes a gap in the memory story. Knowledge items record conclusions;
threads record the discussion that produced them. Revival Mode can say a project
chose PostgreSQL; a thread can show the argument.

**This is a reducer and a surface, not new data collection.** `send_message`
already emits `message.sent`. Nothing new is captured.

## What a thread is

```
Thread = one task's messages, in seq order, interleaved with that task's
         lifecycle events.

One thread per task. Plus exactly one project thread per project, holding
messages sent with no task.
```

Thread identity is derived: `thread(project, task?)`. There is no stored thread
object and no way to move a message between threads — `task` is fixed at send
time and events are immutable.

## Interleaving is the point

A thread that shows only messages reads as disembodied chat. A thread that folds
in the task's own lifecycle events reads as a record of the work:

```
09:02  ◆ Claude → Codex          instruction
       实现 webhook 处理，幂等性必须保证
───────────────────────────────  TASK-014 · running · Codex 开始执行
09:41  ◆ Codex → Claude          question
       重复投递的重试语义没定义，按 at-least-once 还是去重?
───────────────────────────────  TASK-014 · blocked · 等待人工决策  ⚠
10:15  ◆ 你 → Codex              answer
       用幂等键去重。这个决策我记进记忆了。
───────────────────────────────  TASK-014 · running · 阻塞解除
```

Interleaved event types: `task.started`, `task.blocked`, `task.unblocked`,
`task.review.requested`, `task.completed`, `task.failed`, `approval.*`,
`knowledge.created`. They render as dividers, not as messages.

## Message types

The seven from the protocol, each with distinct visual weight:

| Type | Meaning | Weight |
| --- | --- | --- |
| `instruction` | Delegation — do this | Accent, prominent |
| `question` | Blocking on an answer | Amber |
| `answer` | Resolves a question | Normal, quotes the question |
| `report` | Result summary | Normal |
| `review` | Verdict on someone's output | Accent |
| `warning` | Something is wrong | Risk |
| `progress` | Status, no decision | Muted, collapsible |

`progress` is muted and collapsible on purpose: in a long agentic run it is
most of the volume and almost none of the meaning.

## Human participation

A person can post into a thread. It emits `message.sent` with
`actor.kind: "human"` and renders distinctly from agent messages.

This is genuinely useful — it is how you steer a run without cancelling it — but
it carries one hard constraint:

> **A human message is guidance, not an approval.** It can change what an agent
> does next; it cannot grant a `request_approval`. Approvals have their own
> event family and their own surface. An implementation that lets "yes go ahead"
> in a thread satisfy a pending approval has defeated
> [product/approvals.md](approvals.md).

Optional per project. A project may run threads read-only.

## Reading

| Control | Behavior |
| --- | --- |
| Thread list | Ordered by last activity. Shows task title, last message preview, participants, unread count. |
| Participant filter | "Claude ↔ Codex" across all threads — a filter, never a grouping. |
| Type filter | Hide `progress`; show only `question` + `warning` when triaging. |
| Search | Full text across messages; results link into their thread at the right position. |
| Jump to task | Every thread header links to its task; every task links back. |

## How this differs from the two surfaces that look similar

Three places show agent communication. They are not redundant, and the
distinction should stay sharp:

| Surface | Shows | Answers |
| --- | --- | --- |
| **Pulse → Agent Activity** | Recent *actions*, one line each, across all tasks | What is the team doing right now? |
| **Canvas** | Message edges between agent nodes | Who talks to whom, structurally? |
| **Threads** | Full message content, in order, with task context | What did they actually say, and why did this task go the way it did? |

Pulse is a dashboard, Canvas is a map, Threads is a transcript. If any two start
converging, the one that drifted is wrong.

## Unread state

Per person, per device — a stored read pointer (`lastSeenSeq` per thread), not an
event. Unread count is derived by comparing the pointer against the log.
[ADR-005](../decisions/ADR-005-derived-state-only.md) governs project state;
this is a preference.

## Retention

Messages follow event retention. When events are compacted after knowledge
extraction, a thread may become sparse — the extracted knowledge item remains and
the thread links to it. A thread is never silently emptied: a compaction marker
renders in place of removed spans.
