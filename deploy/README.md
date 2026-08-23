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
- Logs, command output, evidence and backups contain no bearer, credential map,
  vendor authentication material or raw vendor stderr.

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
| releases | `C:\ProgramData\AgentOS\releases\<revision>`; immutable after verification |
| active release | Scheduled Task action; changed only while the task is stopped |
| secret configuration | `C:\ProgramData\AgentOS\config\worker.env` |
| state root | `C:\ProgramData\AgentOS\state` |
| workspace root | `C:\ProgramData\AgentOS\workspaces` |
| vendor session state | `C:\ProgramData\AgentOS\state\runner-sessions.json` |
| request replay | `C:\ProgramData\AgentOS\state\runner-sessions.json.requests.json` |
| credential mount root | `C:\ProgramData\AgentOS\state\credentials`; never the mutable working copy |
| logs | `C:\ProgramData\AgentOS\logs`, rotated and ACL-restricted |

Protect `config`, `state`, `credentials` and `logs` from inherited `Users`
access. Their DACL must grant only the Worker account, `SYSTEM` and local
Administrators. Installation and health checks must verify the effective ACL;
`mode: 0600` and `chmod` are not Windows evidence.

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

The current `EventLog` is a throwaway JSONL spike: it has no fsync transaction,
consistent online snapshot or formal corruption boundary. Filesystem backup is
for staging recovery drills only. Production durability depends on RM-1.1b and
must not be claimed by deployment scripts.

For every upgrade or recovery drill:

1. Stop the single writer; do not snapshot a live JSONL writer.
2. Copy state into a new timestamped snapshot. Keep the source and prior
   snapshot.
3. Validate structure and replay from the copy.
4. Restore into a new state directory, validate again, then repoint the stopped
   service.
5. Never overwrite the only copy. Release rollback does not imply state
   rollback.

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
maintenance for every proxied namespace, stops and proves the writer inactive,
double-hashes state, runs the snapshot hook, verifies the source hash again,
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
operation may clear either fail-closed state. An audited recovery command is an
SVR-03 blocker; manual sentinel deletion without proving the candidate inactive
or restoring changed state is forbidden.

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
workflow. `install.sh` creates or validates locked non-login service identities
with no supplementary groups. It leaves both Nginx files as disabled
`.example` files. Enabling them still depends on the approved FQDN, matching
certificate, `nginx -t` and a real query/log leakage check.

Lock acquisition may create or validate only `/run/agent-os` and its root-only
single-link lock file before checking the normal/hard maintenance sentinels.
No configuration, release, pointer, unit, proxy or state-layout mutation occurs
until that serialized fail-closed check succeeds.

Production upgrade accepts only the fixed snapshot hook
`/usr/libexec/agent-os/hub/pre-upgrade-snapshot`; a CLI override exists only in
the isolated non-root test-root harness. The hook and every ancestor must be
canonical, root-owned and non-writable, and the executable must be a
single-link regular file. Upgrade copies it with no-follow checks to a private
root-owned runtime file, revalidates that copy and executes only the copy as
`HOOK <state-root> <new-snapshot-directory>` after systemd has stopped and
proved the single writer inactive. A non-zero exit, empty destination or
source-state hash change enters compensation. SVR-03 supplies and audits the
fixed hook implementation.

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
- Backup, restore and smoke evidence records commands, exit codes and hashes,
  not file contents that may contain credentials.

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
| systemd units, fixed admin kit, safe app extractor, proxy sample and lifecycle scripts | non-root fault matrix and real root-owned admin bootstrap pass; service activation waits on the approved FQDN/certificate |
| Nginx query/log leakage and real upstream failure exercise | static policy passes; real enabled-vhost test waits on the dedicated FQDN/certificate |
| staging backup/restore and capacity/rotation scripts | not implemented |
| audited hard-maintenance state restore | blocked on SVR-03; deploy refuses to clear the sentinel |
| production event-store durability | blocked on RM-1.1b; outside this workflow |
| Windows atomic replacement on repeated persistence | requires real NTFS reproduction and fix |
| Windows account-only ACL for state and bearer mounts | requires implementation and effective-ACL proof |
| reparse-point/hardlink-safe credential mounting | not implemented |
| Windows vendor process-tree cancellation and orphan check | requires real Grok validation |
| minimal child environment and trusted CLI discovery | not implemented |
| large Grok prompt transport beyond Windows argv limits | requires live stdin/argv measurement |
| raw stderr redaction and bounded capture | not implemented |
| real Hub/Worker restart task-state reconciliation | Task Engine policy absent; reproduce and report blocker |
| Remote Worker terminal-cache timing contract | flaky baseline observed; define hard bound or eventual convergence without retry masking |
| Windows SSH service-owned startup | current listener is not owned by the stopped registered service |

Until these gates pass, the supported claim is **staging deployment and
controlled cross-host validation**, not production operation.
