# ADR-015: Blocking Approval Gate

Status: accepted

## Context

`request_approval` must suspend its caller until a human grants or rejects, or a
deadline expires. Three underspecified edges prevent a safe implementation:

- an event id is allocated after `EventInput` already needs an approval subject;
- v1 `approval.requested` has no deadline field to recover a timer after restart;
- task-scoped request and decision flows also change task blocked state.

## Decision

An Approval has its own opaque subject id, generated before append. It is not the
`approval.requested` envelope id. All four approval events use that subject.

`reduceApprovalProject` derives `pending | granted | rejected | expired` and
rejects duplicate requests, unknown decisions, second decisions, non-human
grant/reject actors and payload/actor identity mismatch.

`createApprovalGate` is an in-process blocking coordinator:

```
request(input, agent context)
  ├─ atomic command-port admission
  ├─ pending waiter + timer
  └─ resolves only after grant / reject / expired is durably admitted
```

The required `ApprovalCommandPort` owns event admission. For a task-scoped
request it atomically appends `approval.requested + task.blocked`. Grant and
reject atomically append their approval event plus `task.unblocked`; expiration
appends only `approval.expired`, so the task stays blocked. A partial event group
is an admission failure, never a successful gate operation.

Grant and reject require a trusted human principal. Agent messages, Runtime Port
calls and prompt text cannot resolve a waiter. A per-approval settling latch
linearizes human decisions against timeout.

V1 cannot durably recover an exact deadline because the request payload has no
deadline. Phase 1 therefore uses a configured process-local timeout. A restart
leaves replayed requests pending and blocked; it never infers a grant or a new
deadline. A future event version may add a planned deadline and recovery.

Closing the Gate rejects local waiters and leaves durable approvals pending. A
command-port or prompt failure is reported and remains fail closed.

## Alternatives

**Use the request event id as approval id.** Rejected: the store allocates it
after the request subject has already been validated.

**Derive a deadline from request time and current configuration.** Rejected:
configuration changes would rewrite the meaning of historical requests.

**Append approval and task events separately.** Rejected: a crash can leave a
pending approval on a running task, or a blocked task with no request.

**Auto-grant on timeout or shutdown.** Rejected: it defeats the gate.

## Consequences

- Phase 3 UI replaces the prompt adapter, not the Gate contract.
- Pending approval is durable projection state; active waiters and timers are
  operational state.
- Exact deadline recovery requires a new event schema version, not a hidden
  projection field.
- Hub composition must provide atomic event-group admission before wiring this
  Gate to production commands.
