# Server Runtime Deployment Runbook

Status: staging contract. This does not make the current chat spike
production-ready.

This is the single operational source for the Server Hub and outbound Remote
Worker. Protocol and ownership semantics remain canonical in
[ADR-008](../docs/decisions/ADR-008-server-hub-local-first-runners.md).

## Invariants

- The Hub dispatches only. It has no vendor login, working copy or vendor
  subprocess.
- The Worker initiates every connection. It exposes no inbound Agent OS port.
- The Hub listens on loopback. Only an HTTPS reverse proxy is public.
- Cross-host Worker traffic uses a trusted HTTPS origin. Public HTTP, disabled
  certificate verification and IP/SAN mismatch exceptions are forbidden.
- Human, Runner and per-Agent bearer values are distinct, 32–4096 characters
  from `[A-Za-z0-9_-]` and loaded only from restricted configuration.
- The Hub and each Worker are single writers for their own state roots.
- Logs, command output and evidence must expose only fixed diagnostics plus
  hashes, counts, stages and exit status; they must never expose bearer values,
  file bodies or raw vendor stderr. State artifacts are high-sensitive root-only
  data: the snapshot helpers copy every allowed regular state file without
  content scanning and can copy a misplaced secret.

```text
human / agent
      |
      | HTTPS :443
      v
reverse proxy ----> 127.0.0.1:4173 ----> Server Hub
                                                ^
                                                |
                                      authenticated outbound HTTPS
                                                |
                                         Windows Worker
                                                |
                                      vendor CLI + working copies
```

## Read-only field baseline

Inventory date: 2026-08-24. Host identifiers, addresses, certificate names and
credentials are deliberately omitted.

| Role | Baseline | Deployment consequence |
| --- | --- | --- |
| Ubuntu Hub host | Ubuntu 22.04.5 LTS, x86_64, systemd 249, ext4, about 41 GiB free; Node 24.19.0, Corepack 0.35.0 and pnpm 11.17.0 | Node was installed in a root-owned versioned directory and exposed at `/usr/bin/node` only after the upstream clearsigned checksum manifest and pinned release key were verified; `node-v24.19.0-linux-x64.tar.xz` SHA-256 is `14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647`; no Hub service or proxy was started |
| HTTPS edge | Nginx 1.18 is active on existing ports 80/443; Certbot renewal is active | use an independent virtual host; never replace existing sites |
| TLS / DNS | A valid certificate estate exists, but no dedicated Agent OS name is approved; strict HTTPS to the host address fails SAN validation | a dedicated FQDN and matching trusted certificate are a field dependency |
| Windows Worker host | Windows 11 Home build 26200, x64, NTFS, about 311 GiB total / 200 GiB free | use native Task Scheduler and explicit NTFS ACLs; do not rely on POSIX modes |
| Windows runtime | PowerShell 5.1, Node 24.19.0, Corepack 0.35.0; pnpm absent | activate the repository-pinned pnpm through Corepack before install |
| Vendor CLI | Grok 1.0.5 resolves to a concrete `grok.exe`; cached authentication material exists | cached material is not proof of a valid online login; SVR-04 must perform a scoped live check |
| Remote administration | OpenSSH 9.5p2; `sshd` is Automatic but its service is stopped while a separate process currently listens | repair and verify service-owned SSH startup before reboot testing |
| Windows control plane | Task Scheduler is running; `schtasks.exe`, `sc.exe`, `icacls.exe` and `taskkill.exe` exist; the current operator is an administrator | installation is possible, but the Worker must run as a fixed non-administrator account |

The host firewall state does not prove the cloud security-group state. The Hub
must not add a public listener or a new public port.

## Ports and proxy contract

| Flow | Bind / destination | Rule |
| --- | --- | --- |
| Public Hub | reverse proxy `:443` | TLS only; dedicated FQDN and valid chain |
| Hub process | `127.0.0.1:4173` | never bind `0.0.0.0`; never expose in a security group |
| isolated Hub candidate | `127.0.0.1:14173` | clean candidate state only; never referenced by the proxy |
| Worker transport | outbound public Hub `:443` | no inbound Worker port |
| SSH administration | existing host policy | operational access only; unrelated to Runner transport |

The proxy preserves `Authorization`, rejects invalid Host/Origin combinations
and rejects every query string. Access logging is disabled for this virtual
host; the error log is `crit` only. Response buffering is disabled for
`/events` and Runner long polls. Proxy read timeouts exceed the poll window.
Both health routes are loopback-only: their exact public locations return
`404`. The scoped connection/request zones in
`agent-os-hub-limits.conf.example` affect no other virtual host.

