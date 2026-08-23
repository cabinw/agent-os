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
| MCP Server | Authentication, principal authorization, unknown-field rejection; body caller cannot impersonate |
| Runner contract | Local and Remote transports produce the same normalized result and event sequence |
| Local Runner | Real subprocess, stable failure, workspace containment, restart-session and user isolation |
| Hub → Local Runner | Runtime-owned correlation, streaming, task review, normalized failure and queue recovery |
| Adapters | Two providers execute the same task type identically behind the Runner contract |
| Event propagation | A tool call reaches its reducer and its subscribers |
| Approval Gate | No path grants without a human; expiry never grants |

### End to end

One scenario, run through the repository gate:

```
goal → supervisor plans → task routed by capability → agent executes
     → progress events → result → review → completed
     → knowledge extracted → project status updated
```

Asserted on the resulting event log, not on screenshots.

The Local Runner is the reference implementation. The Remote Runner reruns the
same task and contract cases unchanged, then adds transport-only cases for
authentication, reconnect, duplicate delivery, timeout and cancellation.

## Repository gate

There is no hosted CI. `corepack pnpm verify` is the manual release and commit
gate: build, Biome, architectural layer checks and the full Vitest suite. Do not
copy a test count into this strategy; the command output is authoritative.

## Replay as a test

Any recorded log can be replayed against current reducers. A production log
becomes a regression test, and a reducer change that alters historical state is
caught before it ships.

## What is not tested

Agent output quality. Whether the code an agent writes is good is not this
system's assertion to make — the system tests that the work was routed,
executed, reported, reviewed and recorded correctly.
