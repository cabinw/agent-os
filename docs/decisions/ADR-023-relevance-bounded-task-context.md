# ADR-023: Task Context Is Bounded by Structural Relevance

Status: accepted

## Context

The canonical `get_context` tool names decisions and outputs, but the formal MCP
package only validates and forwards its input. The Spike runtime rebuilds a
plain message transcript. It does not consume the Task or Memory projections,
exclude superseded decisions, or identify upstream results.

A small default count is unsafe: the recall probe kept every planted fact after
100× log growth, while the measured cost was dominated by re-entering the agent,
not by shipping the larger context. Recency is also not relevance. Task Engine
and Memory Core are sibling packages and cannot import one another to solve the
composition locally.

## Decision

### Boundary and shape

`mcp-server` owns the provider-neutral read composition because it may import
both domain packages and remains above them. The Hub supplies current Task and
Memory projection snapshots for the authenticated project. The composer
strictly reparses both snapshots before reading them and returns one frozen
response:

```
project · included:[decisions|outputs] · task · scopeTasks
decisions:[...] · outputs:[...]
```

`task` is the requested task's stable work definition and current status.
`scopeTasks` is the requested task followed by its complete transitive
dependency closure. The two optional sections have stable array fields; a
section not requested in `include` is an empty array. Input and output reject
unknown fields. There is no count or recency limit in v1.

### Structural relevance

The dependency closure is derived only from canonical `dependsOn` edges. Every
referenced task must exist, every task must belong to the authenticated project,
and a cycle fails closed. The deterministic order is target first, then upstream
tasks in dependency-first topological order with task id as the tie-breaker.

A decision is injected only when it is active (`supersededBy` absent) and one of:

1. project-wide: `relatedTasks` is absent; or
2. task-related: `relatedTasks` intersects `scopeTasks`.

Related task ids must exist in the same project. Superseded items remain
queryable but never appear beside their active replacement. Relevant decisions
are ordered by `createdSeq`, then knowledge id. Text, title, timestamps and
provider values never affect selection.

An output is included only for a completed upstream dependency. It contains the
task id, title, accepted review summary and complete output list. The requested
task is not its own upstream output. Output order follows the dependency-first
scope order. Review-only, failed and cancelled results are excluded because they
have not been accepted as completed dependencies.

### Runtime contract

The pure composer performs no append and has no model or store access. A formal
Hub `RuntimePort.getContext` implementation reads both projections, invokes the
composer with `McpCallContext.project`, and returns its exact response. Transport
identity, project and snapshots are runtime-owned; an agent supplies only
`task` and the non-empty unique `include` selection.

The recall probe must be extended from a flat transcript to include project-wide
and dependency-related decisions, an unrelated decision, a superseded chain and
accepted upstream outputs. Increasing unrelated knowledge must not change the
selected response or recall result.

## Alternatives

**Keep the Spike transcript as the product response.** Rejected: chat proximity
does not identify current decisions or accepted upstream work.

**Put composition in Task Engine or Memory Core.** Rejected: either direction
would couple sibling domain packages and reverse the package contract.

**Select the newest N decisions.** Rejected: a relevant old constraint can be
silently displaced by unrelated recent work.

**Use keyword or embedding similarity in v1.** Rejected: it is non-deterministic,
harder to audit and unnecessary while canonical task relations are available.

**Inject every historical version.** Rejected: a supersession chain has one
unambiguous active head; historical drift remains available through query APIs.

## Consequences

- Context size grows with structurally relevant work, not project age.
- Replay of identical Task and Memory projections produces byte-equivalent
  ordering and selection.
- Cross-domain corruption fails before an agent receives contradictory context.
- Decisions related only to downstream or unrelated tasks are intentionally
  absent. Future semantic retrieval must augment, not weaken, this baseline.