## Identities and directories

### Ubuntu Hub

| Purpose | Contract |
| --- | --- |
| service account | `agent-os`, system account, no login shell, numeric UID/GID both non-zero |
| candidate account | `agent-os-candidate`, distinct locked system account and distinct numeric UID/GID; isolates `/proc/*/environ` from the live Hub UID |
| privileged admin kit | `/usr/libexec/agent-os/hub`; immutable, root-owned, delivered separately from app releases |
| releases | `/opt/agent-os/releases/<revision>`; immutable and root-owned |
| active release | `/opt/agent-os/current`; switched atomically while stopped |
| prior release | `/opt/agent-os/previous`; changed only after a signed-off activation |
| failed releases | `/opt/agent-os/quarantine`; never the default rollback target |
| secret configuration | `/etc/agent-os/hub.env`; root-owned, `0600` |
| state root | `/var/lib/agent-os/hub`; `agent-os`-owned, `0700` |
| candidate state | `/var/lib/agent-os/hub-candidates/<revision>`; isolated from live state |
| event log | `/var/lib/agent-os/hub/events.jsonl` |
| placement | `/var/lib/agent-os/hub/remote-placement.json` |
| request replay | `/var/lib/agent-os/hub/remote-placement.json.requests/` |
| state artifacts | `/var/backups/agent-os/hub`; root-owned `0700`, published artifact directories `0500`, files `0400` |
| recovery journal | `/var/lib/agent-os-ops/private`; root-owned `0700`, transaction directories `0700`, entries `0400` |
| persistent recovery block | `/var/lib/agent-os-ops/hub-block`; root-owned single-link regular file, `0444` |
| logs | systemd journal; persistent journal policy belongs to the host |
| deployment lock | `/run/agent-os/hub-deploy.lock`; root-owned global `flock` |
| maintenance | `/run/agent-os/hub-maintenance`; blocks human, Agent and Runner ingress during promotion |
| hard maintenance | `/run/agent-os/hub-maintenance-hard`; blocks every proxied namespace after incomplete recovery |

The units set `UMask=0077`, empty capability sets, bounded memory/tasks/files,
`LimitCORE=0` and a CPU quota. The release and configuration trees are
read-only. The candidate runs under the distinct `agent-os-candidate` UID with
`ProtectProc=invisible`, cannot read live state or `/etc/agent-os/hub.env`,
receives a root-only generated env with one-time candidate bearer values rather
than production Runner/Human/Agent credentials, and can write only its clean
candidate root. Both deployment accounts must be locked, non-login and have no
supplementary groups under the same identity gate. Each numeric UID must map to
exactly one passwd entry; UID/GID zero, a duplicate passwd UID or a shared live
and candidate UID/GID fails closed before layout publication.

### Windows Worker

| Purpose | Contract |
| --- | --- |
| service identity | fixed local `<worker-account>`, non-administrator, owns the Grok login |
| background manager | Task Scheduler, startup trigger, run whether logged on or not |
| releases | `C:\ProgramData\AgentOS\releases\worker-admin-<sha256>` plus protected application releases; immutable after verification |
| active release | Scheduled Task action; changed only while the task is stopped |
| secret configuration | `C:\ProgramData\AgentOS\config\worker.json`; Worker read-only, `SYSTEM` and Administrators full control |
| state root | `C:\ProgramData\AgentOS\state` |
| workspace root | `C:\ProgramData\AgentOS\workspaces` |
| vendor session state | `C:\ProgramData\AgentOS\state\runner-sessions.json` |
| request replay | `C:\ProgramData\AgentOS\state\runner-sessions.json.requests.json` |
| credential mount root | `C:\ProgramData\AgentOS\state\credentials`; never the mutable working copy |
| logs | `C:\ProgramData\AgentOS\logs`, rotated and ACL-restricted |

Protect `config`, `state`, `credentials` and `logs` from inherited `Users`
access. State, credential, workspace, log and run directories grant the Worker,
`SYSTEM` and local Administrators full control. The configuration directory and
file grant the Worker read/execute only. Installation and health checks verify
the exact protected DACL and owner; `mode: 0600` and `chmod` are not Windows
evidence.

