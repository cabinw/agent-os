# ADR-001: Use MCP as Agent Communication Layer

## Decision

Agent OS uses MCP as the standard communication layer between AI agents.

## Reason

Need a provider-independent protocol that supports:

- Codex
- Claude
- Cursor
- Kimi
- Other future agents

## Alternatives

Direct provider APIs.

Rejected because each integration would require custom maintenance.

## Result

All agents communicate through Agent OS MCP services.
