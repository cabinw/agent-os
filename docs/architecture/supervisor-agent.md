# Supervisor Agent

The AI project manager. The only agent Agent OS runs itself; everything else
connects from outside.

## Role

```
Human ──▶ Supervisor ──▶ Agent OS Core ──▶ worker agents
   ▲                                              │
   └──────── escalation, approval requests ◀──────┘
```

Responsibilities:

- Turn a stated goal into a task graph
- Choose required capabilities per task, not specific agents
- Monitor progress and detect stalls
- Resolve or escalate blockers
- Route inter-agent questions
- Decide when work is ready for human review

## Decision loop

```
Observe ─▶ Understand ─▶ Plan ─▶ Assign ─▶ Monitor ─▶ Review ─▶ Adjust
   ▲                                                              │
   └──────────────────────────────────────────────────────────────┘
```

The Supervisor runs this loop on every significant event, not on a timer. A
`task.blocked` event triggers Understand immediately; a `task.progress.updated`
usually changes nothing.

## Planning

Goal decomposition produces tasks with dependencies, not a flat list:

```
GOAL-003 "Ship payments"
├── TASK-011 Research provider options        requires: research
├── TASK-012 Decide provider                  requires: architecture   depends: 011
├── TASK-013 Implement checkout flow          requires: coding         depends: 012
├── TASK-014 Implement webhook handler        requires: coding         depends: 012
└── TASK-015 End-to-end payment tests         requires: testing        depends: 013,014
```

The Supervisor writes a decision record to Memory whenever it chooses between
alternatives, so the plan's reasoning survives the plan.

## Escalation rules

The Supervisor escalates to a human when:

- a blocker has no agent-side resolution
- two agents disagree on a decision that changes architecture
- an action requires approval by policy
- a task fails repeatedly under different executors
- progress stalls beyond a threshold with no blocker reported

It never escalates by silently stopping. Every escalation is an event and appears
in Pulse and the menu bar.

## Constraint

The Supervisor plans and coordinates. It does not execute project work — no
writing code, no editing files. This keeps its context free for coordination and
keeps the audit trail honest about who did what.
