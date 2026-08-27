# Agent OS Development Guide

## Project Vision

Agent OS is a persistent project environment for Code Agents.

It lets humans open a real project, continue a Codex- or Claude-style Agent
conversation, observe every run, and preserve useful project knowledge across
sessions. The first-use path is one human working with one Agent; multi-Agent
coordination remains an advanced execution strategy on the existing runtime.

Herdr is a product and interaction reference only. It is not Agent OS's runtime
base or a dependency.

## Core Principles

These are constraints on every design, not slogans.

1. **MCP first.** External agent participation crosses one collaboration layer.
   Vendor-specific wake/invocation stays behind a Runner adapter; no domain or
   autonomous-routing path branches on provider.
2. **Event driven.** State changes are represented as immutable events. Nothing
   writes derived state directly.
3. **Memory first.** Decisions and knowledge must persist, with the reasoning
   attached.
4. **Human in the loop.** Irreversible actions require explicit approval.

## Core Components

- Conversation / Run — the primary human execution surface
- macOS client — the single browser/Tauri product frontend
- Supervisor Agent — optional planning and assignment strategy
- Agent Runtime — agent lifecycle and adapters
- MCP Server — the only ingress for external agents
- Event Core — the kernel
- Task Engine — optional accountable work and human acceptance
- Project Memory — durable knowledge
- Canvas / Project Pulse / Project Library — secondary project intelligence

## Repository Layout

```
docs/          specifications (see docs/README.md for the index)
ui/            high-fidelity design renders
doc.html       generated walkthrough: architecture + user guide + designs
```

## Documentation Rules

- Update related documentation in the same change as the feature.
- Add an ADR under `docs/decisions/` for any decision that constrains future
  work. Format: Context / Decision / Alternatives / Consequences.
- Keep product, protocol and design docs synchronized. If a protocol change
  makes a mockup wrong, fix the mockup reference too.
- One concept, one document. Do not create a second doc restating an existing
  one — extend the original.
- Match the existing register: terse, diagrams in ASCII, no filler prose.

## Canonical Sources

When documents disagree, these win:

| Topic | Authority |
| --- | --- |
| Task states | [docs/decisions/ADR-002-task-lifecycle.md](docs/decisions/ADR-002-task-lifecycle.md) |
| Event names | [docs/protocol/event-catalog.md](docs/protocol/event-catalog.md) |
| MCP tools | [docs/protocol/mcp-protocol.md](docs/protocol/mcp-protocol.md) |
| Navigation | [docs/product/navigation.md](docs/product/navigation.md) |
| Visual style | [docs/design/design-language.md](docs/design/design-language.md) |
| Product entry | [docs/decisions/ADR-047-code-session-first-product-entry.md](docs/decisions/ADR-047-code-session-first-product-entry.md) |
