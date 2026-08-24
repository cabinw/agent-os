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

## SQLite store (RM-1.1b)

The concrete store lives in `@agent-os/event-store-sqlite`, not in the
dependency-free `event-core` package. Only `apps/hub` installs it. Runner and UI
deployments must not contain `better-sqlite3` or its native binary.

The RM-1.1b surface is deliberately smaller than the later Event Bus:

```ts
openSqliteEventStore(options) → SqliteEventStore
store.append(input, { token }) → StoredEvent
store.backup(destination) → Promise<BackupEvidence>
store.close() → void
```

`input` is parsed as strict `EventInput` before storage. `token` is trimmed,
non-empty command metadata with a 256-byte UTF-8 limit; it is scoped by
`project`. Reusing `(project, token)` with the same parsed input returns the
original stored event. Reusing it with different input fails with an explicit
idempotency conflict. The retry lookup happens before generating runtime-owned
`id` or `at`.

The v1 database is identified by a fixed SQLite `application_id` and
`user_version = 1`. Its permanent tables are:

```sql
event_store_meta(format_version, created_at)
project_sequences(project PRIMARY KEY, last_seq)
events(
  project, seq,
  id UNIQUE,
  schema_version,
  client_token,
  input_json, input_sha256,
  event_json,
  PRIMARY KEY(project, seq),
  UNIQUE(project, client_token)
)
```

All tables are `STRICT`. `events` has `BEFORE UPDATE` and `BEFORE DELETE`
triggers that abort, and the connection enables recursive triggers so
`INSERT OR REPLACE` cannot hide a delete. Store startup verifies the exact
tables, indexes and guards; unknown or partial objects fail closed.

Append uses `BEGIN IMMEDIATE`. Inside that transaction it:

1. looks up `(project, token)` and returns or rejects the prior command;
2. allocates the next project-local sequence from `project_sequences`;
3. creates and validates the draft, then inserts one immutable stored event;
4. commits before returning the event to the producer.

The canonical parsed input JSON is stored alongside its SHA-256 digest. The
digest is an index aid, never the sole equality proof. `UNIQUE(id)` protects the
global event identity independently of project ordering.

Opening an empty database creates the schema in one exclusive transaction.
Opening a non-empty database with a foreign application id, unknown version,
unexpected object or failed integrity check performs no migration and no schema
write. Normal connections require WAL, `synchronous=FULL`, foreign keys,
`trusted_schema=OFF`, recursive triggers and a bounded busy timeout. SQLite does
not consistently invoke the busy handler while competing connections switch a
new database to WAL, so that PRAGMA also has a bounded lock retry; concurrent
first open must not fail merely because another admitted writer starts first.

Online backup uses SQLite's backup API, never a file copy of the live database.
It writes a new same-directory temporary database, verifies application id,
schema, integrity and event counts, closes and fsyncs it, then publishes it by
atomic rename and fsyncs the destination directory. An existing destination,
source alias or failed verification is rejected without replacing evidence.
Opening the backup with the same store is the restore proof; operational file
replacement remains the deployment layer's responsibility.

## Reducers

A reducer is a pure function `(state, event) → state`. Registering one is how a
feature gets a view without adding a table anyone writes to.

RM-1.1c composes any conforming store through the dependency-free Event Core
surface:

```ts
createEventBus({ store, onSubscriberError? }) → EventBus
bus.append(input, { token })                  → StoredEvent
bus.subscribe(handler, { project? })          → unsubscribe
bus.replay(project)                           → ReplayEvidence
bus.registerReducer(name, initialState, fn, snapshot?) → ReducerHandle<State>
handle.get(project)                           → DeepReadonly<State>

store.read(project, { afterSeq? })             → readonly StoredEvent[]
```

`initialState` is a factory, so projects never share a mutable initial object.
Reducer names are unique for the lifetime of a bus. Registration after a
project has been observed synchronously replays that project's complete log for
the new reducer; a failed registration publishes neither the reducer nor a
partial state.

The bus initializes a project by replaying its stored log before accepting a
new append. After the store durably appends, the bus reads every sequence after
its last projected sequence and reduces them in order. This tail catch-up makes
an append safe when another connection committed first. An idempotent retry
whose sequence is already projected is returned without a second reduction or
notification.

For each event, every reducer computes a candidate state before any candidate
is published. A thrown or asynchronous reducer faults that event visibly and
leaves all projections at the preceding sequence. `replay(project)` rebuilds
all registered projections from fresh initial states and never calls live
subscribers. Reducer inputs and published outputs are recursively frozen.

Subscribers run only after durable append and successful reduction. One
subscriber cannot fail an append, another subscriber, or a later event;
`onSubscriberError` receives the failure. Reentrant appends are allowed, but
their notifications queue behind all subscribers for the current sequence, so
every subscriber observes project order. Unsubscribing is idempotent.

```
taskReducer      → task status, progress, assignment, dependency readiness
agentReducer     → agent status, current task, health
memoryReducer    → knowledge items, decision log, timeline
pulseReducer     → today's headline, progress deltas, risks
```

Reducers may be rebuilt from scratch at any time, so a reducer bug is fixed by
correcting the code and replaying — never by hand-patching stored state.

## Snapshots

Full replay is the correctness model, not the hot path. The bus writes a state
snapshot every N events; startup loads the latest snapshot and replays the tail.
Snapshots are a cache and may be discarded without data loss.

RM-1.1d keeps projection snapshots outside the permanent event database. The
SQLite adapter exposes a separate cache file and Event Core only sees this
interface:

```ts
createEventBus({
  store,
  snapshots,
  snapshotEvery,
  onSnapshotError?
})

snapshots.load(project, manifest)  → ProjectionSnapshot | null
snapshots.save(snapshot)           → void
snapshots.delete(project, manifest) → void
snapshots.clear(project?)          → deleted row count
```

The sidecar is a separate identified SQLite database, not a table added
silently to the frozen event-store v1 format. It contains only the latest cache
row for `(project, manifest)`. Deleting the file or every row must leave a full
replay with identical state. Event-store backup does not include it.

When snapshots are enabled, every reducer registration supplies an explicit
cache version and a synchronous strict state parser. The manifest is the
canonical sorted list of `(reducer name, cache version)`; changing a reducer's
projection semantics requires changing its version. Function source text is
never hashed as a substitute for a version.

A snapshot records `project`, `throughSeq`, `throughEventId`, `manifest` and one
state per registered reducer. Startup accepts it only when:

1. its manifest and exact state-key set match the installed reducers;
2. every state passes that reducer's current parser;
3. the event at `throughSeq` still has `throughEventId`;
4. the ordered tail begins at `throughSeq + 1`.

Any load, parse, anchor or save failure is reported to `onSnapshotError`, the
bad cache row is discarded when possible, and Event Core falls back to full
replay. Snapshot failure never rolls back or hides a durable event. Capture
happens after all reducer candidates for the boundary event are published; it
never notifies live subscribers and never writes a domain event.

`project.snapshot.captured` is unrelated: it records a user-visible visual
checkpoint in the permanent event log. Runner session/request JSON snapshots
are also operational state, not reducer caches, and cannot satisfy RM-1.1d.
See [ADR-010](../decisions/ADR-010-projection-snapshots-as-sidecar-cache.md).

## What Event Core does not do

- It does not validate domain rules. "Can this task move to `review`?" belongs to
  the Task Engine. Structural schema validation still belongs here.
- It does not call agents.
- It does not summarize. Turning events into prose is Memory Core's job.
