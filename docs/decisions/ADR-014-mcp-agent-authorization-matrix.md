# ADR-014: MCP Agent Authorization Matrix

Status: accepted

## Context

Strict input validation does not prove an authenticated agent may perform the
requested operation. Registration `role` is agent-supplied display metadata;
using it for authorization would let an agent self-declare as supervisor. Task
ownership and execution are event-derived project facts.

The MCP package holds no state, so it needs a read-only seam without delegating
policy itself to the mutable Runtime Port.

## Decision

The router owns one fixed matrix:

| Tools | Additional requirement |
| --- | --- |
| `register_agent` | Body id equals principal; no prior registration |
| `find_agent`, `create_task`, `send_message`, `request_approval`, `get_context`, `write_memory`, `query_memory` | Same `(project, agent, host)` is registered |
| `assign_task` | Registered caller is the task owner |
| `update_task`, `notify_blocked`, `report_result` | Registered caller is the task executor |

`send_message.from` also equals the principal. Registration role, provider and
capability never grant authority.

A required `AuthorizationPort` exposes only:

```
isRegistered(context)
task(project, task) → { owner, executor? } | null
```

The router evaluates it before the Runtime Port. Missing facts, a denied check
or an Authorization Port failure all fail closed with stable boundary codes.
The task lifecycle still decides whether an authorized operation is legal.

Event envelopes, task status mutation and approval decisions remain absent from
all tool schemas and Runtime Port methods. `request_approval` asks; only the
human control plane can grant or reject.

## Alternatives

**Authorize by role.** Rejected: role is display metadata supplied at
registration and is not a credential.

**Let each Runtime Port method authorize itself.** Rejected: policy would be
duplicated twelve times and a new handler could forget it.

**Expose a generic `can(tool)` callback.** Rejected: that moves the matrix out of
the ingress and makes tests prove a mock policy rather than product policy.

## Consequences

- Every non-registration call requires a live registered placement.
- A task owner may delegate; only its executor may report execution state or a
  result.
- Human task assignment and approval use authenticated human control routes,
  not MCP.
- Authorization checks are deterministic projection reads and append nothing.
