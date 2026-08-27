# ADR-047: Product Entry Is a Project-Bound Code Agent Session

Status: accepted

## Context

The executable Hub, Local / Remote Runner contract, vendor adapters, authenticated
event stream and durable vendor sessions already run real Codex, Claude, Grok and
Kimi work. Productization then put seven event-derived management surfaces in
front of that runtime and landed active projects on Project Pulse.

That shell answers what happened after work is running. It does not answer the
first-use question: how does a person start a Code Agent in this repository?
`New task` currently asks for a title and free-form capabilities, then hides
creation, placement, dispatch and start behind one request. A user can create a
task without understanding whether any executable agent is ready or what action
comes next.

Herdr and conventional Code Agent products show the familiar interaction model:
select a working context, address an agent and start with a prompt. Herdr is a
product reference only. Agent OS already owns its execution substrate in
`apps/chat-spike`, the Runner contract and the Hub; adding another runtime below
them would duplicate completed work.

## Decision

The default product entry is a project-bound Code Agent session:

```
open project → select ready agent → prompt → observe execution → guide / stop
             → inspect diff and tests → accept linked Task when applicable
             → retain project memory
```

- The existing Chat Spike / Hub / Runner / adapter chain remains the executable
  substrate. `apps/chat-spike` owns that backend composition and its 4173 page
  remains a diagnostic prototype. `apps/macos` is the one product client at
  5173 and in Tauri. The refactor reuses measured Spike behavior; it does not
  copy its UI/reducer, replace the Runner contract or introduce Herdr.
- The execution home has stable shell route id `execution`, outside the frozen
  seven-item secondary navigation array. It is the shell root, not an eighth
  project-intelligence destination.
- Local mode comes first. A user selects a project, sees the ready Codex / Claude
  agents and can send a prompt without first learning Task, capability or MCP
  terminology.
- Project has a stable id. Working-copy authority remains a Runner placement:
  `(project, runnerHost) → canonical local path`. A browser selects only
  Runner-authorized placements and never sends an arbitrary absolute path to
  the Hub. Tauri may register a path only through narrow feature-owned IPC and
  the same Runner containment checks.
- Ready means more than installed: the selected placement is reachable and
  accepting, the adapter executable is canonical, vendor authentication passes
  a non-mutating preflight, the workspace is authorized and the permission mode
  can perform the requested class of work. Each fact is sourced and observed;
  failure produces an actionable diagnosis rather than a failed first Run.
- The implementation must distinguish a user-visible Conversation, one prompt's
  executable Run, the Runner's opaque Vendor Session and an optional accountable
  Task. Vendor Session is an optimization; Run needs a durable terminal fact;
  Task review is not required for every conversational turn.
- Vendor Session ownership is scoped by visible Conversation:
  `(user, project, conversation, agent)`. A new Conversation starts fresh unless
  an explicit migrated/default Conversation owns the legacy
  `(user, project, agent)` placement. Two Conversations must never share hidden
  vendor context by accident.
- One primary agent owns the visible session. Tasks and capability routing remain
  durable runtime semantics but may be created or selected behind the session.
  Multi-agent delegation is an execution strategy, not first-use configuration.
- A human may explicitly choose Codex or Claude for an interactive session. That
  product choice does not change capability-based Task routing or permit provider
  branches below the adapter / integration layer.
- The primary surface shows the transcript plus structured execution evidence:
  agent state, tool / command activity, changed files, tests, approvals, failures
  and the next available human action.
- Refresh and restart restore the project session from durable events and vendor
  session placement. A new vendor session receives relevant project memory; it
  does not depend on a resident model process for correctness.
- Project Pulse, Library, Canvas, Tasks, Agents, Memory and Settings remain
  sourced project-intelligence views. They are secondary navigation around the
  execution workspace, not the landing contract.
- The formal packages remain canonical for event, task, authorization, memory and
  approval semantics. The executable composition must converge on those
  contracts instead of copying a second domain model into the UI. In particular,
  `packages/task-engine/src/conversation.ts` remains the canonical existing
  thread reducer; Spike `src/thread.mjs` is not promoted.
- New Conversation / Run commands append canonical v1 events to the formal Event
  Store as their only durable truth. A Hub-side application / read-model adapter
  applies formal reducers and streams a typed, sourced projection to
  `apps/macos`; the client neither imports domain implementation nor reduces raw
  events. Pre-v1 Spike JSONL remains read-only diagnostic history: there is no
  dual write or implicit conversion. A later import requires an explicit,
  versioned migration decision.
- Run completion, Task result acceptance and approval of a risky action remain
  separate facts. Finishing a prompt neither completes a Task nor grants an
  approval implicitly.

This decision supersedes only the landing and always-primary-sidebar parts of
ADR-003 and ADR-025. Their destination ownership, route identities and design
tokens remain valid for the secondary project-intelligence surfaces.

## Alternatives

**Keep Project Pulse as the active-project landing page.** Rejected: Pulse is a
read model for work already in flight and produces an empty observation surface
before the first Agent run.

**Keep `New task` as the primary entry.** Rejected: it exposes internal
orchestration before the user has established a working session and makes
execution readiness invisible.

**Build on Herdr.** Rejected: Herdr is useful interaction and market evidence,
but Hub, Runner, adapters, sessions and local / remote execution are already
implemented here. A hard dependency would duplicate and constrain the execution
plane.

**Rebuild the runtime while redesigning the UI.** Rejected: the measured Chat
Spike path is the strongest existing asset. The first milestone changes the
product entry while preserving its authenticated, tested dispatch path.

**Evolve both 4173 and 5173 into product clients.** Rejected: two composers and
two reducers would immediately disagree on recovery, Run state and navigation.
The Spike page stays diagnostic; `apps/macos` owns the product.

**Let the browser submit a repository path.** Rejected: a remote browser path is
meaningless on a Runner and an untrusted absolute path breaks workspace
containment. The Runner authorizes `(project, runnerHost)` placements.

## Consequences

- `apps/chat-spike` changes from protocol-only evidence to the backend and
  interaction reference for the product entry refactor. Throwaway storage,
  diagnostic HTML and pre-formal domain shapes do not become canonical.
- `apps/macos` no longer treats Pulse plus a global `New task` button as the
  first-use acceptance path. It owns the execution home and keeps existing
  sourced views reusable as secondary routes.
- The first acceptance test begins at an empty local session and ends with a real
  Codex or Claude result plus visible execution evidence. Task acceptance and
  risk approval are exercised only when their separate semantics apply.
- Remote Runner and multi-agent work remain supported but do not block the local
  single-agent entry milestone.
- A visually complete dashboard without a runnable project session is not a
  completed product experience.
