# ADR-036: Negotiation Separates Agent Consensus from Human Resolution

Status: accepted

## Context

Messages can carry warnings and reviews but have no negotiation state. A task
blocker is work lifecycle, while Approval authorizes an action. None records an
architecture proposal, objection, escalation and final reasoned decision even
though the Supervisor contract says every escalation is an event.

## Decision

One negotiation has four immutable event types:

```
opened → objected → escalated → resolved
   └───────────────→ resolved       non-architecture agent consensus
```

Every continuation is caused by the immediately prior negotiation event.
Participants are fixed at open. Only a non-proposer participant can object and
each participant objects at most once.

An architecture-changing proposal with an objection must be escalated and only
the addressed human can resolve it. Agents may resolve an un-escalated,
non-architecture negotiation. Agent MCP exposes open, object, escalate and the
narrow un-escalated resolve request; the trusted human control plane owns
escalated resolution.

The human resolution service reads the projected escalation target and sends
one idempotent admission command containing `negotiation.resolved` plus decision
Memory. It never appends an envelope itself. The resolution event is also a
Memory decision candidate, preserving the reasoning if extraction is used.

## Alternatives

**Use warning and review messages.** Rejected: reply chains do not enforce
participants, transitions, escalation or terminal resolution.

**Use Approval.** Rejected: permission to perform an action is not agreement on
which architecture is correct.

**Allow agents to resolve escalated architecture disputes.** Rejected: it would
bypass the human boundary that escalation exists to protect.

## Consequences

- Disagreement and resolution replay into one deterministic state.
- Architecture disputes cannot silently stop or self-resolve after escalation.
- The final decision carries rationale and an atomic Memory command.
- Roles remain display metadata; identity comes from authenticated actors.
