# ADR-013: MCP Call Admission Boundary

Status: accepted

## Context

MCP protocol v0.3 names twelve tools, while the Hub Spike implements seven with
a hand-written validator and direct access to a Hub object. The formal package
must serve stdio and HTTP transports without trusting identity, project,
placement, causality or idempotency fields supplied by an agent.

Schema listings and runtime validation can also drift if maintained separately.

## Decision

`mcp-server` exposes one transport-neutral router:

```
authenticated transport
  └─▶ McpCallContext + tool + unknown arguments
          └─▶ strict schema parse
                  └─▶ RuntimePort method
```

`McpCallContext` is trusted transport metadata:

```
project · principal:{ kind:"agent", id } · host · clientToken · causedBy?
```

None of those fields is accepted as authority from tool arguments. The router
checks that `register_agent.id` and `send_message.from` equal the principal.
RM-1.3b adds the complete per-tool authorization matrix.

Each canonical tool has one Zod strict-object schema. Validation and exported
JSON Schema come from that same object; every listed schema has
`additionalProperties: false`. Parsed input is deeply frozen before crossing a
named `RuntimePort` method. The port owns command admission, event construction,
idempotent append and domain projections; the router owns no state and never
appends an event itself.

Unknown tools and invalid arguments become stable `McpToolError` codes.
Runtime/domain errors remain intact so transports do not erase actionable
conflict, lifecycle or routing reasons.

## Alternatives

**Copy the Spike router.** Rejected: seven tools, stale fields and direct Hub
coupling are evidence, not a formal boundary.

**Put project and identity in every input schema.** Rejected: a valid body would
still be an untrusted authority claim and retries could change their caller.

**Maintain JSON Schema beside runtime schemas.** Rejected: two sources will
drift and make discovery disagree with admission.

## Consequences

- HTTP and stdio adapters authenticate first, then call the same router.
- A client token is required transport metadata, never a tool parameter.
- Runtime methods are explicit for all twelve tools; adding a tool changes the
  protocol, schema map, port and exhaustiveness tests together.
- MCP Server can be tested with a recording port and no Event Store or vendor.
