# ADR-031: Human Thread Posting Is Message-Only and Project-Gated

Status: accepted

## Context

Threads may accept human guidance, but MCP `send_message` authenticates an
Agent principal. Reusing it in the macOS UI would either impersonate an Agent or
move identity into caller-controlled fields. A thread message must also remain
incapable of granting a pending approval.

Projects need an explicit read-only mode. Adding an optional field to the frozen
V1 `project.created` payload would violate ADR-009.

## Decision

`project.human.participation.configured { enabled }` is a permanent project
event. Only a human actor may emit it. No such event means disabled; the latest
valid event wins. The sourced UI policy keeps that event id, or the project
creation id when applying the default.

The trusted composition layer authenticates the human and exposes a narrow
message client to the UI. Its intent contains only thread addressing, message
type, content and optional reply/attachments. It contains no actor, event type,
approval id, grant, reject or generic append field. The client can create only
`message.sent` with a human actor.

The composer is absent when policy is disabled or the trusted client is not
connected. Sending is fail-closed and retryable; optimistic transcript facts are
not inserted. Approval dividers continue to link only to Approval Center.

## Alternatives

**Reuse MCP `send_message`.** Rejected: its principal is an Agent and its `from`
field is bound to that principal.

**Add a flag to `project.created`.** Rejected: V1 event payloads are frozen.

**Treat “yes” as approval.** Rejected: prose is ambiguous and bypasses complete
risk disclosure, authenticated human decisions and Approval Gate atomicity.

## Consequences

- Posting policy is replayable and defaults safely for existing projects.
- UI messages are guidance only, even while an approval is pending.
- Human identity and event append authority remain outside React.
- Enabling or disabling posting is itself auditable project history.