Windows PowerShell 5.1 is only the offline bootstrap entry. It admits one pinned
PowerShell 7.4 MSI after SHA-256, Authenticode signer-thumbprint, single-link,
ancestry and private-stage checks. All lifecycle scripts require 7.4. Installation
preflights account, Task, source-tree and secret hashes before the first root
write, then advances an admin-only `intent → layout → release → config → task →
committed` journal. Admin upgrades use a target-hash journal and adopt only the
same or next phase after a crash; other unfinished upgrades fail closed.

The Worker host creates Node suspended, assigns it to a kill-on-close Job Object,
then resumes it. Session and request stores publish one same-directory candidate
through `ReplaceFileW`, or `MoveFileExW` with write-through for first creation,
before updating memory. These are code and fault-injection contracts. Effective
ACL, Task Scheduler, Job Object and NTFS kill/reboot evidence remain field gates.

## Configuration contract

All state paths are absolute. Example files contain placeholders only and stay
out of deployed secret directories.

### Hub

| Variable | Value / rule |
| --- | --- |
| `HOST` | exactly `127.0.0.1` |
| `PORT` | exactly `4173` for the audited unit and proxy sample |
| `LOG_PATH` | event-log path under the Hub state root |
| `AGENT_OS_REMOTE_STATE_PATH` | placement path under the Hub state root |
| `AGENT_OS_RUNNER_MODE` | `remote` |
| `AGENT_OS_RUNNER_ID` | stable host identity, equal on Hub and Worker |
| `AGENT_OS_RUNNER_TOKEN` | dedicated Runner secret; 32–4096 base64url characters |
| `AGENT_OS_HUMAN_TOKEN` | dedicated human secret; 32–4096 base64url characters |
| `AGENT_OS_AGENT_TOKENS` | single-quoted canonical compact JSON map of unique base64url per-Agent secrets |
| `AGENT_OS_ALLOWED_ORIGINS` | exact public `https://<fqdn>` origin |
| `HOP_BUDGET` | finite positive integer; default `6` |

Remote mode fails closed when its ID or credentials are absent. It must also
fail before listening when paths, port, origin or token separation are invalid.
The token map is one outer single-quoted value in the systemd environment file:
systemd removes those outer quotes and preserves the JSON double quotes. Naked
JSON is rejected because `EnvironmentFile` parsing would interpret its inner
quotes before injecting the value.

### Worker

| Variable | Value / rule |
| --- | --- |
| `AGENT_OS_URL` | exact public HTTPS origin; no credential, query or fragment |
| `AGENT_OS_RUNNER_ID` | same stable host identity as the Hub |
| `AGENT_OS_RUNNER_TOKEN` | same dedicated Runner secret as the Hub |
| `AGENT_OS_AGENT_TOKENS` | same explicit scoped Agent map as the Hub |
| `AGENT_CWD` | workspace root above |
| `SESSION_PATH` | vendor session path above |

The Worker removes Agent OS control-plane variables before vendor execution.
SVR-04 must narrow all remaining child environment variables to an allowlist,
resolve trusted CLI paths at startup and prove each child sees only its current
scoped Agent credential.

## State and durability boundary

| Owner | Durable state | Restore invariant |
| --- | --- | --- |
| Hub | event JSONL, placement snapshot, terminal request ledger | restore the set together; preserve request replay and placement |
| Worker | vendor session snapshot, LocalRunner request ledger | restore together on the same host identity and workspace root |
| Worker | working copies | Git remote is the cross-host boundary; never copy them to the Hub |

The staging EventLog now treats invalid UTF-8, a partial final frame, blank or
surrounding-whitespace frames, malformed JSON, invalid event shape, sequence
gaps, duplicate ids, mixed projects and invalid causal references as fatal. It
never skips a malformed frame. Every append is fenced by `.write-intent` and
`.write-committed` marker states around the frame and directory fsyncs. Either
unresolved marker blocks restart because it cannot establish whether the caller
observed success. Stop the Hub and preserve the raw state for offline
adjudication; never delete a marker or treat `.write-committed` as implicit
success.

The marker protocol still cannot atomically bind durable cleanup to the caller
observing the return. A crash after marker removal is durable but before the
return is observed can make a retry duplicate the semantic operation. The
staging JSONL path has no operation-level idempotency key; this acknowledgement
window remains blocked on RM-1.1b and must not be described as exactly-once.

This strictness does not give the JSONL and JSON files a shared transaction or
make the spike production-durable. Production durability remains RM-1.1b.

