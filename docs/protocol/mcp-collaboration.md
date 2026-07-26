# MCP Collaboration Protocol

## Purpose

Provide a common communication layer between AI agents.

## Core Operations

- register_agent
- create_task
- assign_task
- send_message
- progress_update
- report_result
- notify_blocked
- request_approval

## Example

Claude designs a solution.

Claude assigns implementation to Codex.

Codex executes, reports result, and Claude reviews the output.

## Principle

Agents should communicate through structured events instead of isolated conversations.
