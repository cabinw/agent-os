# Agent OS MCP Protocol v0.3

**Canonical.** Supersedes `mcp-api-v0.1.md`, `mcp-tools-v0.1.md`,
`mcp-collaboration.md` and `mcp-protocol-v0.2.md`.

## Purpose

One communication standard between AI agents and the Agent OS runtime, so that
Claude, Codex, Gemini, Grok, Kimi, Cursor, Perplexity or anything else can
participate in the same team without bespoke integration.

## Changes from v0.2

| Change | Reason |
| --- | --- |
| `progress_update` → `update_task` | One tool for progress, note and partial output |
| `request_human_approval()` → `request_approval` | v0.2 and the collaboration doc used two names |
| Added `get_context`, `write_memory`, `query_memory` | Shared context was described but had no API |
| Task states lowercased and unified | Three conflicting lifecycles existed; see ADR-002 |
| Every tool documents its emitted event | Events were specified separately and drifted |
| Caller identity comes from authentication | An agent-controlled `caller` / `from` field is not authority |

## Authentication and caller identity

Every data, control, event-stream and MCP call is authenticated before handling.
The only public resource is an inert bootstrap shell with no project data or
capability. An HTTP bearer token maps server-side to a human or agent principal;
the stdio bridge receives a scoped agent credential from its Runner. Vendor
credentials never reach the Hub.

The authenticated principal is the caller. A `caller`, `from` or agent id in a
request body cannot change it. Registration ids must match the authenticated
agent principal. Human-only actions, including acceptance, are not exposed as
MCP tools.

Remote Runners use a separate host credential on their outbound connection. The
Hub derives host placement from that connection rather than accepting `host`
from a dispatch body. See
[ADR-008](../decisions/ADR-008-server-hub-local-first-runners.md).

## Call admission boundary

HTTP and stdio transports authenticate before invoking the common router. They
provide trusted `project`, agent principal, Runner `host`, `clientToken` and
optional runtime-owned `causedBy` as `McpCallContext`. These are not tool
arguments. The client token scopes idempotent command append; retries reuse it.

Each tool has one strict Zod input schema used both for runtime parsing and its
published JSON Schema. Parsed input is frozen and dispatched to the matching
method on a state-free `RuntimePort`. Unknown tools and invalid arguments use
stable boundary error codes; lifecycle, graph, routing and append conflicts from
the Runtime Port remain domain errors. See
[ADR-013](../decisions/ADR-013-mcp-call-admission-boundary.md).

Before dispatch, a read-only Authorization Port applies ADR-014's fixed matrix.
Registration is self-only. Every other tool requires the same authenticated
`(project, agent, host)` registration; `assign_task` additionally requires task
ownership, while `update_task`, `notify_blocked` and `report_result` require the
task executor. Agent-supplied role, provider and capability never grant
authority. Missing facts or policy-read failures fail closed.

## Objects

```
Project ─ Goal ─ Task ─ Agent ─ Event ─ Memory
                  │
              Message · Approval · Resource
```

## Tool reference

### register_agent

Required before any other call. Registration is per project.

```json
{
  "method": "register_agent",
  "params": {
    "id": "codex-developer",
    "name": "Codex",
    "provider": "openai",
    "role": "developer",
    "capabilities": ["coding", "testing", "git"],
    "concurrency": 2
  }
}
```

Emits `agent.registered` with runtime-owned `host`, adapter-owned `integration`
and the admitted `concurrency`. Re-registering the same `(agent, host)`
reconnects it rather
than duplicating — **and "does not duplicate" means no second event**, not a
second event the reader is expected to ignore. Agents re-register unprompted
mid-task; events are permanent, so a duplicate puts a spurious "X joined" into
every future replay of that log.

Registration must also make the agent *reachable*, not merely valid. An id that
passes registration but has no authenticated Runner placement is a sender
everyone can reply to and nobody can reach. Effective capability is stored on
that `(agent, host)` placement. The runtime adds `host` to the registration event
from the Runner principal; it is not a `register_agent` parameter.

### find_agent

Discover by capability, never by vendor.

```json
{ "method": "find_agent", "params": { "capabilities": ["architecture"], "available": true } }
```

Returns reachable `(agent, host)` candidates ranked by capability match, current
load and past outcomes. Callers select a logical agent; the Hub keeps the chosen
host placement for dispatch.