The fixed admin kit implements the staging stopped-state contract in
[ADR-040](../docs/decisions/ADR-040-staging-state-snapshot-and-recovery.md).
A strict artifact copies the three Hub filesets together, replays them offline,
pins a canonical manifest/tree digest and is published only after file and
directory fsync. Artifact directories are root-owned `0500`; contained data and
control files are `0400`. Creation rejects links, special files, unknown
temporary files, unstable traversal, active tasks and unresolved EventLog write
markers. It never overwrites an artifact or the only state tree.

Snapshot and materialization publication uses a target-scoped, owner-bound
lease. The atomic lock link binds a private owner record containing PID and
Linux `/proc` starttime. A live or uninspectable owner fails closed; only an
explicitly absent PID or a different starttime may be reclaimed. SIGKILL leaves
an auditable stale lease that the next invocation validates and reclaims. A
symlink, extra hardlink, wrong owner/mode or malformed record is never repaired
automatically.

The helper is not content-aware: it copies every allowed regular file below the
state root. Treat strict snapshots, raw forensic artifacts and recovery records
as high-sensitive even when a secret does not belong there. Logs and acceptance
evidence may contain only hashes, counts, stages and exit status; never print a
secret canary or artifact content.

Run only the fixed administrative entry points; each acquires the global deploy
lock. Capture the exact snapshot id and manifest digest emitted by backup:

```bash
sudo /usr/libexec/agent-os/hub/bin/state-admin.sh capacity
sudo /usr/libexec/agent-os/hub/bin/state-admin.sh backup --label <safe-label>

sudo /usr/libexec/agent-os/hub/bin/state-admin.sh restore \
  --snapshot <snapshot-id> \
  --manifest-sha256 <exact-manifest-sha256>

sudo /usr/libexec/agent-os/hub/bin/state-admin.sh recover-old \
  --transaction <restore-transaction-id>
```

`capacity` is read-only. `backup`, `restore` and `recover-old` are the only
state-mutating or crash-continuation paths.

`restore --from-transaction <exact-parent>` is permitted only to bind a new,
signed restore to the transaction named by an existing durable block. It is not
a generic bypass. There is no supported direct state repoint, journal edit,
marker deletion or unbound service start.

If a failed upgrade or rollback leaves `/run/agent-os/hub-recovery-start`, do
not delete it. First verify that it is the private `0400`, single-link regular
token whose body exactly matches the transaction in `hub-block`. After repairing
the cause of the failed start, retry the Hub start under that same transaction;
the audited `ExecStartPre` consumes the token. Prove the Hub live, then stop and
disable it again while retaining the parent block. Only then run the signed
`restore --from-transaction <exact-parent>` path. A mismatched token or block is
a hard refusal and requires preserving both artifacts for audit.

A restore durably records `intent` before writer stop or pointer change. The
intent pins its parent, target snapshot, manifest digest and canonical tree.
After stop proof it preserves the current tree, records pinned `metadata`, then
chains the parent block to this restore. Private intent, metadata and phase
temporaries are renamed and their parent directory synced at every transition:

```text
prepared → staged → old_moved → new_activated → verified → committed
```

A strict precommit compensation ends in `rolled_back`. Only an orphan intent
from a clean standalone `recovery-pre-*` parent may be proved replayable and
ended in `aborted`; an explicit parent failure requires a new restore bound to
that parent. `committed`, `rolled_back` and `aborted` are terminal. Recovery
verifies the terminal tree, starts through an exact transaction-bound one-time
token, checks liveness and enablement, then only finalizes cleanup. A committed
restore is never compensated backward.

When the old tree fails an eligible semantic check, restore first creates a raw
`forensic-v1` preservation artifact. It can only be verified, never
materialized. Recovery is forward-only toward the pinned strict target; after
`old_moved`, the same journal must continue forward and must never reactivate
the corrupt tree. The forensic artifact remains immutable evidence.

The durable block is removed last. Volatile maintenance sentinels are removed
and the runtime directory is synced while the block remains; the block removal
and operations-directory fsync form the terminal cleanup boundary. Any earlier
crash or failed sync leaves or republishes the exact block and the Hub remains
closed.

`events.jsonl` is authoritative. Never logrotate it, segment it,
`copytruncate` it or prune it. Only journald and Nginx logs rotate. An already
verified artifact may be removed only by a separately approved, explicit
retention operation; deletion is never automatic. Same-disk artifacts remain
staging rollback aids, not off-host disaster recovery.

Do not upgrade during an in-flight task until restart reconciliation has a
defined Task Engine policy. Current Hub restart tests prove transport replay
only; they do not prove that a projected `running` task is reassigned or
failed.

## Health and lifecycle

