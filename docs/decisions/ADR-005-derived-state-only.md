# ADR-005: Derived State Only

Status: accepted

## Context

"Event driven" was stated as a principle but never given teeth. Without a rule,
the pragmatic path during implementation is always the same: add a `tasks` table,
write to it directly, and emit an event afterwards for the UI. The event log
then becomes a notification channel, and within a release the two disagree.

Three of this product's features are replay queries — Project Pulse (replay
today), Revival Mode (replay everything), Canvas (subscribe live). All three
break quietly if the log is not the truth.

## Decision

Event is the only writable object. Every other entity — task, agent, project,
knowledge, approval — is a reducer output.

- Producers call `append`. Nothing else writes.
- Reducers are pure `(state, event) → state` and may be rebuilt from `seq 0`.
- Snapshots are a cache, discardable without data loss.
- A reducer bug is fixed by correcting code and replaying, never by patching
  stored state.
- Corrections are compensating events, never edits or deletes.

## Alternatives

**Write state directly, emit events for observers.** Rejected: the log becomes
decorative and history becomes unreconstructable — which removes the product's
main differentiator.

**Event-sourced tasks, direct-write everything else.** Rejected: memory and
approvals are precisely the places where "why did this happen" matters most.

## Consequences

- Any component needing data it cannot derive from events is a design smell to
  be raised, not worked around.
- Replay performance is a real engineering concern; snapshots exist for it.
- Every recorded log becomes a regression test.
- Implementation is slower at the start and dramatically cheaper at Phase 4,
  when Revival Mode is simply a query rather than a data-collection project.
