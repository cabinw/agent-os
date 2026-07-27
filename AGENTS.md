# Agent OS Development Guide

## Project Vision

Agent OS is an AI-native operating system for managing autonomous AI teams.

It lets humans define goals, coordinate agents, observe execution, and preserve
project knowledge.

## Core Principles

These are constraints on every design, not slogans.

1. **MCP first.** External agents communicate through one collaboration layer.
   No provider-specific integration path exists.
2. **Event driven.** State changes are represented as immutable events. Nothing
   writes derived state directly.
3. **Memory first.** Decisions and knowledge must persist, with the reasoning
   attached.
4. **Human in the loop.** Irreversible actions require explicit approval.

## Core Components

- Supervisor Agent — plans and assigns
- Agent Runtime — agent lifecycle and adapters
- MCP Server — the only ingress for external agents
- Event Core — the kernel
- Task Engine — the unit of work
- Project Memory — durable knowledge
- Canvas / Project Pulse / Project Library — the human surfaces

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
