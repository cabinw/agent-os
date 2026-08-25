# ADR-016: Agent SDK Separates Client, Runner and Adapter

Status: accepted

## Context

Phase 1.4 named one surface `register / receiveTask / reportProgress /
reportResult / sendEvent`. The measured Runner has two different directions:

```
wake         Hub ──▶ Runner ──▶ vendor
participate  vendor ──▶ MCP Server ──▶ Hub
```

Combining them creates three errors. `receiveTask` is not an MCP call,
`sendEvent` bypasses MCP admission, and an MCP-capable agent still needs a
vendor-specific wake connector.

## Decision

`agent-sdk` owns three separate contracts.

**AgentClient** is an optional convenience client for the canonical named MCP
tools. It carries no trusted project, principal, host or actor fields. Transport
authentication supplies those. It has no generic event append, task-state set
or approval-decision method.

**Runner** accepts strict `dispatch`, `cancel`, `health`, `hasSession`,
`resetSession` and `close` operations. Local and Remote implementations share
the same request, event, result and error schemas. Request idempotency and
durable terminal replay belong to the Runner, not an adapter.

**Adapter** is Runner-local. It receives a normalized prompt, workspace, model,
opaque session and scoped MCP mount; it emits only normalized
`delta | thought | progress | usage` observations and returns text plus an
opaque session id. Vendor payloads, command lines and credentials do not cross
this boundary.

The first formal adapter is the subprocess JSONL adapter seam extracted from the
Spike. A concrete adapter supplies command construction and line interpretation;
the shared implementation owns process lifecycle, absolute timeout, abort,
stderr bounding, environment filtering and result normalization.

An adapter declares integration capability:

```
participates  streaming  reasoning  session  usage
```

Task capability remains a separate Agent Catalog axis. Core routing never reads
an adapter id or provider display name.

An MCP-participating vendor calls Agent OS without translation on the
participate channel. Its wake connector may still be an adapter. A vendor that
does not participate is represented by its adapter through the same AgentClient
and MCP admission boundary; no second ingress exists.

Adapters never retry a vendor invocation. The Runner records one terminal
result for a dispatch id; a higher-level retry uses a new id linked by cause.
Vendor-specific process environment is deny-by-default. The Grok workspace
mount admits only the exact `GROK_FOLDER_TRUST=false` compatibility value;
arbitrary vendor or control-plane variables remain rejected.

## Alternatives

**One bidirectional Agent interface.** Rejected: it hides which side initiates a
call and makes transport identity easy to forge.

**Expose `sendEvent`.** Rejected: agents could bypass authorization, lifecycle
and event cross-field validation.

**Put provider branches in Runner.** Rejected: adding a vendor would change core
execution and violate capability-first routing.

**Treat MCP handshake as zero-adapter support.** Rejected: all measured vendors
handshook, but one never exposed the tools to its model.

## Consequences

- AgentClient methods remain named domain operations; MCP schemas are the
  protocol authority.
- Runner composition chooses an adapter from configuration. Hub and domain
  packages never import one.
- Adapter ids may appear in Runner operational state and session placement, not
  task truth or routing decisions.
- The subprocess seam can host additional concrete adapters without changing
  Runner or Hub code.
- Contract tests must run the same task through two adapter implementations and
  a direct MCP participant path.
