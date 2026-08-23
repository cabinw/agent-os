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
- Human, Runner and per-Agent bearer values are distinct, at least 32
  non-whitespace characters and loaded only from restricted configuration.
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

Inventory date: 2026-08-23. Host identifiers, addresses, certificate names and
credentials are deliberately omitted.

| Role | Baseline | Deployment consequence |
| --- | --- | --- |
| Ubuntu Hub host | Ubuntu 22.04.5 LTS, x86_64, systemd 249, ext4, about 41 GiB free | systemd is available; Node, Corepack and pnpm are absent and must be installed from a pinned source |
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
| Worker transport | outbound public Hub `:443` | no inbound Worker port |
| SSH administration | existing host policy | operational access only; unrelated to Runner transport |

The proxy must preserve `Authorization`, reject invalid Host/Origin combinations
and never log bearer headers. Disable response buffering for `/events` and
long-poll Runner responses. Proxy read timeouts must exceed the Runner poll
window. Health routes, once implemented, remain loopback-only and are not
published by the virtual host.

## Identities and directories

### Ubuntu Hub

| Purpose | Contract |
| --- | --- |
| service account | `agent-os`, system account, no login shell, non-root |
| releases | `/opt/agent-os/releases/<revision>`; immutable and root-owned |
| active release | `/opt/agent-os/current`; switched atomically while stopped |
| secret configuration | `/etc/agent-os/hub.env`; root-owned, `0600` |
| state root | `/var/lib/agent-os/hub`; `agent-os`-owned, `0700` |
| event log | `/var/lib/agent-os/hub/events.jsonl` |
| placement | `/var/lib/agent-os/hub/remote-placement.json` |
| request replay | `/var/lib/agent-os/hub/remote-placement.json.requests/` |
| logs | systemd journal; persistent journal policy belongs to the host |

The unit must set `UMask=0077` and grant write access only to the state root.
The release and configuration trees are read-only to the service.

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
| `PORT` | `4173` unless an explicit loopback-only conflict exists |
| `LOG_PATH` | event-log path under the Hub state root |
| `AGENT_OS_REMOTE_STATE_PATH` | placement path under the Hub state root |
| `AGENT_OS_RUNNER_MODE` | `remote` |
| `AGENT_OS_RUNNER_ID` | stable host identity, equal on Hub and Worker |
| `AGENT_OS_RUNNER_TOKEN` | dedicated Runner secret |
| `AGENT_OS_HUMAN_TOKEN` | dedicated human secret |
| `AGENT_OS_AGENT_TOKENS` | explicit JSON map of unique per-Agent secrets |
| `AGENT_OS_ALLOWED_ORIGINS` | exact public `https://<fqdn>` origin |
| `HOP_BUDGET` | finite positive integer; default `6` |

Remote mode fails closed when its ID or credentials are absent. It must also
fail before listening when paths, port, origin or token separation are invalid.

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

Current code has no HTTP liveness/readiness endpoint. `GET /` proves only that
the inert bootstrap shell is reachable; it does not prove Worker readiness.
SVR-02 must add non-mutating, minimal loopback probes:

| Probe | Success | Failure |
| --- | --- | --- |
| liveness | Hub event loop and HTTP server respond | non-zero check; service restart may follow |
| readiness | configuration valid and authenticated Worker recently healthy | `503`; no task/message/event mutation |

Installation must validate configuration before activation. Stop must reject
new traffic first, then drain/cancel Runner work, close HTTP connections and
exit within a fixed deadline. A timed-out stop fails visibly; it does not report
success after swallowing `runner.close` errors.

Upgrade uses an immutable verified release, a pre-upgrade state snapshot and a
health-gated activation. Failure switches back to the previous release while
leaving state untouched. State recovery is a separate, explicit operation.

## Logging and capacity

- Emit machine-readable lifecycle and health fields, never configuration
  values, Authorization headers, prompt bodies or raw vendor stderr.
- Bound request bodies, prompt/event fields, event count and cumulative buffered
  bytes. A valid Runner credential is not a license for unbounded memory use.
- Use exponential reconnect backoff with jitter and a ceiling; fixed hot retry
  is not an operations policy.
- Rotate Windows logs and cap journald by host policy. Alert before state or log
  volumes exhaust free space.
- Backup, restore and smoke evidence records commands, exit codes and hashes,
  not file contents that may contain credentials.

## Staging gates and blockers

| Item | State |
| --- | --- |
| Dedicated Agent OS FQDN and matching trusted certificate | field dependency; cross-host smoke blocked until supplied |
| Ubuntu Node >=22 and repository-pinned Corepack/pnpm | not installed |
| Hub health endpoints and health-check script | not implemented |
| bounded body parsing, shutdown deadline and propagated close failure | not implemented |
| reconnect backoff and cumulative transport cache bounds | not implemented |
| systemd unit, proxy sample, install/upgrade/rollback scripts | not implemented |
| staging backup/restore and capacity/rotation scripts | not implemented |
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
