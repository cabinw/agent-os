# ADR-041: Privileged Administrator-Kit Migration

Status: accepted for staging

## Context

The Hub administrator kit is root-owned executable policy. Application releases
cannot supply or replace it. The installed staging kit predates the stopped-state
backup, forensic inspection, capacity, open-reference and recovery-start tools:
it has 17 files, while the audited replacement has 25.

A cold bootstrap correctly refuses to overwrite an installed kit. Replacing the
tree in place would mix trusted generations during a crash, could leave systemd
using stale unit content and would provide no durable evidence from which to
resume or roll back. A state restore under ADR-040 cannot repair this trust
boundary because its source and target are Hub data, not privileged code. See
[ADR-040](ADR-040-staging-state-snapshot-and-recovery.md).

## Decision

Only this separately delivered entry point may replace an installed kit:

```text
bootstrap-admin.sh --migrate-installed \
  --expected-current-sha256 <allowlisted-legacy-tree-sha256> [--rollback]
```

The operator pin must equal the one compiled legacy tree digest. Before any
mutation, and again under the global deployment lock, migration verifies the
exact 17-file tree, root ownership, modes, single-link files, legacy runtime
copies and trusted replacement source. Unknown, partially upgraded or locally
modified installations fail closed. A general old-digest parameter or direct
tree replacement is not supported.

Migration disables automatic start before publishing the persistent ingress
block, stops the writer and proves the state quiescent. It stages complete old
and new administrator/runtime sets on the same local filesystem, records their
canonical digests and publishes each phase with rename plus directory fsync.
The live tree is switched as a whole; systemd is reloaded and its effective
fragment, drop-ins and reload state are revalidated before a service start.

Each attempt has an immutable journal. Version 2 journals bind a six-digit
attempt number to the preceding rolled-back transaction and its journal digest.
Attempts are contiguous. Only a finalized `rolled_back` attempt may precede a
new attempt; committed history is forward-only. Historical journals and their
forensic artifacts remain immutable.

Forward completion requires the exact 25-file kit and runtime set, a
transaction-bound one-time start token, exact liveness, enablement, `committed`,
durable maintenance cleanup and `finalized`. Rollback requires the exact legacy
kit and runtime set, effective-unit revalidation, liveness, enablement,
`rolled_back`, durable cleanup and `finalized`. A crash or failed durability
step retains the exact block, disabled or guarded service topology and journal.
Retry continues the selected transaction; it never guesses from the live tree.

If a failed start leaves a recovery token, operators follow the token recovery
procedure in the [deployment runbook](../../deploy/README.md). They do not
delete it, change its transaction or relax the startup gate.

## Alternatives

**Use cold bootstrap with an overwrite flag.** Rejected: it has no stopped
writer proof, generation journal or crash recovery contract.

**Install the eight new files beside the old kit.** Rejected: old scripts and
units would execute a mixed policy generation.

**Ship the administrator kit inside an application release.** Rejected:
unprivileged application content must not become privileged executable policy.

**Accept any operator-supplied old digest.** Rejected: a checksum proves only
identity, not that the old format and rollback semantics were audited.

**Delete failed journals and retry from the live tree.** Rejected: the live tree
does not prove which filesystem and systemd transitions became durable.

## Consequences

- Administrator-kit migration requires a controlled idle window and Hub
  downtime.
- Only the allowlisted 17-file staging generation can use this migration path;
  future generations require a new reviewed source contract.
- Journal, previous, failed and staging artifacts are root-only operational
  evidence and require an explicit retention policy.
- A failed attempt can intentionally leave the Hub disabled and ingress blocked
  until the same transaction converges or an exact rollback is completed.
- Root ownership and canonical digests prove local identity, not publisher
  authenticity. Signed administrator-kit provenance remains a production gate.
- Target-Ubuntu staging evidence completed the exact 17-file (`1f064246…`) to
  25-file (`444a9550…`) migration on 2026-08-25. All installed files remained
  root-owned and single-link (15 mode `0444`, 10 mode `0555`); state, env and
  release pointers were invariant and the service returned active+enabled with
  no block, token or maintenance sentinel. Publisher authentication remains a
  separate production blocker.
