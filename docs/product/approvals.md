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

The Approval has an opaque subject id allocated before append; it is not the
request event's envelope id. Task-scoped admission is one atomic command:
`approval.requested + task.blocked`. Grant/reject atomically include
`task.unblocked`; expiration does not, so the task stays blocked. See ADR-015.

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

`approval.requested` always includes `detail`; omission is not a lower-risk
request, it is invalid. `approval.expired.after` is the planned RFC3339 deadline,
while envelope `at` is when the expiration was recorded.

V1 does not store that deadline on the request, so the Phase 1 CLI Gate schedules
it only for the current process. Restarted requests remain pending and blocked;
they are never granted or assigned a reconstructed deadline. Durable timer
recovery requires a future event version.

## Presentation

The menu-bar extra carries an Approvals section with inline ✓/✗ so a decision
takes one click without opening the app. Anything ambiguous — irreversible,
high-risk, or lacking detail — is not decidable from the menu bar and links into
the app instead.

The application does not add an eighth top-level destination. A pending
approval opens an Approval Center surface from Pulse, Tasks, a thread divider or
the menu bar and preserves the current project context.

The composition layer supplies an immutable sourced view. Every approval keeps
the `approval.requested` event id; a terminal approval also keeps its decision
event id. React does not replay events or infer attribution. Both the in-app and
menu-bar surfaces submit only an opaque approval id plus note or rejection
reason to one trusted decision client. The authenticated human principal and
event admission stay behind that client; see ADR-028.

The in-app surface shows action, full detail, risk, reversibility, requester,
task attribution and evidence before a decision. An irreversible, high or
critical request always deep-links here. Closing the view never changes durable
state.

## Rejection

A rejection requires a reason. It returns to the agent as guidance, and the task
returns to `running` so the agent can propose an alternative rather than
retrying the same action.

Every rejection surface is two-step. Selecting reject reveals a reason field;
only a non-empty trimmed reason enables confirmation. Cancelling that editor is
a no-op. Conversations contain an approval divider and link only — message
input never renders grant or reject controls.
