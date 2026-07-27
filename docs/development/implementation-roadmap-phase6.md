# Phase 6 Implementation Roadmap

## Milestone 1: Event Core

Implement:

- AgentEvent model
- Event Bus
- Event Store
- Event Replay

## Milestone 2: MCP Server

Implement tools:

- register_agent
- create_task
- assign_task
- send_message
- progress_update
- report_result
- notify_blocked

## Milestone 3: Task Engine

Implement task lifecycle:

CREATED → ASSIGNED → RUNNING → REVIEW → COMPLETED

## Milestone 4: Demo Loop

Run:

Supervisor → MCP → Codex Adapter → Event Core → Project Pulse
