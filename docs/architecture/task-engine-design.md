# Agent OS Task Engine Design

## Task Lifecycle

```
Created
 ↓
Assigned
 ↓
Running
 ↓
Review
 ↓
Completed
```

## Task Model

A Task contains:

- id
- title
- owner
- executor
- progress
- status
- outputs
- related knowledge

## Purpose

Tasks are the bridge between human goals and agent execution.
