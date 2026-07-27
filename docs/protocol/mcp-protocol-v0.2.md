# Agent OS MCP Protocol v0.2 Specification

## Overview

Agent OS MCP Protocol defines the communication standard between AI agents and the Agent OS runtime.

The goal is to enable different AI agents such as Claude, Codex, Cursor, Kimi, and Grok to participate in a unified AI team environment.

Core capabilities:

- Agent registration
- Capability discovery
- Task delegation
- Agent messaging
- Progress reporting
- Result reporting
- Shared context
- Human approval workflow

---

# 1. Core Objects

Agent OS MCP is built around six core objects:

```
Agent
Task
Message
Event
Resource
Memory
```

Relationship:

```
Project
  |
Goal
  |
Task
  |
Agent
  |
Event
  |
Memory
```

---

# 2. Agent Protocol

## register_agent

An agent must register before participating in a project.

Example:

```json
{
  "method": "register_agent",
  "params": {
    "id": "codex-developer",
    "name": "Codex",
    "provider": "openai",
    "role": "developer",
    "capabilities": [
      "coding",
      "testing",
      "git"
    ]
  }
}
```

## Agent Capability Discovery

Agents expose capabilities instead of being hard-coded by provider.

Example:

```
find_agent(capability="architecture")
```

This allows different providers to replace each other.

---

# 3. Task Protocol

Tasks are the primary unit of work.

## Task Lifecycle

```
CREATED
  |
ASSIGNED
  |
RUNNING
  |
BLOCKED
  |
REVIEW
  |
COMPLETED
```

## create_task

Example:

```json
{
  "method": "create_task",
  "params": {
    "id": "TASK-001",
    "title": "Implement MCP Server",
    "priority": "high",
    "executor": "codex-developer"
  }
}
```

---

# 4. Agent Communication Protocol

Agents communicate through messages.

## send_message

Example:

Claude sends implementation instructions to Codex:

```json
{
  "method": "send_message",
  "params": {
    "from": "claude-architect",
    "to": "codex-developer",
    "type": "instruction",
    "content": "Implement based on architecture specification v2"
  }
}
```

## Message Types

- instruction
- question
- answer
- progress
- report
- review
- warning

---

# 5. Progress Protocol

Agents should actively report their execution state.

## progress_update

```json
{
  "method": "progress_update",
  "params": {
    "task": "TASK-001",
    "progress": 65,
    "current_action": "Implementing MCP tools"
  }
}
```

---

# 6. Blocked Protocol

Agents must report when human or another agent intervention is required.

## notify_blocked

Example:

```json
{
  "method": "notify_blocked",
  "params": {
    "task": "TASK-001",
    "reason": "Need architecture decision",
    "severity": "high"
  }
}
```

---

# 7. Result Protocol

When a task completes, agents report outputs.

## report_result

```json
{
  "method": "report_result",
  "params": {
    "task": "TASK-001",
    "status": "completed",
    "summary": "MCP server implemented",
    "outputs": [
      "server.ts",
      "tools.ts"
    ]
  }
}
```

---

# 8. Shared Context

Agents should not work with isolated context.

Task execution can reference:

- Project documents
- Decisions
- Research
- Previous results
- Related tasks

Example:

```
TASK-001
 |
 +-- Design Document
 +-- Research Result
 +-- Previous Decision
```

---

# 9. Human Approval

High-risk operations require approval.

Examples:

- deployment
- deleting resources
- architecture changes
- external publishing

API:

```
request_human_approval()
```

---

# 10. Future Extensions

Planned capabilities:

- Agent negotiation
- Multi-agent planning
- Autonomous task routing
- Agent performance analytics
- Long-term project memory
