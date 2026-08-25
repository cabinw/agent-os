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

The admitted Worker artifact is a reproducible single-file ESM bundle. Its
builder first proves the canonical 26-file source inventory still matches the
repository, then includes the locked third-party dependency graph. The runtime
manifest admits only `runner-worker.bundle.mjs`; an archive of bare sources is
rejected because Node module resolution would otherwise escape the exact-tree
release or fail at startup.

PowerShell 5.1 may only stage a pinned, signed PowerShell 7.4 installer. Install
and admin upgrade use admin-only phase journals, fixed candidates and exact
endpoint fingerprints. A retry adopts only an allowed phase transition. Admin
upgrade journals are target-hash scoped so a committed A → B transaction does
not block B → C.
An install stopped at `intent` may atomically rebind a replacement admin/config
digest only while Task, published config, releases root and every non-layout
entry are absent and Worker/runtime identity is unchanged. Later phases or
ambiguous topology remain bound to the original transaction and fail closed.
The Worker Task permits start while Windows reports battery power and does not
stop on a battery transition. Host power source is not a Worker lifecycle
signal; explicit lifecycle commands and Job Object teardown remain authoritative.
Install grants only `SeBatchLogonRight` to the dedicated Worker SID through the
local LSA policy API and every lifecycle assertion rechecks that right. Task
registration is not accepted as evidence that Windows granted the logon right.
Lifecycle process discovery matches the fixed PowerShell executable plus
the complete Task action argument suffix ending in `worker-host.ps1` and its
config, or the fixed Node executable plus `workerEntry`. Merely mentioning the
host or config path does not make a management command a Worker process.
Install pre-creates the Job assignment gate with the private admin-owned ACL.
The non-admin host reuses that fixed file and writes `pending`, `assigned`, then
`closed`; it never creates, deletes, takes ownership of, or re-ACLs the gate.
The suspended child cannot observe `assigned` before Job attachment succeeds.
Managed Node and adapter binaries grant the Worker only `ReadAndExecute`; each
managed parent below `ProgramData` grants only `Traverse`. Lifecycle assertions
recheck both while the existing trusted-owner and no-untrusted-write rules stay
in force. Program Files executables retain their platform ACLs.
Install also pre-creates a private `worker-host-status.json`. The host records
only fixed phase names, child exit code and exception HResult; it never records
arguments, paths, environment values or exception messages. This distinguishes
create/assign/resume failures without widening the secret or log boundary.

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
The host resolves the dedicated Worker's `USERPROFILE`, `HOME`, `APPDATA` and
`LOCALAPPDATA` from Windows special folders, validates their fixed containment
and passes only those profile paths to the sanitized Worker. Vendor CLIs can
find their own per-account login without copying credentials into ProgramData
or admitting the caller's ambient environment.
`AGENT_OS_ENABLED_ADAPTERS` may narrow a Worker to a non-empty unique subset of
the built-in adapters. Only that subset admits CLI paths, credentials and
workspace roots; unknown or duplicate ids fail closed. Omission retains the
all-adapter contract for existing deployments.

Session and request JSON stores write an exclusive same-directory candidate,
flush it, publish through `ReplaceFileW` or write-through `MoveFileExW`, and only
then replace in-memory state. Publication failure removes the candidate and does
not advance memory. Before the next publication, the single Worker process
removes matching single-link regular candidates left by a killed predecessor;
a reparse point, hard link or other unexpected candidate type fails closed for
operator review. Windows startup reads retry only `ENOENT` after 1, 4, 10 and
25 milliseconds. Other errors remain immediate failures, and exhausting the
bounded window retains the ordinary absent-store result.

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
- Release publication requires the deterministic Worker bundle gate; source-only
  runtime trees are not executable deployment artifacts.
- Candidate, journal and release topology is part of the recovery protocol and
  must not be deleted manually.
- Transient `ENOENT` is a measured `ReplaceFileW` observation, not permission to
  retry malformed JSON, ACL failures or unbounded I/O errors.
- Local compilation and fault injection do not complete acceptance. A real
  Windows host must still prove effective ACLs, Task lifecycle, Job containment,
  NTFS kill/reboot consistency and zero vendor-process or credential residue.