The catalog alone is insufficient after replay. The Hub joins it with the
authenticated Runner snapshot, excludes non-accepting and logically saturated
placements, and applies the deterministic order in ADR-012. No candidate is an
explicit `no-capability`, `unreachable`, `unavailable` or `saturated` result;
assignment leaves the task `created` and surfaces the reason.

### create_task

```json
{
  "method": "create_task",
  "params": {
    "title": "Implement payment webhook handler",
    "goal": "GOAL-003",
    "description": "Handle Stripe webhooks with idempotency keys.",
    "requires": ["coding"],
    "priority": "high",
    "dependsOn": ["TASK-012"],
    "requiresApproval": false
  }
}
```

Emits `task.created`. Note there is no `executor` field — assignment is a
separate, explicit act.

### assign_task

```json
{ "method": "assign_task", "params": { "task": "TASK-014", "executor": "codex-developer" } }
```

Emits `task.assigned`. Omitting `executor` asks the runtime to match by
capability.

### update_task

Progress reporting during execution.

```json
{
  "method": "update_task",
  "params": { "task": "TASK-014", "progress": 65, "note": "Implementing MCP tools" }
}
```

Emits `task.progress.updated`. Progress is advisory and never changes state.

### send_message

```json
{
  "method": "send_message",
  "params": {
    "from": "claude-architect",
    "to": "codex-developer",
    "task": "TASK-014",
    "type": "instruction",
    "content": "Implement against architecture spec v2; idempotency required.",
    "replyTo": "evt_01H...",
    "attachments": ["src/webhooks/handler.ts", "KN-052"]
  }
}
```

Types: `instruction`, `question`, `answer`, `progress`, `report`, `review`,
`warning`. Emits `message.sent`.

| Field | Notes |
| --- | --- |
| `to` | An agent id, or `"*"` to address every agent on the task. Not a list — a fan-out is one message with `"*"`, not N messages. |
| `task` | Determines which thread the message joins. Omitting it lands the message in the project thread; agents should scope to a task whenever one applies. |
| `replyTo` | Event id of the message being answered. Required for `answer`; optional for other types. It drives quoting, not runtime causal budgets. |
| `attachments` | Output paths or `KN-*` knowledge ids. Display-only references — attaching does not transfer or copy anything. |

Messages are the readable record of a task's collaboration. See
[product/threads.md](../product/threads.md); thread grouping is fixed by
[ADR-006](../decisions/ADR-006-threads-as-a-view-in-agents.md).

**A message addressed to an agent wakes that agent.** Delegation is not a
separate mechanism; it is this one. An unknown recipient must be rejected at the
boundary rather than accepted — a `to` nobody will ever read looks delivered and
is not.

