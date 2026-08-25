# ADR-044: Allowlisted Administrator-Kit Generation Upgrade

Status: implementation checkpoint; target-Ubuntu acceptance pending

## Context

ADR-041 moves the audited 17-file administrator kit to the first 25-file
generation. It intentionally rejects any other source tree. A later 25-file
generation cannot be installed file by file: a crash would mix privileged
policy generations, while an operator-provided digest would authorize an
unaudited source merely because it can be hashed.

## Decision

The separately delivered bootstrap exposes one reviewed generation identifier:

```text
bootstrap-admin.sh --upgrade-generation hub-admin-25-20260825-g3 [--rollback]
```

The identifier selects compile-time identities in `bootstrap-admin.sh`. The
operator cannot supply an old or new digest. This edge fixes:

- old 25-file administrator tree `50363eb8…`;
- new 25-file administrator tree `e140e212…`;
- old and new runtime payload `ccbc5110…` (the five runtime files are unchanged);
- the optional ADR-041 predecessor transaction and its immutable journal
  digest `7b9ee35e…`;
- the retained `g1` ancestor and its immutable journal digest `7a332db8…`; and
- the retained initial migration ancestor and its immutable journal digest `8ff2613d…`.

An absent predecessor is permitted for a host cold-installed at `50363eb8…`.
If predecessor history is present, every retained ancestor must match the
explicit transaction/digest allowlist. This includes the complete known chain,
not only the direct predecessor. Every other `upgrade-admin-migration-*`
namespace is rejected. The trusted source is fingerprinted before the first
deployment lock and again under that lock.
The compile-time chain is bounded to 32 transaction/digest pairs.

The generation path reuses one migration state machine from ADR-041. It
disables automatic start, publishes persistent ingress and runtime guards,
stops the Hub and proves the observable-reference gate before mutation. It
copies a complete 25-file target and old/new runtime payloads to private
same-filesystem staging, records exact metadata, and switches the live
administrator directory only with whole-tree rename plus parent-directory
fsync. There is no per-file live administrator update.

The journal retains the ADR-041 forward and rollback phases. A failed
publication, systemd reload, authorized start, health check, enablement or
maintenance cleanup leaves the service disabled or guarded and is resumed by
the same command. Rollback restores the complete old tree and runtime set; it
does not infer a generation from the live namespace.

If rollback has durably recorded `rolled_back` but its guarded service start
failed, the separately delivered bootstrap validates that exact unfinished
transaction under the deployment lock and republishes only its matching
one-time recovery-start token before resuming. It does not authorize an
unrecorded, committed or finalized transaction.

## Alternatives

**Accept `--expected-current-sha256` and `--expected-next-sha256`.** Rejected:
an operator could bless arbitrary privileged code.

**Copy only changed files.** Rejected: crashes create a mixed executable
policy generation and make rollback identity ambiguous.

**Maintain a second migration library.** Rejected: two privileged recovery
kernels would drift. Generation support remains in the single `bin/lib.sh`;
only fixed edge identities live outside the installed 25-file tree.

## Consequences

- Each future administrator generation needs a new reviewed identifier and
  explicit digest edge.
- The historical `g1` edge moved `444a9550…` to `f9063464…`; `g2` then moved
  `f9063464…` to `50363eb8…`. Their completed target-Ubuntu journals are the
  immutable ancestor chain for `g3`.
- The final target digest must be recalculated after the last `bin/lib.sh`
  change and frozen with its focused test.
- The current focused gate proves identity selection, fail-closed source
  mutation handling, predecessor classification, whole-tree publication and
  durable-phase reachability. Target-Ubuntu crash/reboot and systemd evidence
  remain acceptance gates owned by the server deployment task.
