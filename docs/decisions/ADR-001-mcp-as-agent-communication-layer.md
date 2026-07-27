# ADR-001: MCP as the Agent Communication Layer

Status: accepted

## Context

Agent OS must coordinate agents from multiple vendors. Each vendor exposes a
different API, with different auth, streaming, and tool-calling semantics.

## Decision

All agents communicate with Agent OS through MCP. The MCP Server is the only
ingress; there is no second integration path.

## Alternatives

**Direct provider APIs.** Rejected: every provider becomes a maintenance
obligation, and each one's quirks leak into the core. Adding a vendor would mean
changing the runtime.

**A custom Agent OS protocol.** Rejected: it would be MCP with a different name
and no ecosystem. Agents that already speak MCP would need an adapter to talk to
us, which is backwards.

## Consequences

- An agent that already speaks MCP connects with no adapter at all.
- Vendor-specific code is confined to adapters, above the kernel.
- Agent OS inherits MCP's constraints; where MCP lacks something we need, we
  extend at the tool level rather than forking the transport.
- The trust boundary has exactly one location, which makes validation and audit
  tractable.
