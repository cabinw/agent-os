# Approvals

The human-in-the-loop gate. Previously implied by the principles but never
specified.

## What requires approval

| Category | Examples |
| --- | --- |
| Deployment | Ship to staging or production |
| Destruction | Delete data, drop tables, force-push, empty a bucket |
| Spending | Purchase, paid API beyond a budget, provisioning |
| External publishing | Send email, post publicly, open a PR to an upstream repo |
| Architecture | Change a decision recorded in Memory |
| Credentials | Anything requiring a secret the agent does not already hold |

Policy is per project and configurable, but the categories are not removable —
a project may raise the bar, not eliminate it.

## Flow

```
agent ── request_approval ──▶ Approval Gate ──▶ approval.requested
                                  │
                                  ├─ menu bar (✓ / ✗)
                                  ├─ Pulse: Risks & Blockers
                                  └─ Tasks: blocked badge
                                  │
                     human decides │
                                  ▼
              approval.granted / approval.rejected / approval.expired
                                  │
                       agent resumes / task stays blocked
```

The calling agent blocks. Its task moves to `blocked` with `needs: human`, so a
pending approval is visible as project state, not just a notification.

## Rules

1. **No auto-grant.** An unanswered request expires; it never proceeds by
   default. This is the whole point of the gate.
2. **No self-approval.** An agent cannot approve any request, including another
   agent's. Approval is a human act.
3. **Complete disclosure.** The request states the action, the risk level,
   whether it is reversible, and what exactly will happen. "Deploy to staging"
   is not sufficient; the commit and the blast radius are.
4. **Approval is scoped.** Granting one deployment does not grant the next.
   Standing permissions require an explicit project policy change by a human.
5. **Everything is logged.** Who approved what, when, and with what stated
   justification — it becomes part of Memory.

## Presentation

The menu-bar extra carries an Approvals section with inline ✓/✗ so a decision
takes one click without opening the app. Anything ambiguous — irreversible,
high-risk, or lacking detail — is not decidable from the menu bar and links into
the app instead.

## Rejection

A rejection requires a reason. It returns to the agent as guidance, and the task
returns to `running` so the agent can propose an alternative rather than
retrying the same action.
