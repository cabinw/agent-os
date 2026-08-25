# ADR-042: Interrupted Runner Dispatch Recovery

Status: accepted

## Context

The event log can end with a task in `assigned` or `running` while a Hub process
has lost its in-memory agent queue. Remote Runner already fences old leases and
can replay a terminal result for the same `requestId`, but no boot path asked it
to do so. A task could therefore remain `running` forever after a Hub restart.

Changing `running` back to `assigned` would invent a lifecycle transition that
ADR-002 does not permit. Emitting another `task.started` would create a second
logical execution identity.

## Decision

After the Hub is listening and all configured agents are registered, it
reconciles durable non-terminal task state:

```text
assigned ── emit one task.started ── dispatch(started.id)
running  ── no new event ────────── dispatch(existing started.id)
```

- `task.started.id` is the Runner `requestId`.
- A running task uses the latest stored `task.started` for that lifecycle.
- The Hub reconstructs the original assignment/rework wake from the stored
  `task.assigned` and its prior lifecycle state. The complete dispatch
  fingerprint, including the prompt, remains unchanged.
- Reconciliation is idempotent within one Hub process.
- `blocked`, `review`, terminal tasks and tasks without a registered executor
  are not dispatched.
- The Remote Runner lease rejects stale uploads. A surviving Worker returns its
  cached execution for the repeated `requestId` instead of invoking the adapter
  again.
- Hub shutdown detaches from Remote Runner work without issuing cancellation.
  Explicit cancellation remains the only operation that terminates remote
  execution; the next Hub reuses the durable request id.
- The task remains `running` until the executor reports
  `task.review.requested` or a permitted terminal failure is recorded. A
  successful Runner result is a structural fallback delivery when an explicit
  `report_result` call did not survive the interruption; a non-retryable Runner
  error records `task.failed`.

## Alternatives

**Fail every running task on boot.** Rejected: process loss does not prove the
work failed, and a surviving Worker may already hold the result.

**Move running tasks back to assigned.** Rejected: ADR-002 has no such
transition, and rewriting derived state would violate event sourcing.

**Emit a new started event.** Rejected: a new id bypasses transport idempotency
and can duplicate one logical execution.

## Consequences

- Hub restart automatically asks unfinished work to converge.
- Remote execution is deduplicated by the stable request id and old-lease
  fencing.
- A local adapter process dies with the Hub and may run again. External effects
  before the crash therefore still require operation idempotency; irreversible
  actions remain behind explicit approval.
- Recovery starts only after the HTTP listener exists, so a local adapter can
  reach its MCP bridge.
- Recovery appends no synthetic lifecycle fact. Replay remains the authority.