The Hub exposes two non-mutating probes only to a direct loopback client. The
Nginx sample exact-matches both paths and returns `404` instead of proxying them:

| Probe | Success | Failure |
| --- | --- | --- |
| `GET /health/live` | exact `200 {"status":"ok"}` | non-exact status/body or wrong process fails |
| `GET /health/ready` | exact `200 {"status":"ready"}` after an authenticated Worker is healthy | exact `503 {"status":"not_ready"}` while no Worker is available |

`live` means the configured systemd unit is active, has a non-zero `MainPID`,
owns the exact loopback listener and returns the exact JSON body. It does not
mean the Hub can dispatch. Initial install and clean candidate preflight gate on
`live`; otherwise the absence of the first Worker creates a bootstrapping
deadlock. `ready` is a separate post-start operations gate.

Installation validates the env and safely extracts the complete immutable
release before publishing the env, production/candidate units, two disabled
Nginx examples, env example or pointers. Every publication, daemon-reload,
start, live-gate and enable boundary removes its partial commit on failure;
retrying the same revision is safe only when its stored artifact hash matches.
A failure before start/enable does not invoke stop/disable and cannot create a
spurious hard-maintenance state merely because an absent unit rejects those
operations. Stop rejects new public traffic first, then drains/cancels Runner
work, closes HTTP connections and exits within a fixed deadline. A timed-out
stop fails visibly.

Upgrade first boots a clean-state candidate on `14173` with one-time bearer
values. This proves only that the app can start; it does not validate live
JSONL replay or a migration. The promotion state machine then enables
maintenance for every proxied namespace, stops the service, obtains the
observable-reference proof defined below, double-hashes state, runs the
snapshot hook, verifies the source hash again,
switches code and gates on exact liveness. Only a fully signed-off activation
updates `previous`, removes maintenance and lets the outbound Worker reconnect.

On any commit-phase failure, the live unit is stopped before compensation. If
the stopped state hash is unchanged, a release newly added to the active pool
by that operation is quarantined, both pointers are restored exactly, and old
code must pass start, liveness and enable gates before maintenance is removed.
An already signed-off release (including the recorded `previous`) is retained
in place after a failed re-activation rather than misclassified as a new bad
candidate. If state changed, hashing failed or commit recovery cannot be signed
off, the live service is stopped and disabled and hard maintenance remains.

A candidate-stop failure occurs before promotion or live-state access. In that
case the previously signed-off live Hub stays running and enabled, while normal
plus hard maintenance block new public ingress; the candidate unit, one-time
env, state and release are retained for explicit process cleanup. No new deploy
operation may clear either fail-closed state. This is a release-lifecycle
failure, not an invitation to use the state restore tool. A fsynced release
transaction journal and explicit release recovery command remain blockers;
manual sentinel deletion without proving the candidate inactive or restoring
changed state is forbidden.

### Hub staging commands

There are two trust domains:

1. The administrator kit is delivered independently into a root-owned,
   non-group/world-writable directory. `bootstrap-admin.sh` installs it once at
   `/usr/libexec/agent-os/hub`. An app artifact can neither supply nor update
   these privileged helpers, units or proxy templates.
2. The application artifact contains only an allowlisted root manifest and
   `apps/chat-spike`. The audited extractor rejects traversal, links, special
   files, extended headers, duplicate files and expansion limits. No `deploy/`
   member is valid.

Run the packager without root from the repository source root shown below. The
script canonicalizes `--source` even when a caller starts it from another
working directory; it never uses the caller's cwd as package-manager context.
The production toolchain is fixed to `/usr/bin/node` 24.19.0 and
`/usr/bin/corepack` 0.35.0, the same Node entry used by both audited systemd
units. Production rejects alternate executable overrides. Both fixed entries
must resolve to executable regular files that are root-owned, are not
group/world writable, and have only root-owned non-writable ancestors. Corepack
is invoked through the fixed Node entry, so caller cwd and PATH cannot shadow
either executable. The repository declaration and the resolved Corepack pnpm
runtime must both be exactly `pnpm@11.17.0`, otherwise the diagnostic identifies
the expected source root and the build fails closed. A cold-host
production-closure smoke
requires direct access to the pinned public npm registry; registry or DNS
failure fails the smoke and never relaxes the version or frozen-lockfile gate.
The packager rejects inherited Node/Corepack injection variables and runs
Corepack/pnpm under `env -i` with a safe PATH, built-in integrity keys, fixed
registry, `/dev/null` npm configs and fresh private Corepack/XDG/pnpm caches.
It therefore never reuses a caller's pnpm executable or package store. The
packager then creates a minimal temporary workspace and performs a
production-only frozen-lockfile install with the hoisted linker, copy import
mode and lifecycle scripts disabled. It removes pnpm workspace metadata and
`.bin`, rejects every remaining link/special file, then proves the real
`@modelcontextprotocol/sdk/server` package export and its `zod` transitive
dependency import from the final app location. Root install never executes that
application code; it performs structural verification only. Before root
install, move the archive and checksum into a restricted staging directory and
make each a single-link, root-owned regular file that is not group/world
writable. The root installer rejects any other input.

