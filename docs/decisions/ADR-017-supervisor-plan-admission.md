# ADR-017: Supervisor Plans Use Local Keys and Atomic Admission

Status: accepted

## Context

A planning model cannot safely allocate permanent Task ids or append events. The
existing `validateTaskPlan` checks ids and dependency edges, but not a complete
structured plan. A selected alternative must also become durable Memory in the
same successful planning command.

## Decision

The formal Supervisor lives in `packages/supervisor`. It depends on
`task-engine` and `event-core`; it does not import a vendor SDK, event store or
adapter.

A trusted planning request contains a goal id, title, detail, constraints and
the permanent `causedBy` event that triggered planning. `causedBy` is never
model output.

`PlannerModel.plan` returns unknown structured data. The strict parser accepts:

```
summary
tasks[]     { key, title, description?, requires, priority,
              dependsOn: local-key[], requiresApproval }
decisions[] { key, title, summary, rationale, alternatives,
              affects: local-key[] }
```

Local keys are unique plan-scoped references and are never persisted. Supervisor
allocates a canonical Task id for every key, rewrites all edges and decision
references, then calls `validateTaskPlan` against current Task state. Model
output cannot contain Task ids, executor, provider, status, progress, actor,
event envelope, project or client token.

The required `SupervisorAdmissionPort` atomically admits all ordered task
creations and selected decisions. Task facts share the trusted goal and cause.
Decision knowledge uses the cause as a source and maps `affects` to allocated
Task ids. Either the whole command is durable or nothing is admitted.

Stable topological order determines task order. Decision order is stable by
local key. The port returns only after durable commit.

The model is injected. Production composition uses the tier fixed by ADR-007,
but Supervisor core contains no provider name. Invalid output, id allocation,
graph or admission fails closed; the Supervisor never silently repairs,
partially admits or invents a fallback plan.

## Alternatives

**Let the model emit `TASK-*` ids.** Rejected: ids can collide, impersonate an
existing task or produce unstable retries.

**Create tasks one MCP call at a time.** Rejected: forward references cannot be
validated as one graph and a crash leaves a partial plan.

**Write decisions after tasks commit.** Rejected: the plan can exist without the
reasoning that constrained it.

**Put planning in Hub composition.** Rejected: schema, mapping and graph
admission are domain behavior with a testable vendor-neutral boundary.

## Consequences

- Task storage needs atomic event-group admission before production composition
  can wire the Supervisor.
- A planning trigger must have a permanent cause; unsourced planning is rejected.
- Explicit planning decisions are command facts, not inferred Phase 2 summaries.
- Retrying a failed planning command uses a new operation token; the model never
  controls idempotency.