**The runtime owns `causedBy`, never the caller.** `replyTo` is a semantic
message reference and may differ from the event that woke the turn. The runtime
validates it but never derives causal depth from it. When an agent has no causal
field to supply, the runtime still links emitted events to the wake event. Runaway
protection is keyed on causal depth, so a chain the sender can detach itself
from is a budget the sender can opt out of — measured in
[chat-spike](../../apps/chat-spike/FINDINGS.md#two-holes-the-first-live-run-found),
where two agents would have bounced work forever while every individual message
looked well-formed. Generalises: **any limit keyed on data the agent supplies is
advisory.**

### notify_blocked

Mandatory when an agent cannot proceed. Silence is a failure mode the system
treats as a stall.

```json
{
  "method": "notify_blocked",
  "params": {
    "task": "TASK-014",
    "reason": "Need decision on retry semantics for duplicate webhooks",
    "severity": "high",
    "needs": "human"
  }
}
```

`needs` ∈ `human` | `agent` | `resource`. Emits `task.blocked`.

### report_result

```json
{
  "method": "report_result",
  "params": {
    "task": "TASK-014",
    "status": "completed",
    "summary": "Webhook handler implemented with idempotency keys.",
    "outputs": ["src/webhooks/handler.ts", "src/webhooks/handler.test.ts"]
  }
}
```

`status: "completed"` moves the task to `review`, not to `completed` — human
acceptance is a separate act — and emits `task.review.requested`.
`status: "failed"` emits `task.failed` with the runtime attempt count. It never
creates a review request for a result the executor declared unrecoverable.

### request_approval

The human-in-the-loop gate. Required for deployment, deletion, spending,
external publishing, and architecture changes.

```json
{
  "method": "request_approval",
  "params": {
    "action": "Deploy asset pipeline to staging",
    "task": "TASK-014",
    "risk": "medium",
    "reversible": true,
    "detail": "Deploys commit a3f21c to staging; no production traffic."
  }
}
```

Blocks the caller. Emits `approval.requested`, then `approval.granted` or
`approval.rejected`. **Approvals never auto-grant on timeout** — an unanswered
request expires as `approval.expired` and the task stays blocked. The expiration
payload records the planned RFC3339 deadline as `after`; envelope `at` records
when the expiration fact was admitted.

The Phase 1 Gate blocks the tool promise and linearizes human decision against
timeout. A task-scoped request/decision uses the atomic event groups in ADR-015.
Because v1 does not store the deadline on `approval.requested`, process restart
leaves pending requests fail-closed rather than inventing a replacement timer.

### get_context

Retrieve the shared context for a task: related documents, prior decisions,
research, upstream results.

```json
{ "method": "get_context", "params": { "task": "TASK-014", "include": ["decisions", "outputs"] } }
```

`include` is a non-empty unique selection of exactly `decisions` and `outputs`.
The strict response always contains `project`, `included`, the requested `task`,
`scopeTasks`, `decisions` and `outputs`; an unrequested section is an empty
array. `scopeTasks` is the target plus its complete transitive dependency scope.

Current decisions are selected structurally: project-wide active decisions and
active decisions related to the target or an upstream dependency. Items with
`supersededBy` are omitted without deleting their history. Outputs come only
from completed upstream dependencies. Ordering is deterministic and neither
selection nor ordering uses text, provider or wall-clock recency. See
[ADR-023](../decisions/ADR-023-relevance-bounded-task-context.md).

An agent is expected to call this before starting work. Working from an isolated
context is the failure this protocol exists to prevent.

**Do not add a small default `limit` to save tokens.** Measured across four
vendors, shipping 100× more context cost ~50% more, while re-entering the agent
at all cost ~100% — so truncation buys almost nothing and can silently drop the
fact the turn needed
([FINDINGS](../../apps/chat-spike/FINDINGS.md#3c-the-bill-was-the-axis-we-were-not-watching)).
Where the response must be bounded, bound it by relevance, never by recency
alone.

### write_memory / query_memory

```json
{
  "method": "write_memory",
  "params": {
    "type": "decision",
    "title": "Adopt PostgreSQL",
    "summary": "Chosen over MongoDB for relational joins plus JSONB.",
    "rationale": "Schema requires strong relations; JSON support still needed.",
    "alternatives": ["MongoDB", "SQLite"]
  }
}
```

```json
{
  "method": "query_memory",
  "params": {
    "q": "why postgres",
    "type": "decision",
    "after": "2026-01-01T00:00:00Z",
    "relatedTo": "TASK-014",
    "status": "all"
  }
}
```

Every field is optional; empty input lists all knowledge. `after` / `before`
are inclusive RFC3339 bounds. `relatedTo` and `relation` query canonical task,
supersession and explicit `knowledge.linked` relations. `status` is `active`,
`superseded` or `all` and defaults to `all`, so historical decisions remain
readable. Predicates are ANDed, output is creation-sequence ordered and no
hidden result limit is applied. See
[ADR-024](../decisions/ADR-024-memory-query-and-causal-graph.md).

Emits `knowledge.created`. `rationale` and `alternatives` are preserved in that
event; the runtime adds auditable `sourceEvents` from the admitted causal
context rather than writing a second knowledge table.

The graph API is a pure Memory Core read over complete project history. Nodes
are stored events and its only causal edges are derived from backward
`causedBy`. Explicit `knowledge.linked` payloads are semantic relations returned
separately; they never masquerade as causal edges.

## Rules for implementers

- An agent may never write an event directly. Tools request; the runtime decides
  and emits.
- Tools never accept `schemaVersion`, `id`, `seq`, `at`, `actor` or `causedBy`.
  Those are runtime/store-owned event fields.
- An agent may never set task status directly. It reports; the Task Engine
  transitions.
- An agent may never approve its own request.
- Agent registration `role` is display metadata and never an authorization
  input.
- Every tool call is validated at the MCP Server boundary. Unknown fields are
  rejected, not ignored.
- Caller and host identity come from authenticated principals, never request
  fields.
- Calls are idempotent by client token; retries do not duplicate work.

## Planned

Agent negotiation, multi-agent planning proposals, autonomous task routing,
agent performance analytics.
