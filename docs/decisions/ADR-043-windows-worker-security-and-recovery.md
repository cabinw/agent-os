# ADR-043: Windows Worker Security and Recovery Boundary

Status: accepted for staging

## Context

The Remote Worker holds Runner and per-Agent bearers, launches vendor CLIs and
persists replay state on NTFS. POSIX modes, `renameSync`, `Process.Kill` and a
normal `Process.Start` do not prove Windows ACL, crash or process-tree safety.
A mutable workspace must not contain credentials or executable policy.

## Decision

Install the Worker under one fixed non-administrator local account. Administrator
code and application releases are versioned, Administrator-owned and read-only
to that account. `worker.json` is Worker-read-only; mutable state roots grant the
Worker, `SYSTEM` and local Administrators exact protected access. Every admitted
path rejects reparse ancestors and multi-link files where applicable.

The application runtime is a separate exact-tree transaction endpoint named
`worker-runtime-<sha256>`. Install accepts an explicit protected source and a
canonical relative-file manifest. It rejects NTFS aliases, ADS, case-insensitive
collisions, reparse points, hard links and every extra file or directory before
the first persistent write. The install journal binds the runtime digest;
admin-only per-file candidates are rehashed, ACL-frozen and moved as one
directory before configuration publication or Task registration. Configuration
must name the exact entry and working directory in that release. Lifecycle and
admin-upgrade validation remeasure the same exact tree.

PowerShell 5.1 may only stage a pinned, signed PowerShell 7.4 installer. Install
and admin upgrade use admin-only phase journals, fixed candidates and exact
endpoint fingerprints. A retry adopts only an allowed phase transition. Admin
upgrade journals are target-hash scoped so a committed A → B transaction does
not block B → C.

The supported machine contracts are deliberately narrow: `AMD64 host → AMD64
Worker`, or `ARM64 host + Windows AMD64 user-mode emulation → AMD64 Worker`.
The latter is the field path `support_arm64_host_amd64_worker`. Machine identity
comes from `IsWow64Process2`, and AMD64 emulation from
`GetMachineTypeAttributes`; environment architecture variables are not trust
inputs. The bootstrap reads the MSI SummaryInformation Template and requires an
AMD64 package. Before the administrator dot-sources the shared architecture
helper, it verifies the helper and source-root protected ACL, owner, ancestry,
single-link identity and an explicit SHA-256 pin. Before any install write and
before every lifecycle action, the
declared host/Worker pair must match the native machine, current PowerShell
process and descriptor-read PE machines of the pinned PowerShell, Node and Grok
executables. Unknown machines, ARM64 without explicit AMD64 emulation, a native
ARM64 Worker process, or any asset/declaration mismatch fail closed. Signer,
digest, ancestry, single-link, ACL and Job Object requirements remain unchanged.

The host creates Node with `CREATE_SUSPENDED`, assigns it to a kill-on-close Job
Object and only then resumes its primary thread. Vendor children inherit that
boundary. The child receives an allowlisted environment and fixed executable
paths; credentials mount outside the workspace.

Session and request JSON stores write an exclusive same-directory candidate,
flush it, publish through `ReplaceFileW` or write-through `MoveFileExW`, and only
then replace in-memory state. Publication failure removes the candidate and does
not advance memory.

## Alternatives

**Start Node and wait on an assignment gate.** Rejected: module imports execute
before the gate and can spawn outside the Job.

**Grant the Worker full control over configuration.** Rejected: a compromised
runtime could persist a new launch policy across restart.

**Use `renameSync` and POSIX mode bits.** Rejected: they do not establish the
required NTFS durability or DACL contract.

**Use one permanent upgrade journal.** Rejected: its committed endpoint blocks
the next version transition.

## Consequences

- Installation requires an elevated administrator token and a fixed local
  Worker identity; runtime execution remains non-administrator.
- ARM64 host support does not admit ARM64 runtime assets in this generation;
  PowerShell, Node and Grok remain pinned AMD64 artifacts under emulation.
- Configuration rotation and admin upgrades are privileged stopped-state
  operations.
- Application runtime replacement requires a separate digest-bound release
  transaction; an admin-only upgrade cannot silently change it.
- Candidate, journal and release topology is part of the recovery protocol and
  must not be deleted manually.
- Local compilation and fault injection do not complete acceptance. A real
  Windows host must still prove effective ACLs, Task lifecycle, Job containment,
  NTFS kill/reboot consistency and zero vendor-process or credential residue.
