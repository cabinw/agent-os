# Memory

The answer to "what do we know, and why?". Memory owns two first-class views;
Knowledge Graph is not a destination.

## Header

```
[ List | Graph ]  [ search ]  [ type ]  [ status ]  result count
```

The controls filter one ordered `queryMemory` result. Switching views never
changes the query or silently drops superseded knowledge.

## List

Cards show type, stable id, title, summary, rationale, creation time, status,
relation count and source events. Superseded cards remain visible by default
and recede in opacity.

## Graph

Knowledge nodes are laid out by type and creation order. Relations come from
the semantic descriptors returned beside each query result:

```
related-task · supersedes · knowledge.linked label
```

These are domain assertions, not Canvas execution causality. `causedBy` edges
never appear here. Duplicate descriptors collapse to one edge; the inverse
`superseded-by` descriptor normalizes to the replacement's `supersedes` edge.

Task and general entity endpoints use stable ids when no canonical title is
available. Selecting a node or edge opens source evidence in the right
inspector. Filtered-out knowledge can appear only as an id-only relation context
endpoint, never as an invented card.

## Empty states

No project projection shows a sourced empty state. A non-empty projection with
no filter matches shows a distinct filter empty state. Neither creates sample
knowledge.
