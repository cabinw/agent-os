# ADR-006: Threads Are a View in Agents, Scoped to Tasks

Status: accepted

## Context

Agents already message each other — `send_message` exists in the protocol and
`message.sent` is in the event catalog. The data has always been captured; there
was no surface for reading it. Adding one raises two questions.

**Where does it live?** [ADR-003](ADR-003-navigation-information-architecture.md)
fixed seven top-level destinations on the principle that *a view is not a place*.
A conversation reader is substantial enough to argue for an eighth.

**What is a thread?** Messages carry an optional `task`. Grouping could be by
task, by participant pair, or both.

## Decision

**Threads are a view inside Agents**, reached by a list/threads toggle — the same
mechanism Memory uses for its graph view. Task Detail additionally embeds the
thread for its own task, in context.

**A thread is scoped to a task.** One thread per task, plus exactly one
project-level thread per project for messages sent without a task. Filtering by
participant is a *filter over threads*, not a second grouping rule.

## Alternatives

**An eighth destination ("Threads").** Rejected. It would be the first sidebar
entry that isn't a distinct object domain — a thread is a rendering of messages
that already belong to tasks and agents. Admitting it re-opens the argument for
Runtime, Project Info, and Knowledge Graph, which ADR-003 closed on the same
grounds. Agents was also the thinnest destination in the product (a roster and a
capability table); it can carry this.

**Grouping by participant pair.** Rejected as a *primary* grouping. "Claude ↔
Codex" spans every task they ever collaborated on, so the thread has no subject
and messages lose the context that makes them readable. Kept as a filter, where
it works well.

**Both groupings, user's choice.** Rejected: two grouping rules means every
message belongs to two threads, and "where do I reply?" has no answer.

## Consequences

- Agents becomes a two-view destination: **目录** (roster, health, capability
  coverage) and **对话** (thread reader).
- A message sent with no `task` lands in the project thread rather than
  disappearing. Agents should still prefer to scope messages to a task.
- Thread membership is derived, not stored. A message moving between tasks is
  impossible by construction — `task` is set at send time and events are
  immutable.
- Reading a thread must interleave the task's lifecycle events, or the
  conversation reads as disembodied chat. See
  [product/threads.md](../product/threads.md).
- Unread state is **local UI state, not project state** — it is per-person and
  per-device, so it is a stored read pointer, not an event.
  ([ADR-005](ADR-005-derived-state-only.md) governs project state, not
  preferences.)
