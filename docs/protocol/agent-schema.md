# Agent Schema

## Logical Agent

```json
{
  "id": "codex-developer",
  "name": "Codex",
  "provider": "openai",
  "role": "developer",
  "parentAgent": "supervisor",
  "concurrency": 2,
  "registeredAt": "2026-07-20T09:00:00Z"
}
```

## Fields

| Field | Notes |
| --- | --- |
| `id` | Stable, human-readable, unique per project |
| `provider` | Recorded for display and billing only. **Never branch on this.** |
| `role` | Display grouping: supervisor, architect, developer, researcher, reviewer, designer |
| `parentAgent` | Delegation tree; failures escalate to the parent |
| `concurrency` | Logical upper bound across the agent's placements |

## Host placement

An agent id is logical and stable within a project. Each reachable execution
location is a separate `HostPlacement`:

```json
{
  "agent": "codex-developer",
  "host": "wk-macbook",
  "os": "macos",
  "arch": "arm64",
  "mcpServers": ["agent-os"],
  "capabilities": ["coding", "testing", "git"],
  "status": "working",
  "currentTask": "TASK-014",
  "lastSeenAt": "2026-07-20T09:42:00Z"
}
```

The Hub derives `host` from the authenticated Runner connection. A request may
not claim another host. The same agent may expose different capabilities on a
different host; reachability, status, current load and task routing apply to the
placement, not the logical Agent. See
[ADR-008](../decisions/ADR-008-server-hub-local-first-runners.md).

## Capability vocabulary

Controlled list, so `find_agent` matches exactly rather than guessing at free
text. Extending it is a protocol change.

| Capability | Meaning |
| --- | --- |
| `architecture` | System design, technology selection, ADR authorship |
| `coding` | Implementation |
| `testing` | Test authorship and execution |
| `review` | Code and output review |
| `research` | External investigation, comparison, literature |
| `design` | Interface and visual design |
| `writing` | Documentation and copy |
| `data` | Analysis, schema, migration |
| `ops` | Build, deploy, infrastructure |
| `git` | Version control operations |

## Integration capability

A second, independent axis. Task capability says *what work an agent can do*;
integration capability says *how it can be driven*. Declared by the adapter at
registration, never inferred.

```json
{
  "integration": {
    "participates": true,
    "streaming": true,
    "reasoning": false,
    "session": true,
    "usage": true
  }
}
```

| Field | Meaning | If false |
| --- | --- | --- |
| `participates` | Will actually call our MCP tools when they are offered | **An adapter must translate on its behalf** — see below |
| `streaming` | Emits answer tokens as they are produced | Surfaces must show a pending state, not an empty stream |
| `reasoning` | Emits a separate reasoning trace | No thinking fold is rendered |
| `session` | A prior turn can be continued by id | Every turn is cold; context must come from `get_context` |
| `usage` | Reports token counts | No usage display |

**Surfaces branch on the declaration, never on `provider`.** The four vendors
measured in [apps/chat-spike/FINDINGS.md](../../apps/chat-spike/FINDINGS.md)
differ on three of these fields, so a UI built against any single one of them is
wrong for the others.

`participates` is not like the others. The rest degrade presentation; this one
decides whether the agent can reach the runtime unaided. **It is measured, never
declared by the vendor** — all four complete the MCP handshake, and that predicts
nothing:

| | handshake | calls our tools |
| --- | --- | --- |
| Claude Code | ✅ | ✅ |
| Kimi | ✅ | ✅ |
| Grok | ✅ | ✅ |
| Codex | ✅ | ❌ `tool_search_always_defer_mcp_tools`, stage `removed` |

Codex is fully compliant at the transport layer and still never offers the tools
to its model. A vendor that "speaks MCP" may or may not participate, so the field
records an observation, not a claim.

When it is false the adapter translates the vendor's reply into a `send_message`
request. That does not weaken the boundary — the adapter is inside it, the vendor
is outside, and the same validation runs either way. What it costs is generality:
a non-participating vendor needs code written for it, and one that participates
needs none.

**Attaching the server is itself vendor-specific**, even where `participates` is
true: a CLI flag pointing at a file, a `.mcp.json` in the working directory, and
a TOML entry gated on folder trust were the three mechanisms measured. So an
adapter owns *connection configuration* as well as invocation — see
[FINDINGS](../../apps/chat-spike/FINDINGS.md#mounting-the-server-differs-per-vendor-with-nothing-in-common).

Routing still reads `capabilities` only —
[ADR-004](../decisions/ADR-004-capability-first-agent-catalog.md). Integration
capability governs *presentation and orchestration*, not task assignment.

## Provider neutrality

See [ADR-004](../decisions/ADR-004-capability-first-agent-catalog.md). The shipped
adapter catalog is configuration; core code contains no provider list. Swapping
one vendor for another is a registration change, not a code change.

## Placement lifecycle

```
registered → idle ⇄ working → idle
              ↓        ↓
       disconnected  waiting / blocked
```

Disconnection is normal. Tasks held by a disconnected agent return to `assigned`
after a grace period and are re-matched.
