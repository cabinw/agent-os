# Agent OS Vision

## Definition

Agent OS is the persistent project environment for Code Agents.

The goal is not to replace a Code Agent or monitor its terminal. It is to let a
person start real work in a repository, understand and control that execution,
and retain project knowledge after any Agent session ends.

## The problem

Today a Code Agent session is a sealed room. Work happens, context accrues, and
when the window closes the next session must reconstruct what changed, why it
changed and what remains. A terminal transcript alone does not answer which
result was accepted, which test proved it or which decision still constrains the
repository.

Switching vendors or machines makes the loss visible, but multi-agent
coordination is not the first product problem. The first problem is continuity
and control for one real Code Agent run. Multi-agent work reuses the same memory,
event and approval foundation later.

## The shape of the answer

```
Project ── the repository and its durable identity
   │
Conversation ── the human-visible continuity across Agent runs
   │
Run / Task ── executable work, controlled and reviewable
   │
Events ── durable facts and sourced evidence
   │
Memory ── knowledge that answers "why", not just "what"
```

Five properties fall out of this and define the product:

- **Start with a normal Code Agent interaction.** Project, Agent, prompt.
- **Nothing happens invisibly.** If it is not an event, it did not happen.
- **State is derived.** Every view is a projection of the log, so history is
  always reconstructable.
- **Sessions are optimizations, not memory.** Correctness survives a cold Agent.
- **The system stops for humans.** Deployment, deletion, spending, publishing —
  the agent asks first.

## Core experience

A user opens Agent OS and can immediately:

- open a real project and address a ready Codex or Claude Agent
- watch what it is doing and where the evidence came from
- guide, stop or resolve a blocked run
- inspect changed files and tests before accepting a result
- reopen the project later with its decisions and accepted knowledge intact

Project Pulse, Tasks, Agents, Memory and Canvas explain and manage the same
execution history. They surround the Code Agent session; they are not a
prerequisite for starting it. See
[ADR-047](decisions/ADR-047-code-session-first-product-entry.md).

## Evolution

```
Code Agent → Observable Project Session → Persistent Project Memory → Agent OS
```

The current target is the second step using the already implemented Hub / Runner
substrate. Durable memory then differentiates the product; multi-agent depth is a
later execution strategy, not a new foundation.
