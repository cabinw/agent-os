# macOS Menu-Bar Extra

Specified from `ui/Reference/agent-os-project-panel.png`. Previously
undocumented.

## Purpose

Answer "is anything waiting on me?" without opening the app. Agent OS runs work
that continues while the user does something else; the menu bar is how that work
stays honest about needing attention.

## Icon states

| State | Icon | Meaning |
| --- | --- | --- |
| Normal | monochrome mark | Everything on track |
| Attention | mark with amber dot | A blocker exists |
| Waiting | mark with accent dot | An approval is pending |

Only pending approvals and blockers change the icon. Progress does not — a
constantly changing menu-bar icon trains people to ignore it.

When both exist, Waiting wins over Attention: a pending human decision is more
specific and directly actionable than the generic blocker state.

## Panel

```
┌──────────────────────────────────────────────┐
│ ◈ Agent OS                              ⚙    │
│ ● All systems operational                    │
├──────────────────────────────────────────────┤
│ Current Project    [ GameAI Factory    ▾ ]   │
├──────────────────────────────────────────────┤
│  6 Active Agents │ 23 Active Tasks │ 2 Blockers│
├──────────────────────────────────────────────┤
│ Agent Status                                  │
│  C Codex       ● On track  Finalizing pipeline│
│  ✳ Claude      ● On track  Implementing FSM   │
│  ✕ Grok        ● Blocked   Waiting for schema │
├──────────────────────────────────────────────┤
│ Key Blockers                        View all  │
│  World Schema unavailable                     │
│  Impact: High   Since: May 14, 4:20 PM        │
├──────────────────────────────────────────────┤
│ Approvals                           View all  │
│  Deploy Asset Pipeline to Staging      ✓  ✗   │
│  Requested by Codex · 2 min ago               │
├──────────────────────────────────────────────┤
│ Quick Actions                                 │
│  [Open Pulse] [Open Canvas] [Pause All]       │
├──────────────────────────────────────────────┤
│ Open Agent OS                             ›   │
└──────────────────────────────────────────────┘
```

Width 400pt. Sections collapse when empty — no "no blockers" placeholder rows.

## Inline approvals

✓ / ✗ immediately submit grant or reject intent through the trusted client;
successful admission emits `approval.granted` / `approval.rejected`.

Constraints:

- Rejection opens a small reason field. A rejection without a reason is not
  actionable feedback for the agent.
- Irreversible or high-risk actions are **not** decidable here. They show the
  request and a "Review in app" affordance, because a one-click destructive
  approval from a menu bar is a mistake waiting to happen.

"Immediately" describes the decision path, not a direct event write. The panel
passes an opaque approval id to the trusted application client. Rust owns tray,
panel and main-window focus only; it does not hold a human principal, replay
events or decide policy. Rejection opens the reason field before the client is
called. See ADR-028.

## Pause All

Suspends assignment across the current project: running tasks finish, nothing
new starts. The escape hatch for "stop, I need to look at this" — and it must be
reachable without opening the app, which is why it lives here.
