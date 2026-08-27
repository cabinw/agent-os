# ADR-025: The macOS Shell Has One Canonical Navigation Contract

Status: accepted; landing and always-primary sidebar superseded by ADR-047

## Context

Phase 3 begins without an `apps/macos` project. The reference renders contain
conflicting sidebars, while ADR-003 resolves them to seven destinations. The
design language fixes tokens and macOS behavior, but no executable boundary
states which values are CSS authority, where Rust may appear, how routing works
before live Hub data exists, or how browser and native builds are verified.

Tauri renders a web frontend. Copying the renders without native window,
security, accessibility and density rules would produce a screenshot that does
not satisfy the desktop-shell requirement.

## Decision

### Project boundary

`apps/macos` is a pnpm workspace with React, TypeScript and Vite inside a Tauri
2 shell. Rust exists only under `apps/macos/src-tauri/` and contains Tauri
startup/window code. It imports no domain implementation, Event Store or native
SQLite driver. The frontend is now an authenticated Hub client; RM-3.1 initially
used local typed fixtures to prove shell states.

ADR-047 makes this frontend the single product client for browser development
and Tauri. The Chat Spike 4173 HTML remains a diagnostic prototype, not a second
product shell.

The Tauri window uses platform decorations and a visible native title bar,
rather than drawing traffic lights in HTML. Initial content is 1440×900, minimum
1024×720, resizable, non-transparent and system-theme aware. The capability set
is `core:default` only. No filesystem, shell, network, updater or arbitrary IPC
permission is granted in this milestone. The production content security policy
allows only the app itself; Vite development is the sole dev URL.

### Navigation

One exported immutable navigation array contains exactly, in order:

```
project-library · project-pulse · canvas · tasks · agents · memory · settings
```

Each item owns a stable id, bilingual externalized label and one local icon
identifier. Runtime, Project Info and Knowledge Graph cannot appear as top-level
items. Memory list/graph and Agents roster/threads remain internal view toggles.

RM-3.1 selected Project Library without an active project and Project Pulse with
one, with a persistent 220px sidebar. ADR-047 supersedes those entry and
hierarchy rules. The project-bound Code Agent session has stable shell-root id
`execution`, outside `NAVIGATION`. The exact seven route ids remain the
secondary project map and must stay accessible, but the execution workspace may
collapse or relocate that map at supported widths.

Browser project selection chooses only Runner-authorized `(project, host)`
placements. If the native client later adds a path picker, its filesystem/IPC
capability is narrow, introduced with ENTRY-2 and feeds Runner admission; broad
filesystem or shell access remains forbidden.

### Design tokens and components

`src/styles/tokens.css` is the only source of literal colors, gradients,
shadows, radii, type scale, motion timings, density spacing and the 220px sidebar
width. Its canonical light values match `design-language.md`. System dark-mode
overrides may change color tokens only. Components and CSS Modules consume
variables and contain no hex, rgb/hsl color or literal box-shadow values.

The 8px grid derives named spacing tokens. Comfortable is the default; compact
changes spacing variables and never hides content. Numeric UI uses tabular
figures. Status tokens are used only for real status. Focus is visible,
navigation is keyboard-operable, and every icon-only control has an accessible
name.

The RM-3.1 project-intelligence shell renders a persistent sidebar,
native-titlebar-safe content region, route heading and an honest surface state.
ADR-047 permits the execution home to collapse or relocate that sidebar while
keeping the seven routes reachable. Unimplemented destinations show a bilingual
“surface foundation ready / live projection pending” state; they do not invent
task counts, agents, risks or completion data.

### Verification

The frontend gate is TypeScript no-emit, Vitest DOM-free contract tests and Vite
production build. Static tests assert exact navigation ids/order, externalized
labels, canonical token values, no forbidden top-level destinations, no literal
component colors and no SQLite/native Hub dependency in the UI package.

ENTRY adds a separate assertion for the `execution` shell root and continued
access to all seven secondary ids. It does not add `execution` to the frozen
project-intelligence array.

The native gate is `cargo check --manifest-path apps/macos/src-tauri/Cargo.toml`
and `tauri build --debug --no-bundle`; the latter proves the production Vite
assets load through the Rust shell without requiring signing or packaging.
Browser screenshots at desktop and minimum width verify layout and overflow;
they are visual evidence, not replacements for contract tests.

## Alternatives

**Start with a web-only React page.** Rejected: the milestone explicitly owns a
Tauri shell and native window behavior is part of the risk being retired.

**Use an overlay title bar to match the render traffic lights.** Rejected:
overlay height and drag regions vary by macOS version. Real visible chrome is
the canonical native behavior; reference images remain visual guidance.

**Add React Router immediately.** Rejected for the shell foundation: seven local
route ids and in-memory selection need no dependency. URL/history integration
belongs with live Hub navigation.

**Copy color values into CSS Modules.** Rejected: design-language tokens are
canonical and literal component values guarantee drift.

**Remove the project map from the execution home.** Rejected: the seven sourced
destinations remain required. ADR-047 permits collapsing or relocating their
navigation; it does not permit making them unreachable.

**Grant broad Tauri capabilities for future work.** Rejected: permissions are
added with the feature that needs them, never speculatively.

## Consequences

- Every later human surface shares one shell, route id set and token source.
- The execution home is one additional shell root, not an eighth data domain or
  a second frontend.
- Native Rust remains auditable and cannot become a second domain layer.
- The first UI is intentionally honest and sparse; product data lands in RM-3.2+
  rather than as demo numbers that look authoritative.
- Menu-bar behavior remains a later milestone and requires an explicit
  capability/config change.
