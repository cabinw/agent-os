# Agent OS Vision

## Definition

Agent OS is the operating system for AI-native teams.

The goal is not to monitor agents. It is to let an AI team collaborate, execute,
and accumulate knowledge that survives the end of any conversation.

## The problem

Today an AI agent session is a sealed room. Work happens, context accrues, and
when the window closes it is gone. Ask an agent three months later why the
project uses PostgreSQL and it has no idea — the reasoning was never anywhere
but in a transcript nobody kept.

Multiply that by five agents from five vendors and there is no shared state at
all: no common task list, no way for one agent to hand work to another, no
record of who decided what.

## The shape of the answer

```
Goal ─── stated once by a human
  │
Tasks ── planned by the Supervisor, executed by whichever agent has the capability
  │
Events ─ every action, immutable, replayable
  │
Memory ─ summarized into knowledge that answers "why", not just "what"
```

Four properties fall out of this and define the product:

- **Any agent can do any task it is capable of.** Capability, not vendor.
- **Nothing happens invisibly.** If it is not an event, it did not happen.
- **State is derived.** Every view is a projection of the log, so history is
  always reconstructable.
- **The system stops for humans.** Deployment, deletion, spending, publishing —
  the agent asks first.

## Core experience

A user opens Agent OS and immediately knows:

- what the AI team is doing right now
- why it is doing that
- how the agents are coordinating
- what knowledge was produced
- where a human decision is required

## Evolution

```
Agent Monitor → Agent Canvas → Agent Collaboration Platform → Agent OS
```

The current target is the third step, built so the fourth is reachable without
re-founding the architecture.
