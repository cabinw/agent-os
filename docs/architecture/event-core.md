# Event Core

The kernel of Agent OS. Supersedes the former `event-system.md`,
`event-engine.md` and `event-core-design.md`.

## Responsibility

Own the append-only event log and everything derived from it. Event Core knows
nothing about tasks, agents or UI — it moves, persists, orders and replays
opaque records, and runs reducers registered by higher layers.

## Flow

```
producer (MCP Server / Task Engine / Supervisor)
   │  append(event)
   ▼
Event Bus ──────────────▶ live subscribers (Canvas, Pulse, menu bar)
   │
   ▼
Event Store  (append-only, ordered, durable)
   │
   ▼
Reducers ──▶ Task State · Agent State · Project Memory · Pulse Digest
```

## Event envelope

Every event carries the same envelope; only `payload` varies by type.

```json
{
  "id": "evt_01H...",
  "type": "task.progress.updated",
  "seq": 4821,
  "project": "proj_oldwebsite",
  "actor": { "kind": "agent", "id": "codex-developer" },
  "subject": { "kind": "task", "id": "TASK-014" },
  "at": "2026-07-27T09:41:02Z",
  "causedBy": "evt_01H...",
  "payload": { "progress": 65, "note": "Implementing MCP tools" }
}
```

- `seq` is a per-project monotonic integer. It defines replay order; wall-clock
  time does not.
- `causedBy` links an event to the one that triggered it, giving Canvas its edges
  and Memory its causal chains.
- `actor` distinguishes human, agent, and system origin — needed for audit and
  for rendering "who did this".

Event names and payloads are specified in
[protocol/event-catalog.md](../protocol/event-catalog.md).

## Guarantees

| Property | Guarantee |
| --- | --- |
| Immutability | Events are never edited or deleted. A mistake is corrected by a compensating event. |
| Ordering | Total order per project via `seq`. No global order across projects. |
| Durability | An event is acknowledged to its producer only after it is persisted. |
| Replay | Reducing the full log from `seq 0` reproduces current state exactly. |
| Idempotence | Producers supply a client token; a retried append returns the original event. |

## Reducers

A reducer is a pure function `(state, event) → state`. Registering one is how a
feature gets a view without adding a table anyone writes to.

```
taskReducer      → task status, progress, assignment, dependency readiness
agentReducer     → agent status, current task, health
memoryReducer    → knowledge items, decision log, timeline
pulseReducer     → today's headline, progress deltas, risks
```

Reducers may be rebuilt from scratch at any time, so a reducer bug is fixed by
correcting the code and replaying — never by hand-patching stored state.

## Snapshots

Full replay is the correctness model, not the hot path. The store writes a state
snapshot every N events; startup loads the latest snapshot and replays the tail.
Snapshots are a cache and may be discarded without data loss.

## What Event Core does not do

- It does not validate domain rules. "Can this task move to `review`?" belongs to
  the Task Engine.
- It does not call agents.
- It does not summarize. Turning events into prose is Memory Core's job.
