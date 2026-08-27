# ADR-019: Phase 1 Demo Is a Deterministic Composition Root

Status: accepted

Product-entry clarification: ADR-047 selects the existing Chat Spike/Hub as the
starting point for the interactive Code Agent entry. The rejection below still
applies to using Spike internals as proof of the formal deterministic Phase 1
composition or copying its pre-v1 contracts into formal packages.

## Context

Phase 1 has formal Event Core, SQLite store, Task Engine, MCP boundary, Agent
SDK, Approval Gate and Supervisor packages, but no composition root connects
them. A UI screenshot or the pre-v1 Chat Spike cannot prove the formal loop.
The Supervisor also requires decisions and task creation to commit atomically,
while the current event-store boundary exposes only single-event append.

## Decision

`apps/core-demo` is a headless deterministic composition root and executable
script. It imports the formal packages; it does not copy their reducers or use
the Chat Spike. Its scripted Planner and Runner replace only vendor/network
nondeterminism. They are fixtures, not production Hub implementations.

The composition executes one fixed scenario:

```
human goal message
  → Supervisor plan
  → atomic decision + task.created group
  → capability route + task.assigned
  → Runner dispatch + task.started
  → AgentClient update_task + request_approval
  → human grant
  → AgentClient report_result
  → human review acceptance + task.completed
  → full replay
```

The Event Bus and SQLite store gain a same-project `appendGroup` primitive.
Every input and client token is validated before one SQLite immediate
transaction. A retry must find either the entire identical group or none; mixed
existing/new membership fails closed. The Bus catches up reducers and notifies
subscribers only after the durable group commits.

The demo Runtime and Authorization ports read formal Catalog and Task
projections. Agent calls still pass through `McpToolRouter` and `AgentClient`.
Runner dispatch remains the wake path; MCP remains the participation path.
Human grant and final acceptance use explicit composition ports and are never
MCP tools.

Success is a JSON evidence object and exit code zero. It asserts the exact event
type order, canonical actor/subject/causedBy fields, decision source, selected
capability, review-before-completion, granted approval and equality between live
and replayed Task, Catalog, Approval and Conversation projections. No screenshot
or prose output can satisfy the demo.

## Alternatives

**Extend the Chat Spike.** Rejected: its pre-v1 events, runtime and adapters are
behavioral evidence, not the formal package contracts.

**Mock every package in one test.** Rejected: it proves orchestration code but
not SQLite durability, Event Bus replay, MCP authorization or SDK boundaries.

**Call a real vendor CLI.** Rejected for the canonical gate: credentials,
network and model variance would make Phase 1 acceptance nondeterministic. Real
local/remote evidence remains a separate deployment route.

**Expose human acceptance as MCP.** Rejected: an executing agent must never be
able to approve or accept its own work.

## Consequences

- The demo is runnable offline and repeatable in CI.
- Atomic event groups become a formal Event Core/store capability needed by the
  Supervisor beyond the demo.
- Production Hub composition is still separate work; the fixture must not be
  deployed as a server.
- Any missing event, illegal transition, authorization bypass, partial group or
  replay drift makes the script fail non-zero.
