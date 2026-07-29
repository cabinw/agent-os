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

## Evidence

Four vendors were integrated behind one adapter contract and measured — see
[apps/chat-spike/FINDINGS.md](../../apps/chat-spike/FINDINGS.md). Two results
sharpen this decision:

**The decision holds.** Codex, Claude, Grok and Kimi all answered the same
prompt through the same core with no provider branching above the adapter layer.
Switching between them is a registration change, exactly as predicted.

**But capability has two axes, not one.** This ADR governs *task* capability
(coding, research…). Integration capability — can it stream tokens, does it
expose reasoning, can a session be resumed — varies independently and is not
interchangeable with it:

| | streaming | reasoning | session | usage |
| --- | --- | --- | --- | --- |
| Codex | ✅ | ❌ | ✅ | ✅ |
| Claude | ✅ | ❌ | ✅ | ✅ |
| Grok | ✅ | ✅ | ✅ | ✅ |
| Kimi | ❌ | ❌ | ✅ | ❌ |

A surface built against a single vendor bakes in assumptions that are wrong for
the others: Kimi cannot stream, so a UI that assumes deltas freezes for ~9s; Grok
streams reasoning at roughly 20:1 against its answer, so rendering it inline
buries the answer. Adapters therefore **declare** integration capability and the
UI branches on the declaration — the same principle as this ADR, applied to a
second axis. See [protocol/agent-schema.md](../protocol/agent-schema.md).

## Consequences

- Swapping a vendor is a registration change, not a code change.
- A capability that no registered agent has causes tasks to sit unassigned; the
  Supervisor must surface that rather than let them sit.
- Documentation naming specific agents is illustrative only. Any example naming
  Codex or Claude means "an agent with that capability".
- Surfaces must degrade on declared integration capability rather than assume the
  richest vendor's behaviour.
