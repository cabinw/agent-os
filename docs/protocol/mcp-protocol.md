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

Emits `agent.registered`. Re-registering an existing id reconnects it rather
than duplicating.

### find_agent

Discover by capability, never by vendor.

```json
{ "method": "find_agent", "params": { "capabilities": ["architecture"], "available": true } }
```

Returns candidates ranked by capability match, current load and past outcomes.

### create_task

```json
{
  "method": "create_task",
  "params": {
    "title": "Implement payment webhook handler",
    "goal": "GOAL-003",
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
| `replyTo` | Event id of the message being answered. Drives reply quoting and lets `answer` be matched to its `question`. |
| `attachments` | Output paths or `KN-*` knowledge ids. Display-only references — attaching does not transfer or copy anything. |

Messages are the readable record of a task's collaboration. See
[product/threads.md](../product/threads.md); thread grouping is fixed by
[ADR-006](../decisions/ADR-006-threads-as-a-view-in-agents.md).

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

Moves the task to `review`, not to `completed` — acceptance is a separate act.
Emits `task.review.requested`.

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
request expires as `approval.expired` and the task stays blocked.

### get_context

Retrieve the shared context for a task: related documents, prior decisions,
research, upstream results.

```json
{ "method": "get_context", "params": { "task": "TASK-014", "include": ["decisions", "outputs"] } }
```

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
{ "method": "query_memory", "params": { "q": "why postgres", "type": "decision" } }
```

Emits `knowledge.created`.

## Rules for implementers

- An agent may never write an event directly. Tools request; the runtime decides
  and emits.
- An agent may never set task status directly. It reports; the Task Engine
  transitions.
- An agent may never approve its own request.
- Every tool call is validated at the MCP Server boundary. Unknown fields are
  rejected, not ignored.
- Calls are idempotent by client token; retries do not duplicate work.

## Planned

Agent negotiation, multi-agent planning proposals, autonomous task routing,
agent performance analytics.
