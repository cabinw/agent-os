# ADR-010: Projection Snapshots Are a Sidecar Cache

Status: accepted

## Context

RM-1.1b froze event-store format v1 before projection snapshots existed. Adding
a cache table silently would make one version identify two schemas. Keying a
snapshot only by reducer name would also restore stale semantics after code
changes.

Visual `project.snapshot.captured` events and Runner session/request snapshots
are different concepts. Neither is a reducer-state cache.

## Decision

Projection snapshots live in a separate identified SQLite sidecar.

- The event database remains format v1 and is sufficient for full replay.
- The cache key is project plus a canonical manifest of reducer name and
  explicit cache version.
- Every snapshotted reducer supplies a synchronous strict state parser.
- A row records the through sequence and event id. Restore verifies that anchor
  against the permanent log before replaying the tail.
- Load, parse, anchor and save failures fall back to full replay. Bad rows are
  deleted when possible.
- Cache writes occur after all reducer states for the boundary event publish.
  They never emit a domain event or fail a durable append.
- Cache backup is unnecessary. Deleting the sidecar or all rows must preserve
  state exactly.

## Alternatives

**Add a table to event-store v1.** Rejected: one format id would name two exact
schemas; migration for a discardable cache adds risk to permanent facts.

**Hash reducer function source.** Rejected: bundlers and harmless refactors make
it unstable, while semantic changes can evade it. Version is an explicit domain
promise.

**Trust cached JSON without a parser or event anchor.** Rejected: corrupted,
stale or wrong-log state would become a second fact source.

## Consequences

- Startup can replay only the tail without weakening ADR-005.
- Reducer semantic changes must bump their cache version.
- Snapshot state must be strict JSON data; non-JSON output simply disables its
  cache and remains fully replayable.
- Event-store backup and restore remain independent of cache lifecycle.
