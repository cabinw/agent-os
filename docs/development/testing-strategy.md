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
| Write policy | Writes stay inside the selected workspace; no blanket approval; denied actions fail closed |
| Hub → Local Runner | Runtime-owned correlation, streaming, task review, normalized failure and queue recovery |
| Adapters | Two providers execute the same task type identically behind the Runner contract |
| Event propagation | A tool call reaches its reducer and its subscribers |
| Approval Gate | No path grants without a human; expiry never grants |

### End to end

The formal deterministic scenario remains:

```
goal → supervisor plans → task routed by capability → agent executes
     → progress events → result → review → completed
     → knowledge extracted → project status updated
```

Asserted on the resulting event log, not on screenshots.

ADR-047 adds a separate real-product acceptance path:

```
select fixture repository → ready fixture Agent → prompt → durable Run
  → real file change → test evidence → follow-up / cancel / terminal result
  → refresh or Hub restart → same conversation and terminal state
```

The repository gate uses the existing Local Runner and a deterministic,
write-capable subprocess fixture. It asserts event / projection evidence,
workspace contents, every readiness failure and browser discoverability. A
screenshot alone cannot satisfy it.

A separate credential-dependent field smoke runs at least one real Codex or
Claude CLI and records vendor version, authenticated identity class, selected
workspace, permission mode and resulting evidence. `pnpm verify` must never
depend on a vendor account or network response.

Conversation, Run, Vendor Session and optional Task must be tested as distinct
identities. Run completion cannot imply Task acceptance or risk approval. The
real-file-change case must prove that a scoped write policy permits the intended
edit without exposing paths outside the selected project. Two Conversations for
the same project and Agent plant different facts, switch back and prove separate
Vendor Session state across restart; Remote cases also bind host and workspace
fingerprints.

The Local Runner is the reference implementation. The Remote Runner reruns the
same task and contract cases unchanged, then adds transport-only cases for
authentication, reconnect, duplicate delivery, timeout and cancellation.

## Repository gate

There is no hosted CI. `corepack pnpm verify` is the manual release and commit
gate: build, compile-time type-contract probes, Biome, architectural layer
checks and the full Vitest suite. The repository test script caps Vitest at four
workers because several deployment cases compile or launch real subprocesses;
raising that limit can turn host contention into false timeout failures. Do not
copy a test count into this strategy; the command output is authoritative.

### macOS shell

RM-3.1 adds four proportional gates: strict navigation/token contract tests,
frontend typecheck, Vite production build, and Rust/Tauri debug no-bundle build.
Browser screenshots at 1440×900 and the 1024×720 minimum verify overflow and the
current shell contract; screenshots never replace semantic and native gates.
ADR-047 supersedes fixed-primary-sidebar acceptance for the execution home. Its
tests instead assert visible project path, Agent readiness, primary composer,
Run controls, stable `execution` shell root and access to all seven secondary
project-intelligence destinations.

## Replay as a test

Any recorded log can be replayed against current reducers. A production log
becomes a regression test, and a reducer change that alters historical state is
caught before it ships.

## What is not tested

Agent output quality. Whether the code an agent writes is good is not this
system's assertion to make — the system tests that the work was routed,
executed, reported, reviewed and recorded correctly.
