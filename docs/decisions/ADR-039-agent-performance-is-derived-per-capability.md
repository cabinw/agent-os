# ADR-039: Agent Performance Is Derived per Capability

Status: accepted

## Context

A logical agent's aggregate completion rate hides material differences between
capabilities. Self-reported scores are not project evidence, while a separate
performance store would duplicate state already present in Task events.

## Decision

Agent performance is a deterministic report derived from the Task projection.
Only terminal `completed` and `failed` results count. Cancelled, running and
other non-result states do not create samples.

Each result is attributed to the logical `executor` overall and to every
capability in the task's immutable `requires` set. The report includes completed
and failed counts, a Laplace-smoothed success score `(completed + 1) / (samples
+ 2)`, and average elapsed time from `startedAt` to `terminalAt`. Missing or
negative terminal timing evidence fails closed. An unseen capability has the
neutral score `0.5` and no duration.

Routing remains deterministic. After capability eligibility and live-load
ordering, candidates rank by the mean score for the current task's required
capabilities, then global result score, then lexical agent and host ids.
Performance never overrides capacity and never reads provider identity.

No performance event or mutable performance table is introduced. Reports may
be cached only as discardable projection output.

## Alternatives

**One global score per agent.** Rejected: unrelated successes can conceal weak
performance for the capability a task actually needs.

**Agent self-report or provider reputation.** Rejected: neither is sourced
project evidence and both couple routing to integrations.

**Persist rolling metrics.** Rejected: it duplicates event-derived state and
creates replay drift.

## Consequences

- Replay produces the same performance report and routing order.
- Multi-capability tasks contribute one result to each required capability.
- Small samples remain conservative through smoothing; unseen work is neutral.
- Duration measures observed task execution, not provider latency in isolation.
