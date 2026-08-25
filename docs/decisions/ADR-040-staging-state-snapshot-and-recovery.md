# ADR-040: Staging State Snapshot and Recovery

Status: accepted for staging

## Context

The Hub persists one append-only `events.jsonl`, placement JSON and one terminal
request record per `requestId`. These files have no shared transaction or online
snapshot boundary. Release rollback changes code only; it cannot decide what an
in-flight Task Engine projection should become after restart.

The spike EventLog now replays strictly. Invalid UTF-8, a partial final frame,
blank or surrounding-whitespace frames, malformed JSON, invalid event shape,
sequence gaps, duplicate event ids, mixed projects and invalid causal
references are fatal. Startup never skips a malformed frame to obtain liveness.

An append uses two durable uncertainty markers:

```text
<events>.write-intent
  → append frame + fsync
  → rename to <events>.write-committed + directory fsync
  → unlink marker + directory fsync
  → attempt to return from append
```

An unresolved `.write-intent` does not prove a committed event. An unresolved
`.write-committed` proves a durable frame but not whether the caller observed
success. Either marker makes restart fail closed. Operators must stop the Hub
and preserve the state for offline adjudication; they must not delete a marker
or treat `.write-committed` as implicit success.

The markers do not make caller acknowledgement atomic with storage commit. A
process can crash after the committed marker unlink is durable but before the
caller observes the return. Restart then sees a valid frame and no marker even
though the caller may retry. The JSONL spike has no operation-level idempotency
key with which to close that final window. This is an explicit staging blocker,
not a proven exactly-once or unambiguous-ack contract; RM-1.1b must close it.

## Decision

### State and artifact formats

The Hub has one writer. A strict stopped-state snapshot moves these filesets
together:

```text
events.jsonl
remote-placement.json
remote-placement.json.requests/*.json
```

Worker state remains on its Worker. A strict snapshot is a new root-only
directory:

```text
<snapshot-id>/
  data/...
  manifest.json
  manifest.sha256
  COMPLETE
```

The canonical strict manifest version is `1`. It records sorted safe paths and
metadata, file hashes, entry/file/byte counts and the source tree hash. Per-file
semantic fields record counts; the event-log entry also records its last
sequence and replay projection hash. Placement and terminal request entries are
counted. `manifest.sha256` pins the canonical manifest.
`COMPLETE` is written and synced last. Verification recomputes the digest and
exact tree. Restore materialization additionally requires the operator-supplied
expected manifest digest.

A forensic artifact has the same outer names but a distinct `forensic-v1`
format. It preserves a structurally safe raw state tree when strict semantic
validation identifies an eligible corrupt state. It can only be created and
verified. It cannot be materialized and is never a rollback source.

Both formats copy every allowed regular file below the state root. Traversal is
path- and object-type-based and performs no content or secret scan. A secret
mistakenly placed in the state root is copied. Every strict snapshot, forensic
artifact and recovery journal is therefore high-sensitive, root-owned and
root-only. Operational evidence may expose only fixed diagnostics plus hashes,
counts, stages and exit status; a canary value or file body is never logged.

Snapshot creation requires, in order:

```text
global deploy flock
→ quiescent probe
→ persistent public block + private audit record
→ second quiescent probe
→ stop service + inactive unit/MainPID=0 + observable-reference gate
→ reject assigned/running/inflight replay
→ bytes/inodes peak-capacity gate
→ no-follow exclusive copy into .incomplete-*
→ strict offline replay + source-before/after fingerprint equality
→ file and directory fsync
→ atomic publish
```

The one allowlisted legacy staging server predates the quiescent HTTP probe.
Only its exact root-owned, `0444`, single-link application hash may replace the
online probes with guards followed by writer-stop proof and the same canonical
offline replay/active-task measurement. A different application with a missing
or failed probe is rejected. This compatibility path cannot skip maintenance,
the observable-reference gate or offline semantic validation.

Symlinks, hardlinks, special files, unsafe temporary files, cross-device or
unstable traversal, active tasks and invalid replay fail closed. No operation
overwrites an artifact or the only state copy.

The observable-reference gate is not a global proof of future write ability.
It supports one local, persistent, writable `ext4` mount and rejects nested,
stacked, overlay, network, FUSE, tmpfs and read-only state mounts. Across two
stable `/proc` scans it checks visible task descriptors (including deleted and
O_TMPFILE path fallback), mount aliases, state-inode shared mappings with
`VM_MAYWRITE`, exact state/immediate-parent cwd/root/dirfd references, service
UID and service cgroup membership. An unavailable leaderless task view fails
closed. Queued `SCM_RIGHTS`, io_uring registrations, `pidfd_getfd`, higher
ancestor openat capability, remote writers and later trusted-root reopen are
outside that observation; the invariant also depends on a dedicated UID,
clean cgroup, `0700` state directory and trusted root.

### Restore journal

The only mutating administrative state entry points are:

```text
state-admin.sh backup
state-admin.sh restore
state-admin.sh recover-old
```

There is no generic repoint command. A restore first verifies the requested
strict snapshot and exact manifest digest. Before stopping the writer or
changing a state pointer it durably writes an `intent` containing the restore
transaction, target snapshot, target manifest digest, target canonical tree and
parent transaction. A standalone restore creates a `recovery-pre-*` parent; an
existing failure block must be bound explicitly with `--from-transaction`.

