# ADR-007: Implementation Stack

Status: accepted

## Context

The specs constrain the implementation more than they first appear.
[ADR-005](ADR-005-derived-state-only.md) makes every UI surface a projection of
reducers, and [ADR-004](ADR-004-capability-first-agent-catalog.md) forbids
provider names below `agent-sdk`. Together they rule out several stacks that
would otherwise be reasonable.

Three things also had to be settled before Phase 0 could start: what the desktop
shell is, whether the product is single-machine, and which model tier the
Supervisor runs on.

## Decision

**Language: TypeScript (Node 22+).** Reducers are written once and shared
between the kernel and the UI.

**Desktop shell: Tauri 2.** It satisfies the three hard requirements — a native
menu-bar extra (a peer surface per [design/menu-bar.md](../design/menu-bar.md),
not a shortcut), native window chrome, and a UI that can import the same event
types as `packages/`. Rust appears only in `apps/macos/src-tauri/` for window and
tray concerns; it never touches domain logic.

**Scope: single-machine.** One person, one Mac, one local event log. No server,
no multi-writer coordination.

**Event store: SQLite (better-sqlite3, WAL).** Append-only table, per-project
monotonic `seq`, separate snapshot table. The synchronous API keeps reducers pure
functions — an async reducer would destroy replay determinism.

**Supervisor model: `claude-opus-5`, adaptive thinking, `effort: "high"`.**
Applies to goal decomposition, memory summarization, and Pulse headline
generation alike.

## Alternatives

**SwiftUI.** The best native feel available, and rejected for exactly one
reason: the domain model and every reducer would have to be reimplemented in
Swift. Two implementations of the same reducers drift, and the drift would be
invisible until a projection disagreed with the log — which is the failure
ADR-005 exists to prevent.

**Electron.** Same capabilities as Tauri at ~15× the binary size, with nothing
gained.

**Rust for the kernel.** A good fit for `event-core` in isolation, but it forces
the UI across an IPC boundary and costs iteration speed in the adapter layer,
which is where change is most frequent.

**Postgres.** Rejected with the single-machine decision — a desktop product
should not require the user to install a database.

**Multi-writer from day one.** Rejected as speculative. The cost is real and
localized: it lands in the event store's `seq` allocation and conflict handling.

**A cheaper model tier for memory summarization.** Available as a later cost
lever, not taken now. Decomposition quality determines the quality of everything
downstream, and mixed tiers make regressions harder to attribute.

## Consequences

- **Native feel becomes design work.** Tauri renders in a WebView. Scroll
  inertia, context menus, and window behavior have to be tuned deliberately;
  budget for it rather than expecting it free.
- **The single-machine assumption is load-bearing in exactly one place.** If
  multi-user is ever needed, the change is concentrated in the event store's
  ordering and conflict model — not spread across the packages. Revisit this ADR
  rather than patching around it.
- **`event-core` must compile with no vendor SDK and no UI import.** This is
  mechanically checkable; see the layering checks in
  [development/package-development-guide.md](../development/package-development-guide.md).
- **Message content is untrusted input.** Threads render agent-authored markdown
  ([product/threads.md](../product/threads.md)); in a WebView that is an
  injection surface. Escaping is mandatory, not a hardening pass.
- Model tier is a tuning parameter, not an architectural commitment. Changing it
  does not require a new ADR.
