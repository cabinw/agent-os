# Event Core

The kernel of Agent OS. Supersedes the former `event-system.md`,
`event-engine.md` and `event-core-design.md`.

## Responsibility

Own the versioned event contract, append-only log and everything derived from
it. Event Core knows the 29 permanent record shapes but not their business
meaning: it validates, persists, orders and replays records, then runs reducers
registered by higher layers. Task transitions, authorization and routing remain
outside the kernel.

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
  "schemaVersion": 1,
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

- `schemaVersion` selects the permanent parser. V1 is frozen; unknown versions
  fail append and replay.
- `seq` is a per-project monotonic integer. It defines replay order; wall-clock
  time does not.
- `causedBy` links an event to the one that triggered it, giving Canvas its edges
  and Memory its causal chains.
- `actor` distinguishes human, agent, and system origin — needed for audit and
  for rendering "who did this".
- `subject` is required and identifies the primary projection target. A
  task-scoped message points to that task; a project message points to its
  project. Every other event domain binds directly to the same subject kind
  (`agent.* → agent`, `task.* → task`, and so on). Task subjects use canonical
  `TASK-nnn` ids, project subjects equal envelope `project`, and duplicated
  agent registration/disconnection ids must agree with the subject.

Construction has three strict representations:

```
EventInput  = type + project + actor + subject + causedBy? + payload
EventDraft  = EventInput + schemaVersion + id + at + seq:null
StoredEvent = EventDraft with seq: positive integer
```

`id`, `at`, authenticated `actor` and `causedBy` are runtime-owned. The store
allocates `seq` inside the append transaction. `seq 0` means “before the first
event” when requesting replay; it is never a stored sequence.

Event ids are canonical uppercase Crockford ULIDs prefixed with `evt_`; parsers
do not normalize lowercase or ambiguous alphabet characters.

The envelope, actor, subject, payload and nested payload objects reject unknown
fields. Unknown event types fail closed. A reducer may ignore a catalogued event
outside its domain; it must never silently accept a type the installed parser
does not know. Successful input, draft, stored-event and payload parses are
deeply readonly and recursively frozen; projection code must copy to derive a
new value instead of modifying an admitted fact. See
[ADR-009](../decisions/ADR-009-versioned-strict-event-contract.md).

Event names and payloads are specified in
[protocol/event-catalog.md](../protocol/event-catalog.md).

## Guarantees

| Property | Guarantee |
| --- | --- |
| Immutability | Events are never edited, compacted or logically deleted. A mistake is corrected by a catalogued domain event. |
| Ordering | Total order per project via `seq`. No global order across projects. |
| Durability | An event is acknowledged to its producer only after it is persisted. |
| Replay | Reducing every event from the start reproduces current state exactly. Cold storage may move bytes but cannot make events unavailable. |
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
  the Task Engine. Structural schema validation still belongs here.
- It does not call agents.
- It does not summarize. Turning events into prose is Memory Core's job.
