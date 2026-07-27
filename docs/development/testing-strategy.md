# Testing Strategy

## Principle

Test through observable events and outcomes. An assertion about an internal
field couples the test to an implementation that is expected to change; an
assertion about the emitted event tests the contract other components depend on.

```
given  a sequence of events
when   a tool is called
then   these events are emitted and this reduced state results
```

## Layers

### Unit

| Target | Asserts |
| --- | --- |
| Event Core | Ordering, idempotent append, replay determinism, snapshot equivalence |
| Task Engine | Every legal transition succeeds; every illegal one is rejected |
| Reducers | Same log always produces the same state |
| Agent Registry | Capability matching, saturation, disconnect handling |

The Task Engine deserves an exhaustive transition matrix — all states × all
events, including the ones that must be refused. It is small and it is the part
most likely to be corrupted by a well-meaning fix.

### Integration

| Target | Asserts |
| --- | --- |
| MCP Server | Boundary validation, unknown-field rejection, authorization |
| Adapters | Two providers execute the same task type identically |
| Event propagation | A tool call reaches its reducer and its subscribers |
| Approval Gate | No path grants without a human; expiry never grants |

### End to end

One scenario, run in CI:

```
goal → supervisor plans → task routed by capability → agent executes
     → progress events → result → review → completed
     → knowledge extracted → project status updated
```

Asserted on the resulting event log, not on screenshots.

## Replay as a test

Any recorded log can be replayed against current reducers. A production log
becomes a regression test, and a reducer change that alters historical state is
caught before it ships.

## What is not tested

Agent output quality. Whether the code an agent writes is good is not this
system's assertion to make — the system tests that the work was routed,
executed, reported, reviewed and recorded correctly.
