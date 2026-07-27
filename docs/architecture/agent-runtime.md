# Agent Runtime

Manages the lifecycle of connected agents and answers one question well: *which
agent should do this?*

## Agent lifecycle

```
registered ──▶ idle ──▶ working ──▶ idle
                 │         │
                 │         ├──▶ waiting   (awaiting another agent or approval)
                 │         └──▶ blocked   (cannot proceed)
                 │
                 └──▶ disconnected ──▶ (re-register)
```

`disconnected` is expected, not exceptional — agent processes are ephemeral. Any
task held by a disconnected agent returns to `assigned` after a grace period and
is re-matched.

## Model

```json
{
  "id": "codex-developer",
  "name": "Codex",
  "provider": "openai",
  "role": "developer",
  "capabilities": ["coding", "testing", "git"],
  "status": "working",
  "currentTask": "TASK-014",
  "parentAgent": "supervisor",
  "concurrency": 2
}
```

## Capability, not provider

See [ADR-004](../decisions/ADR-004-capability-first-agent-catalog.md). Nothing in
the runtime branches on `provider`. Task routing reads `capabilities` only, so a
project can swap Codex for Gemini by registering a different agent — no task, no
document, no line of core code changes.

Capability vocabulary is defined in
[protocol/agent-schema.md](../protocol/agent-schema.md); it is a controlled list
so that `find_agent` is not guessing at free text.

## Adapters

An adapter is the thin translation between a vendor's interface and the Agent SDK.
It is the only place a provider name may appear.

```
       Agent SDK  (register, receiveTask, reportProgress, reportResult)
            ▲
   ┌────────┼────────┬──────────┬──────────┐
Claude   Codex    Gemini    Perplexity   …          ← adapters
```

Adapters are configuration, not architecture: the shipped set is a catalog that
grows without touching `agent-runtime`. Agents that already speak MCP need no
adapter at all — they call the MCP Server directly.

## Supervision tree

`parentAgent` forms a tree rooted at the Supervisor. It carries delegation
accountability: if a child fails, the parent is notified and decides whether to
retry, reassign, or escalate to a human.

```
supervisor
├── claude-architect
│   └── codex-developer
└── perplexity-researcher
```

## Health

The runtime tracks per-agent liveness (heartbeat), throughput, and blocked
frequency. This feeds the agent status list in the menu bar and the health
indicator on project cards. An agent failing health checks stops receiving new
assignments before it is disconnected.