```bash
SOURCE_ROOT=/absolute/path/to/agent-os-source
cd "$SOURCE_ROOT"
/usr/bin/env -i \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$SOURCE_ROOT/deploy/hub/bin/package-release.sh" \
    --source "$SOURCE_ROOT" \
    --output /secure/staging/agent-os-<revision>.tar.gz

# From a separately delivered, root-owned admin-kit source:
sudo /root/agent-os-admin-kit/bootstrap-admin.sh

sudo /usr/libexec/agent-os/hub/bin/install.sh \
  --archive /secure/staging/agent-os-<revision>.tar.gz \
  --sha256 <trusted-sha256> \
  --revision <revision> \
  --env-file /secure/staging/hub.env

sudo /usr/libexec/agent-os/hub/bin/health-check.sh --live
sudo /usr/libexec/agent-os/hub/bin/health-check.sh --ready
```

The bootstrap must be invoked by its canonical absolute path from a root-owned,
non-group/world-writable, symlink-free directory chain. Its self-contained
preflight verifies that path plus `bin/lib.sh` before sourcing library code; it
then verifies the complete admin source and never overwrites an installed kit.
The public install, upgrade, rollback and validator entries likewise reject any
path outside the fixed admin kit before executing the shared entry guard or
`lib.sh`. The guard validates the test marker or production directory chain and
the immediate shell/Node execution closure. Privileged Node helpers reject
inherited Node, TLS and OpenSSL configuration/module/engine variables before Node
starts; system tool overrides exist only inside a validated non-root test root.
Ownership and a supplied SHA-256 prove local integrity only; they do not
authenticate the publisher. Signed admin-kit and
application release manifests plus an audited publisher-key policy are still a
production blocker. Admin-kit upgrade is a separate packaging/change-control
workflow governed by
[ADR-041](../docs/decisions/ADR-041-privileged-admin-kit-migration.md). The only
supported migration from the allowlisted legacy staging kit is:

```bash
sudo /root/agent-os-admin-kit/bootstrap-admin.sh \
  --migrate-installed \
  --expected-current-sha256 <allowlisted-legacy-tree-sha256>

# Only to continue or finalize the selected failed attempt as rollback:
sudo /root/agent-os-admin-kit/bootstrap-admin.sh \
  --migrate-installed \
  --expected-current-sha256 <allowlisted-legacy-tree-sha256> \
  --rollback
```

Do not use cold bootstrap, copy individual files or delete a migration journal
to recover an installed kit. Preserve the persistent block and journal, inspect
only hashes, phases and service state, then rerun the matching forward or
rollback command. A committed attempt can only finish forward; a rolled-back
attempt can only finish rollback. A new attempt is allowed only after the prior
rolled-back journal and forensic evidence pass exact validation.

`install.sh` creates or validates locked non-login service identities
with no supplementary groups. It leaves both Nginx files as disabled
`.example` files. Enabling them still depends on the approved FQDN, matching
certificate, `nginx -t` and a real query/log leakage check.

Lock acquisition may create or validate only `/run/agent-os` and its root-only
single-link lock file before checking the normal/hard maintenance sentinels.
No configuration, release, pointer, unit, proxy or state-layout mutation occurs
until that serialized fail-closed check succeeds.

The audited staging upgrade path accepts only the fixed snapshot hook
`/usr/libexec/agent-os/hub/pre-upgrade-snapshot`; a CLI override exists only in
the isolated non-root test-root harness. The hook and every ancestor must be
canonical, root-owned and non-writable, and the executable must be a
single-link regular file. Upgrade copies it with no-follow checks to a private
root-owned `0400`, single-link runtime file and revalidates the copy. Because
the standard `/run` mount may be `noexec`, the copy is never executed directly;
the fixed `/bin/bash -p` interpreter reads it as
`bash -p HOOK <state-root> <new-snapshot-directory>` after systemd has stopped and
passed the stopped-service observable-reference gate. A non-zero exit, empty destination or
source-state hash change enters compensation. The fixed hook implements the
ADR-040 strict stopped-state snapshot contract. It does not make the release
pointer transition SIGKILL-recoverable.

