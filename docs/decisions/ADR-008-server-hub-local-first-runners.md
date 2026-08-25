# ADR-008: Server Hub with Local-first Runners

Status: accepted

Supersedes the single-machine scope in
[ADR-007](ADR-007-implementation-stack.md). Its language, desktop shell, event
store and model decisions remain accepted.

## Context

The chat spike measured two different channels:

```
wake          Agent OS ──▶ adapter ──▶ vendor CLI
participate   agent ──MCP──▶ Agent OS
```

The adapter and project working copy need the tools, credentials and files of
the machine doing the work. Putting them on the Hub would make the server a
vendor-login host, a code host and an execution host at once.

Remote transport also adds failure modes that do not define agent invocation:
authentication, reconnect, latency and partial delivery. Building it first
would mix transport bugs with contract bugs.

## Decision

Agent OS has a server control plane and runner execution planes.

```
human / agent ──authenticated call──▶ Server Hub
                                         │
                              dispatch over an established
                              outbound Runner connection
                                         │
                                         ▼
Runner ──▶ adapter ──▶ vendor CLI ──▶ project working copy
```

The **Server Hub** owns the event log, project and task metadata, authorization,
routing and logical session placement. It dispatches work only. It never starts
a vendor CLI, stores a vendor login or opens a project working copy.

A **Runner** owns adapters, vendor sessions and project working copies. Every
Runner initiates its connection to the Hub; workstations expose no inbound
port. The Hub may send work over that established bidirectional connection.

Local and Remote Runners implement one contract:

- strict dispatch requires `requestId, user, project, agent, adapter, workspace,
  prompt`; `taskId, causedBy, model` are optional;
- the adapter result remains `requestId, text, sessionId, ms, fresh`;
- the normalized event stream is `started / delta / thought / progress / usage /
  completed / failed`, ordered per request;
- errors are `requestId, code, message, retryable` with a stable code vocabulary;
- validation, cancellation, retry, error and liveness semantics do not change
  with transport;
- a Local Runner uses an in-process or same-host transport; a Remote Runner
  serializes the same request and stream over its outbound connection.

Implementation order is fixed:

```
restore gates + auth
        ↓
Local Runner end-to-end
        ↓
freeze and test the shared contract
        ↓
Remote Runner transport
        ↓
formal Event Core packages
```

Remote development starts only after the same real CLI task completes through
the Local Runner contract. The remote acceptance test runs that task unchanged
and compares its normalized event sequence.

### Identity and authorization

Every data, control, event-stream and MCP call is authenticated. A public inert
bootstrap shell may collect a human token into browser memory, but has no data
or capability itself. A credential maps server-side to a principal; caller
identity in a request body is never trusted. Human, agent and Runner principals
have separate route permissions. Vendor credentials stay on the Runner and are
never sent to the Hub.

Logical vendor-session ownership is `(user, project, agent)`. The Hub persists
which host owns that logical session. That Runner persists the opaque vendor
session id, adapter and canonical workspace under the same key. Resume is
allowed only when host, adapter and workspace still match. Moving work to a
different host starts fresh and rebuilds context from the event log; that
changes cost, not correctness.

Routing capability belongs to `(agent, host)`, not the agent alone. A host
registration reports its OS, hardware and installed tools / MCP servers. The
same agent may therefore match a task on one host and not another. Routing still
reads capabilities, never `provider`.

### Project files

The Hub stores project metadata and events. Working files live on Runners. A
project maps a host to its local working-copy path; the shared state between
hosts is the Git remote, not a network-mounted filesystem.

## Alternatives

**Hub starts vendor CLIs.** Rejected: the Hub would need every vendor login and
direct access to every project file. One server compromise would become an
execution compromise on all projects.

**Remote Runner first.** Rejected: invocation semantics and network behavior
would change together. A Local Runner gives the shared contract a deterministic
baseline.

**Inbound Runner API.** Rejected: every workstation would need a reachable port,
firewall configuration and a larger attack surface.

**Network-mounted project directory.** Rejected: filesystem semantics, offline
work and credentials would leak across hosts. Git already supplies the explicit
cross-host synchronization boundary.

**Capability stored on the agent.** Rejected: tools and hardware belong to a
host. It would route work to an agent instance that cannot execute it.

## Consequences

- The Hub is reachable from multiple devices without becoming a code-execution
  host.
- SQLite remains the initial Hub event store because the Hub is the single
  writer. Multiple active Hub writers require another ADR.
- Runner reconnect, backpressure and credential rotation are required before a
  Remote Runner is production-ready.
- A host that is offline is not routable, even if its agent identity is known.
- Git synchronization and conflicts are explicit operational concerns.
- Logical placement and Runner-owned vendor handles survive process restarts,
  but correctness never depends on a resumable vendor session.
- Hub boot reconciles durable `assigned` and `running` tasks after the listener
  is ready. A running task reuses its stored `task.started` id as the Runner
  `requestId`; it does not append a second lifecycle event. See
  [ADR-042](ADR-042-interrupted-runner-dispatch-recovery.md).
- A Runner resolves canonical workspace paths under a configured root and
  rejects both `..` and symbolic-link escapes before starting an adapter.
- Local and Remote paths must pass the same contract suite; transport-specific
  tests are additive.
