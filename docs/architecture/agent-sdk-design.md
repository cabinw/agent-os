# Agent OS Agent SDK Design

## Purpose

Provide a standard integration layer for external agents.

## Supported Providers

- Codex
- Claude
- Cursor
- Kimi
- Grok

## SDK Responsibilities

- Register agent
- Send events
- Receive tasks
- Report progress
- Return results

## Principle

Agents should integrate through common protocols instead of custom monitoring logic.