The single allowlisted legacy application server (`server.mjs` SHA-256
`9aa52cb59c508239316baf1fbc4eca083cbce578624bc891a2dfd4d121df1df5`)
predates `/health/quiescent`. Upgrade may treat only that exact root-owned,
`0444`, single-link server as requiring offline quiescence: it publishes the
normal and durable guards, stops and proves the writer absent, then performs
the canonical offline active-task/replay measurement. Any other missing or
failed quiescent probe rejects before promotion. This exception is not a
general health bypass.

The observable-reference gate is deliberately narrower than a proof of all
future write capability. On the supported local, persistent, single-mount
`ext4` state tree it scans two stable `/proc` windows for every visible task:
writable/deleted/O_TMPFILE descriptors and mount aliases, live state-inode
`MAP_SHARED` mappings with `VM_MAYWRITE`, exact state or immediate-parent
cwd/root/dirfd references, the dedicated service UID and the forbidden service
cgroup. A leaderless process whose task view is unavailable fails closed.
Nested, stacked, overlay, network, FUSE, tmpfs and read-only state mounts are
rejected.

This gate does not inspect queued `SCM_RIGHTS` descriptors, io_uring registered
files, `pidfd_getfd`, capabilities derived from a higher ancestor directory, a
remote filesystem writer or a later trusted-root reopen. Safety therefore also
depends on the dedicated UID/cgroup, the `0700` state boundary and trusted root.
On the Ubuntu 22.04 staging host, the fixed helper completed 20/20 idle scans
and 20/20 scans under controlled short-process churn. Those runs also exercised
the supported absent-cgroup result after systemd had no unit cgroup. A separate
private mount-namespace probe opened a real ext4 `O_TMPFILE` through a bind
alias; the descriptor appeared as a deleted alias path with a mount id absent
from the inspector namespace, and the helper failed closed with
`aliasInspectionComplete:false`. No probe mount or process remained. Same-
namespace chroot, linkat publication and active-to-trimmed systemd cgroup
evidence remain required before field acceptance.

```bash
sudo /usr/libexec/agent-os/hub/bin/upgrade.sh \
  --archive /secure/staging/agent-os-<next-revision>.tar.gz \
  --sha256 <trusted-sha256> \
  --revision <next-revision>

sudo /usr/libexec/agent-os/hub/bin/rollback.sh
```

Neither command restores state. A hard-maintenance sentinel is an explicit stop
condition, not an invitation to rerun deploy. `deploy/hub/verify.sh` runs the
clean-Ubuntu non-root static/security/lifecycle gate with isolated roots and
fault-injected systemd, listener and HTTP probes. Its exact production
toolchain contract intentionally fails before tests on macOS or a generic CI
image; SVR-06 supplies the separate cross-platform static entry. Run this
executable directly under a minimal
environment so its `/bin/bash -p` interpreter, fixed system PATH and audited
absolute Node/Corepack paths apply before any gate setup. Running it through an
ambient `bash` is not an equivalent trust-chain check.

```bash
SOURCE_ROOT=/absolute/path/to/agent-os-source
cd "$SOURCE_ROOT"
/usr/bin/env -i \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  LANG=C.UTF-8 \
  "$SOURCE_ROOT/deploy/hub/verify.sh"
```

## Logging and capacity

- Emit machine-readable lifecycle and health fields, never configuration
  values, Authorization headers, prompt bodies or raw vendor stderr.
- Bound request bodies, prompt/event fields, event count and cumulative buffered
  bytes. A valid Runner credential is not a license for unbounded memory use.
- Use exponential reconnect backoff with jitter and a ceiling; fixed hot retry
  is not an operations policy.
- The Hub admits at most 64 SSE clients. An initial hello/replay larger than
  256 KiB returns `503`; any later `write(false)` disconnects that slow client.
  EventLog startup still reads and projects the complete JSONL history without
  pagination or streaming recovery, so these caps do not make storage
  production-safe.
- Rotate Windows logs and cap journald by host policy. Alert before state or log
  volumes exhaust free space.
- Backup, restore and smoke evidence records only commands, exit codes, hashes,
  counts and stages. Snapshot and forensic contents remain high-sensitive and
  are never copied into logs.

## Staging gates and blockers

