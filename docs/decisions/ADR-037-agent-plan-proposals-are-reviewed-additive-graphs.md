# ADR-037: Agent Plan Proposals Are Reviewed Additive Graphs

Status: accepted

## Context

The Supervisor can atomically create a complete task graph from a goal. Worker
agents can report execution facts but cannot propose a durable plan change.
Task requirements, priorities and dependencies are immutable after
`task.created`; pretending to edit them would violate event replay.

## Decision

A registered worker may submit one additive task graph through `propose_plan`.
The request contains a client-stable proposal id, goal, title, summary,
rationale and strict tasks. The runtime still owns event ids and envelope
authority. Dependencies are discriminated references to either an existing
`TaskId` or a proposal-local key. Local keys are never persisted as Task ids.

The runtime emits `plan.proposed`. Its projection keeps the complete reviewable
graph. Only the trusted Supervisor review service may accept or reject; the MCP
surface has no review operation and a proposer cannot review itself.

Acceptance allocates permanent Task ids, rewrites both dependency forms, and
runs `validateTaskPlan` against current project state. One idempotent admission
command atomically emits `plan.accepted` and every ordered `task.created` event.
Any id, graph or write failure admits nothing. Rejection atomically emits only
`plan.rejected` and creates no tasks.

The review event is caused by `plan.proposed`. Accepted and rejected outcomes
are Memory decision candidates. This phase does not mutate existing task
requirements, dependencies or priorities; such changes need explicit future
events and lifecycle policy.

## Alternatives

**Let workers call `create_task` repeatedly.** Rejected: a crash can partially
admit a graph and forward references cannot be checked as one unit.

**Reuse the Supervisor planning model.** Rejected: an execution agent already
has the proposed work; another model generation would replace rather than
review its reasoning.

**Edit existing task payloads in place.** Rejected: derived state must replay
from immutable events.

**Expose accept and reject over MCP.** Rejected: self-declared role metadata is
not authority and would let a worker approve its own graph.

## Consequences

- Worker planning ideas are durable and reviewable before task mutation.
- Accepted additions reuse the canonical graph validator and stable ordering.
- Rejected proposals retain their rationale without creating orphan tasks.
- Replacement and cancellation proposals remain future explicit protocols.
