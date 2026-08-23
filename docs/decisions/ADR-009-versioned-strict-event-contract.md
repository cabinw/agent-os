# ADR-009: Versioned Strict Event Contract

Status: accepted

## Context

Events outlive the code that emits them. A permissive parser can silently drop
unknown fields or types, then replay a different state from the one originally
observed. A strict parser without a version cannot distinguish a corrupt event
from a later valid contract.

The first Spike also exposed three construction states that the original
envelope did not name: producer input has no runtime fields, a draft has no
allocated sequence, and only a durable event has a positive sequence.

## Decision

The permanent event protocol is versioned and strict.

- `schemaVersion` is required. The first contract is `1`; parsers are selected
  by version before event type.
- `EventInput` contains the admitted domain fact after runtime identity and
  subject are known.
- `EventDraft` adds runtime-owned `schemaVersion`, `id` and `at`, with
  `seq: null`.
- `StoredEvent` replaces `seq` with a project-local positive integer allocated
  by the append transaction.
- `subject` is required. `causedBy` is optional and runtime-owned.
- Event domain and `subject.kind` are bound: `agent.*` targets an agent,
  `task.*` a task, and likewise for every catalog domain. A task-scoped message
  targets exactly its payload task; a project message targets its envelope
  project. Task subjects use canonical `TASK-nnn` ids; project subjects equal
  the envelope project; duplicated agent registration/disconnection ids agree.
- The 29 v1 types form one discriminated union. Envelope, actor, subject,
  payload and nested objects reject unknown fields.
- Successful parsers return deeply readonly, recursively frozen protocol data.
  Consumers derive a new value rather than mutating an admitted fact in place.
- `EventInput` rejects unknown types and fields. Draft and stored-event parsers,
  including replay, select by version first and reject unknown versions or
  types. A reducer may ignore a catalogued event outside its concern; it may not
  treat an unknown event as a safe no-op.
- Event Core validates structure. Authorization, references, task transitions
  and other stateful domain rules remain in their owning layers.
- `causedBy` means causation only. Compensation requires a catalogued domain
  event with explicit reducer semantics.
- Events remain logically available from sequence 1 forever. Snapshots may be
  deleted; cold storage may move bytes but must preserve lossless replay.

The append idempotency token is command metadata, persisted by the store's
unique index. It is not part of the domain event envelope.

## Alternatives

**Accept unknown fields and types.** Rejected: projections can become quietly
wrong, which is worse than a visible incompatibility.

**Keep one unversioned schema and only add optional fields.** Rejected: an older
strict parser rejects those fields, so “optional” does not provide replay
compatibility.

**Put domain schemas above Event Core.** Rejected: append and replay would then
admit records whose permanent shape the kernel cannot verify. Event Core knows
the protocol vocabulary, not its business meaning.

**Compact events after memory extraction.** Rejected: Memory is a derived view.
Deleting its source would violate full replay and ADR-005.

## Consequences

- V1 payloads are frozen. A shape change requires a new schema version or a new
  catalogued event type, with its parser retained for old logs.
- The throwaway Spike JSONL is not a v1 log. Import requires an explicit,
  one-time migration; the formal parser is not weakened for compatibility.
- Deployment must install readers for a version before writers emit it.
- Schema failures stop append or replay loudly instead of producing partial
  state.