After writer-stop proof, the current tree is preserved as either a strict
snapshot or, for an eligible semantic corruption only, a forensic artifact.
Durable `metadata` pins the intent, parent, preservation mode, target and
preserved artifact ids/digests/trees and the raw current tree. The persistent
block is then atomically chained from the parent to the restore transaction.

Intent, metadata and phase entries use private temporary files followed by
rename and directory fsync. Only a recognized owner-only journal temporary may
be removed after a crash. Normal forward phases are:

```text
prepared → staged → old_moved → new_activated → verified → committed
```

Strict precommit compensation ends in `rolled_back`. A journal containing only
a valid orphan intent from a clean standalone `recovery-pre-*` parent may be
proved replayable and ended in `aborted`. An orphan tied to an explicit parent
requires a new signed restore bound to that parent; it is not auto-aborted.

`committed`, `rolled_back` and `aborted` are terminal. Recovery verifies the
terminal tree, obtains an exact transaction-bound one-time start token, checks
liveness and enablement, and only finalizes block/sentinel cleanup. A committed
transaction is never compensated backward.

A forensic restore is forward-only. The raw forensic artifact remains immutable
verify-only evidence. Once its journal is prepared, and especially after
`old_moved`, `recover-old` continues the same journal toward the pinned target;
it never reactivates or materializes the corrupt source tree.

Strict snapshot/materialization publication uses a target-scoped hard-link
lease whose private record binds PID, Linux process starttime, nonce and target
digest. Lock-owner inspection is tri-state: live and unknown both refuse;
only an absent PID or a successfully observed different starttime is stale.
The next invocation may validate and reclaim that exact stale pair after
SIGKILL. Malformed, linked, misowned or wrong-mode lock topology is preserved
and refused. `recover-old` likewise uses transaction-stable staging and
preserved-new names, so a phase-lag retry adopts and verifies the same objects
instead of inventing PID/random successors.

### Crash and cleanup boundary

The persistent block is the authority. Volatile normal/hard-maintenance
sentinels are removed and the runtime directory is synced while the durable
block remains. The durable block is removed and the operations directory is
synced last. A crash or failed sync before that boundary retains or republishes
the exact transaction block and startup remains closed. A crash after the
operations-directory sync is a clean terminal completion.

Only a transaction-bound recovery start token can cross a durable block.
`ExecStartPre` consumes it once and verifies the exact requested transaction.
Manual sentinel removal, direct pointer changes and an unbound service start do
not authorize recovery.

`events.jsonl` is authoritative and is never logrotated, segmented,
`copytruncate`d or pruned. Only journald and the Nginx error log rotate.
Already verified artifacts may be removed only by a separately approved,
explicit retention operation; deletion is never automatic. Same-disk snapshots
are rollback aids, not disaster recovery.

## Alternatives

**Online filesystem copy.** Rejected: JSONL and JSON state have no shared
transaction boundary.

**Start and accept partial replay.** Rejected: strict replay makes every invalid
frame and unresolved write marker fatal.

**Delete a write marker after inspection.** Rejected: the marker encodes an
unresolved caller-acknowledgement boundary. Offline adjudication needs the raw
state and an operation-level idempotency decision.

**Restore in place.** Rejected: interruption could destroy the only old copy.

**Use a forensic artifact as a snapshot.** Rejected: it proves raw preservation,
not semantic replayability.

**Rotate `events.jsonl`.** Rejected: reducers require one authoritative ordered
history and no segment protocol exists.

**Infer a terminal state for in-flight tasks.** Rejected: retry and reassignment
are Task Engine decisions, not deployment policy.

## Consequences

- Upgrade, rollback, backup and restore require a measurable idle window and
  downtime.
- Strict restore preserves placement and terminal request replay. It does not
  prove at-most-once execution across an already in-flight crash.
- Event markers fence precommit and uncertain-commit crash phases, but the
  durable-marker-cleanup-to-caller-observation window remains ambiguous without
  operation-level idempotency.
- Every backup, forensic artifact and recovery record requires root-only local
  storage, quota enforcement and approved retention.
- Per-artifact quota/retention enforcement and off-host encrypted disaster
  recovery remain operational blockers.
- Release upgrade/rollback still lacks an equivalent fsynced transaction
  journal; shell traps are not a SIGKILL recovery contract.
- Real Linux evidence for every same-inode alias, bind-mount and writable-fd
  edge remains required on the target filesystem.
- This contract is staging-only. Production durability still depends on the
  formal Event Core store in RM-1.1b and a defined in-flight Task Engine policy.
- Privileged administrator-kit replacement follows
  [ADR-041](ADR-041-privileged-admin-kit-migration.md); state restore is not an
  administrator-kit upgrade mechanism.
- Target-Ubuntu staging evidence completed one strict backup, corrupted-copy
  rejection and signed restore on 2026-08-25. The snapshot manifest was
  `71392fe3…`; the restored canonical state tree was `bc079a58…`; the final
  service was active and enabled with no block/token/maintenance sentinel and
  the stopped-state observable-reference result was `ok:true`.
