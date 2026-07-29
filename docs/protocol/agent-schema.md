# Agent Schema

## Object

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
| `capabilities` | Controlled vocabulary below. The only field routing reads. |
| `status` | registered / idle / working / waiting / blocked / disconnected |
| `parentAgent` | Delegation tree; failures escalate to the parent |
| `concurrency` | Max simultaneous tasks. Saturation removes the agent from matching. |

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
    "streaming": true,
    "reasoning": false,
    "session": true,
    "usage": true
  }
}
```

| Field | Meaning | If false |
| --- | --- | --- |
| `streaming` | Emits answer tokens as they are produced | Surfaces must show a pending state, not an empty stream |
| `reasoning` | Emits a separate reasoning trace | No thinking fold is rendered |
| `session` | A prior turn can be continued by id | Every turn is cold; context must come from `get_context` |
| `usage` | Reports token counts | No usage display |

**Surfaces branch on the declaration, never on `provider`.** The four vendors
measured in [apps/chat-spike/FINDINGS.md](../../apps/chat-spike/FINDINGS.md)
differ on three of these four fields, so a UI built against any single one of
them is wrong for the others.

Routing still reads `capabilities` only —
[ADR-004](../decisions/ADR-004-capability-first-agent-catalog.md). Integration
capability governs *presentation and orchestration*, not task assignment.

## Provider neutrality

See [ADR-004](../decisions/ADR-004-capability-first-agent-catalog.md). The shipped
adapter catalog is configuration; core code contains no provider list. Swapping
one vendor for another is a registration change, not a code change.

## Lifecycle

```
registered → idle ⇄ working → idle
              ↓        ↓
       disconnected  waiting / blocked
```

Disconnection is normal. Tasks held by a disconnected agent return to `assigned`
after a grace period and are re-matched.
