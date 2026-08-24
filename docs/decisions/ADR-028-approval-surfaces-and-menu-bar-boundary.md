# ADR-028: Approval Surfaces Submit Intents Through One Trusted Client

Status: accepted

## Context

ADR-015 owns blocking, human identity and atomic event admission. Phase 3 adds
an in-app decision surface and a macOS menu-bar extra. If either surface writes
events, reconstructs approval state or supplies its own human identity, it
becomes a second Approval Gate and can bypass the fail-closed contract.

The menu bar is also too small for every decision. A one-click irreversible or
high-risk grant would contradict complete disclosure, while rejecting without a
reason would remove the guidance the agent needs.

## Decision

The formal composition layer builds one immutable `ApprovalCenterView` from a
complete contiguous project history. It replays `reduceApprovalProject` and
retains request and terminal event ids as evidence. Invalid history, project
mixing, sequence gaps, duplicate event ids or missing approval attribution fail
closed. React and Rust never replay approval events.

Each approval item contains the canonical action, detail, risk, reversibility,
requester, optional task, status, timestamps and source event ids. A present
item always has a request source. A terminal item also has its terminal source.
Pending counts and menu-bar icon state are derived from these items, not stored.

Both surfaces submit only decision intent to one authenticated
`ApprovalDecisionClient`:

```
surface ── grant(id, note?) / reject(id, reason) ──▶ trusted client
                                                       │
                                                       ▼
                                                  Approval Gate
```

The client owns the trusted human principal and calls the existing Gate command
path. Surface input cannot set actor, project, task or event fields. Agent tools,
thread messages and UI copy cannot satisfy an approval.

The in-app surface shows complete disclosure and may grant any pending request.
Rejection is always two-step: choose reject, enter a non-empty trimmed reason,
then confirm. Closing the reason editor has no effect.

The menu-bar extra uses this mechanical policy:

| Request | Menu action |
| --- | --- |
| reversible and `low` or `medium` risk | grant; reject opens reason field |
| irreversible, `high` or `critical` risk | `Review in app` only |

All requests already contain schema-valid detail. The menu still shows action,
requester and risk before any quick action. Icon priority is pending approval,
then blocker, then normal. Progress never changes the icon.

Tauri owns the tray icon, 400pt panel/window lifecycle and deep link into the
main window. Rust accepts a strict presentation view model and emits an opaque
approval intent id. It contains no event schema, projection reducer, human
principal, grant/reject policy or durable state. TypeScript validates the intent
against the current pending read model before calling the trusted client.

## Alternatives

**Let Rust append approval events.** Rejected: it duplicates the Gate and moves
domain authority across the native boundary.

**Put grant/reject buttons in task conversations.** Rejected: ordinary human
guidance must never become approval authority.

**Allow all menu-bar decisions.** Rejected: compact UI cannot safely disclose
the blast radius of destructive or high-risk actions.

**Reject in one click and ask for a reason later.** Rejected: the durable event
would already lack actionable guidance.

## Consequences

- In-app and menu-bar decisions share one authorization and admission path.
- High-risk and irreversible requests require the main application.
- Menu rejection needs a temporary reason editor but no durable local state.
- A future native notification service remains presentation-only and uses the
  same opaque deep link.
