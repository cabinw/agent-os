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

## Evidence

Measured in [apps/chat-spike](../../apps/chat-spike/FINDINGS.md), and it split
the decision in two.

**The claim holds.** Claude Code, given only the tool descriptions, registered
itself, fetched context and sent a message — three tool calls, no adapter, no
Agent OS-specific code. It also refused to work around the boundary: told to send
as another agent, it reported our refusal instead of retrying.

**But MCP ingress and MCP participation are different things.** Codex accepts an
injected server, completes the handshake and requests `tools/list`, then never
surfaces the tools to its model. Nothing is wrong with the transport; the vendor
declines to offer the tools. So "speaks MCP" does not imply "can participate,"
and the difference is a per-vendor fact — `integration.participates` in
[agent-schema.md](../protocol/agent-schema.md).

The decision survives because the fallback stays inside the boundary: when a
vendor will not call the tools, its adapter calls them on its behalf, through
the same validation. The cost of a non-participating vendor is adapter code, not
a second ingress.

## Consequences

- An agent that already speaks MCP connects with no adapter at all — demonstrated,
  not assumed.
- A vendor that will not call our tools still enters through them, via its
  adapter. There is still exactly one ingress.
- Vendor-specific code is confined to adapters, above the kernel.
- Agent OS inherits MCP's constraints; where MCP lacks something we need, we
  extend at the tool level rather than forking the transport.
- The trust boundary has exactly one location, which makes validation and audit
  tractable.
