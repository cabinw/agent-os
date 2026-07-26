# Agent OS Development Guide

## Project Vision

Agent OS is an AI-native operating system for managing autonomous AI teams.

It enables humans to define goals, coordinate agents, observe execution, and preserve project knowledge.

## Core Principles

1. MCP first: external agents communicate through a common collaboration layer.
2. Event driven: state changes are represented as events.
3. Memory first: decisions and knowledge must persist.
4. Human in the loop: critical actions require approval.

## Core Components

- Supervisor Agent
- Agent Runtime
- MCP Collaboration Layer
- Agent Canvas
- Task Engine
- Project Memory
- Project Pulse

## Documentation Rules

When adding features:
- Update related documentation.
- Add an ADR for major architecture decisions.
- Keep product, protocol and design docs synchronized.
