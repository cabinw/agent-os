# Agent OS Phase 6 Core Bootstrap

## Goal

Move Agent OS from architecture specification into a runnable core prototype.

The first objective is not a complete product UI. The objective is to establish the Agent OS execution loop:

User Goal → Supervisor → MCP Server → Agent → Event Core → Task State → Project Pulse

## Scope

Phase 6 creates the foundational packages:

- event-core
- mcp-server
- agent-sdk
- task-engine
- memory-core

## First Demo

Claude/Supervisor creates a task.

Agent OS assigns the task to Codex.

Codex reports progress and completion.

Agent OS stores events and updates project status.
