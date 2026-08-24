# ADR-024: Memory Query Separates Semantic Relations from Causal Edges

Status: accepted

## Context

The v0.3 `query_memory` input requires free text and can only add a knowledge
type. RM-2.5 also requires time and relation queries. The Memory projection
currently ignores `knowledge.linked`, while the event catalog defines it as an
explicit semantic relation between a knowledge item and a general entity.

Canvas and the Roadmap separately require graph edges to derive from event
`causedBy`. Treating `knowledge.linked` payload endpoints as causal edges would
make authored labels look like execution history. Treating `causedBy` as a
semantic assertion would make “triggered by” mean “validates” or “supersedes”.

Event Core validates the shape of `causedBy` but deliberately cannot prove that
the referenced event exists earlier in the same project. A graph built from
unvalidated partial history could therefore contain dangling or future edges.

## Decision

### Memory projection and semantic relations

The Memory projection contains immutable `items` and `relations` maps. A
`knowledge.linked` event adds one relation keyed by its event id:

```
event · seq · knowledge(subject) · from · to · relation · at · actor
```

The event subject must identify an already-created knowledge item and equal one
payload endpoint. The other endpoint remains a general entity id, as required
for knowledge-to-measurement and knowledge-to-task links. The relation label is
preserved exactly; it is not parsed from text or normalized. Missing knowledge,
subject/endpoint disagreement, duplicate relation event identity and a relation
before the knowledge item's creation fail replay. Existing item and
supersession rules remain unchanged.

The strict snapshot parser validates exact fields, project identity, unique
event/sequence identity and the same endpoint invariant. The reducer snapshot
version advances because old snapshots are discardable caches; replay from
events remains authoritative.

### Query

`query_memory` accepts these optional selectors:

```
q · type · after · before · relatedTo · relation · status
```

`after` and `before` are inclusive RFC3339 instants and `after <= before`.
`status` is `active | superseded | all` and defaults to `all`, preserving the
requirement that superseded knowledge remains readable. Empty input lists all
knowledge. There is no hidden count limit.

All supplied predicates are ANDed. Text is a deterministic case-insensitive
substring over title, summary, rationale and alternatives. Time compares the
knowledge creation instant. `relatedTo` matches canonical `relatedTasks`, the
supersession predecessor/successor, or an endpoint of `knowledge.linked`.
`relation` matches the built-in labels `related-task`, `supersedes`,
`superseded-by`, or an explicit `knowledge.linked.relation`. When both relation
selectors are supplied, the same relation must satisfy both. Results are
ordered by `createdSeq`, then knowledge id and contain the matching item plus
the deterministic relation descriptors that justified a relation match.

The pure query reparses the Memory snapshot and returns deeply frozen data. MCP
authenticates the project and invokes it through `RuntimePort.queryMemory`; an
agent never supplies a projection, event envelope or project authority.

### Causal graph

`buildMemoryGraph(history)` accepts complete contiguous project history from
sequence 1. It strictly reparses every event, requires one project, unique ids,
contiguous increasing sequence and every `causedBy` to reference an earlier
event in that history. Partial, cross-project, missing, future and self causes
fail closed.

Every stored event becomes an immutable graph node. Every event with
`causedBy` contributes exactly one edge:

```
from = child event id · to = cause event id · relation = causedBy
```

Nodes and edges are sequence ordered. No caller or projection writes a causal
edge. `knowledge.linked` records are exposed separately as semantic relations;
their payload endpoints never enter the causal edge array. UI layers may filter
or aggregate this lossless graph but may not change its provenance.

## Alternatives

**Use `knowledge.linked` as the graph edge.** Rejected: it is an explicit domain
assertion, not proof that one event triggered another.

**Infer semantic relations from `causedBy`.** Rejected: causation has no label
such as “validated-by” and cannot replace the catalogued relation event.

**Query a second memory table.** Rejected: items and relations are projections;
the event log remains the only durable source.

**Default to active knowledge only.** Rejected: it would make superseded history
silently disappear from the primary query API.

**Accept a result limit.** Rejected for v1: no measured relevance policy exists,
and recency truncation already failed the context design review.

## Consequences

- Type, time and relation queries compose without hidden ranking.
- Explicit semantic links remain auditable through their event identity.
- Causal graph edges are replay-derived and cannot drift from the event log.
- Complete-history validation costs a full scan; incremental graph caching may
  optimize later but must produce the same ordered result.
