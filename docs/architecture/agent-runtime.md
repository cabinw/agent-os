# Agent OS Agent Runtime

## Purpose

Agent Runtime manages the lifecycle of connected AI agents.

## Agent Lifecycle

- registered
- idle
- working
- waiting
- blocked
- completed
- disconnected

## Agent Model

An agent contains:

- id
- name
- provider
- role
- capabilities
- parentAgent
- currentTask
- status

## Supported Providers

Initial targets:

- Codex
- Claude
- Cursor
- Kimi
- Grok