| Item | State |
| --- | --- |
| Dedicated Agent OS FQDN and matching trusted certificate | field dependency; placeholder origin was rejected before publication, leaving no env/unit/current/listener; Hub activation and cross-host smoke remain blocked until supplied |
| Ubuntu exact Node version/SHA and repository-pinned Corepack/pnpm | field gate passed: pinned Linux x64 archive SHA and signature chain verified; the gate enforces `/usr/bin/node` 24.19.0, `/usr/bin/corepack` 0.35.0 and pnpm 11.17.0, and revalidates their root-owned non-writable paths before use |
| clean Linux production dependency closure | cold-cache field gate passes with pnpm 11.17.0, zero reused packages, final SDK/Zod imports, no links/special files and no admin tree; rerun after every frozen artifact change |
| authenticated release/admin-kit publisher and signature verification | not implemented; root ownership and checksums do not prove provenance |
| Hub health endpoints and health-check script | implemented; focused local gate passes |
| bounded body parsing, shutdown deadline and propagated close failure | implemented; focused local runtime gate passes |
| reconnect backoff, jitter and bounded Runner transport/body caches | implemented; focused runtime gate passes |
| SSE admission, replay-byte and slow-client bounds | implemented; EventLog full-history startup projection remains a staging blocker |
| systemd units, fixed admin kit, safe app extractor, proxy sample and lifecycle scripts | non-root fault matrix, real root-owned bootstrap and exact 17→25 installed migration pass; public proxy activation waits on the approved FQDN/certificate |
| Nginx query/log leakage and real upstream failure exercise | static policy passes; real enabled-vhost test waits on the dedicated FQDN/certificate |
| strict staging backup, snapshot verification and capacity preflight | target Ubuntu acceptance passed on 2026-08-25: a root-only strict snapshot was published with manifest SHA-256 `71392fe3…`, its separately copied and corrupted twin failed `snapshot_data_mismatch`, and the signed original remained unchanged |
| journaled restore, `recover-old` and raw forensic preservation | target Ubuntu signed restore passed on 2026-08-25 with state tree `bc079a58…`, service `active+enabled`, all runtime/persistent guards absent and a final observable-reference scan `ok:true`; forensic and crash matrices remain covered by the non-root fault gate |
| `events.jsonl` retention | rotation, segmentation, `copytruncate` and pruning are prohibited; no production segment protocol exists |
| state quota, retention and disaster recovery | peak-capacity admission exists; per-artifact quota enforcement, approved retention and encrypted off-host copies remain blocked |
| release upgrade/rollback transaction recovery | no fsynced release journal or explicit release recovery command; SIGKILL pointer recovery remains blocked |
| real Linux alias and mount proof | Ubuntu idle and controlled process-churn scans pass 20/20 each; an ext4 private-namespace bind-alias `O_TMPFILE` is rejected when its mount object is unavailable to the inspector; same-namespace chroot/linkat and active systemd-cgroup trim remain pending |
| production event-store durability | blocked on RM-1.1b; outside this workflow |
| EventLog caller-acknowledgement atomicity | marker phases fail closed before cleanup, but crash after durable marker removal and before caller observation remains ambiguous without RM-1.1b operation idempotency |
| Windows atomic replacement on repeated persistence | unified candidate/flush/ReplaceFile boundary and failure rollback pass locally; real NTFS kill/reboot/concurrent-read proof remains |
| Windows account-only ACL for state and bearer mounts | exact protected DACL setters/assertions implemented; effective-access proof remains |
| reparse-point/hardlink-safe credential mounting | fixed paths, single-link files, protected ancestors and workspace-external credential roots pass locally; real NTFS proof remains |
| Windows vendor process-tree cancellation and orphan check | suspended create → Job assign → resume implemented; real Grok cancellation/Task-stop proof remains |
| minimal child environment and trusted CLI discovery | allowlisted environment and fixed trusted executable ancestry pass locally |
| large Grok prompt transport beyond Windows argv limits | requires live stdin/argv measurement |
| raw stderr redaction and bounded capture | normalized bounded adapter errors pass locally; real vendor-output canary remains |
| real Hub/Worker restart task-state reconciliation | Task Engine policy absent; reproduce and report blocker |
| Remote Worker terminal-cache timing contract | hard peak plus ACK convergence contract passes; retain load-tolerant lease tests |
| Windows SSH service-owned startup | current listener is not owned by the stopped registered service |

Until these gates pass, the supported claim is **staging deployment and
controlled cross-host validation**, not production operation.
