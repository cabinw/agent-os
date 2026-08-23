# Package Development Guide

## Build order

```
event-core → task-engine → mcp-server → agent-sdk → memory-core → apps/macos
```

Follows the dependency direction in
[architecture/packages.md](../architecture/packages.md). Building out of order
means writing against contracts that do not exist yet, and the usual result is a
package that stores its own state to compensate.

This is the formal package dependency order. The current executable-spike track
comes first: `Local Runner → shared contract → Remote Runner`. It proves the
execution boundary before that contract moves into `agent-sdk`; see
[ADR-008](../decisions/ADR-008-server-hub-local-first-runners.md).

## Rules

1. **Contract before implementation.** The exported API goes in
   `architecture/packages.md` before it is written.
2. **Packages stay independent.** No package imports a sibling's internals.
   `task-engine` and `memory-core` must not import each other at all.
3. **No provider names below `agent-sdk`.** If `event-core` or `task-engine`
   contains the string "openai" or "anthropic", something is wrong.
4. **No stored derived state.** If a value can be reduced from the log, reduce
   it. See [ADR-005](../decisions/ADR-005-derived-state-only.md).
5. **Tests ship with the feature**, not after it.
6. **Update docs in the same change.** A protocol change that lands without its
   doc is incomplete work.

## Adding an event type

1. Add it to [protocol/event-catalog.md](../protocol/event-catalog.md) with its payload
2. Add or extend the reducer that consumes it
3. Add a replay test asserting the state it produces
4. Only then emit it

Events are permanent. A type that ships wrong stays in old logs forever, so the
catalog entry is the design review.

## Adding an MCP tool

1. Specify it in [protocol/mcp-protocol.md](../protocol/mcp-protocol.md), including
   the event it emits
2. Implement validation at the MCP Server boundary — reject unknown fields
3. Implement the handler; it requests, it never writes state
4. Add an integration test driving the tool from outside the process

## Adding an adapter

Adapters are Runner-side configuration. Implement the Agent SDK surface,
register capability for `(agent, host)`, ship it. If adding an adapter requires
touching Hub routing, the abstraction has leaked — fix that instead.

## Adding a Runner transport

1. Pass the shared contract suite against the Local Runner.
2. Keep dispatch, event, cancellation and error shapes unchanged.
3. Add only transport auth, serialization, reconnect and liveness behavior.
4. Run the same real-CLI acceptance task through both transports and compare the
   normalized event sequence.
