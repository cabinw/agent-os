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
