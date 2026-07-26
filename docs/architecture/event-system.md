# Agent OS Event System

## Overview

Agent OS uses an event-driven architecture. All agent actions, task changes, communication and knowledge updates are represented as events.

## Flow

Agent

↓

Event Bus

↓

Event Store

↓

State Reducer

↓

Canvas / Project Pulse / Memory

## Event Examples

- agent.registered
- task.created
- task.assigned
- task.progress.updated
- message.sent
- agent.blocked
- task.completed
- knowledge.created
- news.generated
