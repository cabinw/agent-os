# ADR-004: Capability-First Agent Catalog

Status: accepted

## Context

The specs listed supported providers as Codex, Claude, Cursor, Kimi and Grok.
The design renders show Gemini, Perplexity and Mistral working alongside Codex,
Claude and Grok. Neither list is right for long — the set of useful agents
changes faster than a document can.

More importantly, a hardcoded list invites `if provider == …` branching, which
is exactly the coupling ADR-001 exists to prevent.

## Decision

No provider list exists in core code or in normative documentation.

- Task routing reads `capabilities` only.
- `provider` is recorded for display and billing, and is never branched on.
- The capability vocabulary is a controlled list in
  [protocol/agent-schema.md](../protocol/agent-schema.md); extending it is a
  deliberate protocol change.
- The shipped adapter set is a catalog — configuration that grows without
  touching `agent-runtime`.

## Alternatives

**Maintain a canonical supported-provider list.** Rejected: it goes stale
immediately, and its existence encourages provider-conditional logic.

**Free-text capabilities.** Rejected: `find_agent` would be doing fuzzy matching
on strings agents invent, and routing correctness would depend on spelling.

## Consequences

- Swapping a vendor is a registration change, not a code change.
- A capability that no registered agent has causes tasks to sit unassigned; the
  Supervisor must surface that rather than let them sit.
- Documentation naming specific agents is illustrative only. Any example naming
  Codex or Claude means "an agent with that capability".
