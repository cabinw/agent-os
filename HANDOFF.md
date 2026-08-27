# Agent OS handoff

Updated 2026-08-27 for the next Agent taking over cold.

## Read this first

The product direction changed after real first-use testing. Do not continue
polishing the dashboard-first flow as if the product were complete.

The new primary objective is:

> Turn the existing Chat Spike / Hub / Runner runtime into a project-bound,
> Codex / Claude-style Code Agent session with durable memory, structured
> execution evidence and explicit human control.

Four boundaries are settled:

1. `apps/chat-spike` plus the existing Hub, Local / Remote Runner contract and
   adapters are the execution substrate. Do not rebuild them for this milestone.
2. Herdr is an interaction and market reference only. It is not a dependency or
   a replacement Runner.
3. Multi-agent routing remains available below the product, but the first-use
   entry is one project, one visible Agent and one prompt. Multi-agent setup is
   not the user's first task.
4. `apps/macos` is the single product client at `localhost:5173` and in Tauri.
   `apps/chat-spike` remains the executable Hub / Runner composition plus a
   diagnostic 4173 prototype; reuse its measured interaction, not its UI or
   approximate domain reducer.

The constraining decision is
[ADR-047](docs/decisions/ADR-047-code-session-first-product-entry.md).

## Five-minute orientation

From the repository root:

```bash
git status --short --branch
git log -5 --oneline --decorate
corepack pnpm verify
```

Then read, in order:

1. this file
2. [ADR-047](docs/decisions/ADR-047-code-session-first-product-entry.md)
3. [Chat Spike README](apps/chat-spike/README.md)
4. [measured vendor findings](apps/chat-spike/FINDINGS.md)
5. [formal thread reducer ADR](docs/decisions/ADR-018-thread-projection-attribution.md)
6. [Hub / Runner ADR](docs/decisions/ADR-008-server-hub-local-first-runners.md)
7. [memory architecture](docs/architecture/memory.md)
8. [product navigation](docs/product/navigation.md)

Do not use `doc.html`, `todo.html` or the high-fidelity `ui/` renders to infer
the next product entry. They are historical design and planning artifacts until
regenerated against ADR-047. `next.html` is now only a migration page pointing
to the live board and this handoff.

## Source control state

At handoff preparation:

| Item | Value |
| --- | --- |
| Repository | `https://github.com/cabinw/agent-os.git` |
| Branch | `codex/project-control` |
| Tracking | `origin/codex/project-control` |
| Parent before handoff docs | `200db53` |
| Production product source | `5829999` (`5829999-product-v1`) |
| Branch vs `origin/main` | 406 commits ahead, 0 behind at audit time |

GitHub's default `main` page does not contain this branch's current work. Keep
changes on `codex/project-control` unless the user chooses another branch. Use
small, single-purpose commits and push each reviewable slice. Do not merge to
`main` or force-push.

The working tree contains three pre-existing untracked directories:

```text
.production-release-output/
.windows-field/
codex/
```

They contain field artifacts and separate user work. Do not add, delete, clean,
move or reformat them. In particular, never commit deployment archives,
credentials or `.windows-field/agent-os-hub-secrets.cms`. `.agent-os/local/` is
ignored local product state; do not clear it during ordinary UI development.
`biome.json` excludes all four local/field roots so `pnpm verify` can run without
touching them; that lint exclusion is not permission to add them to Git.

## What already works

The execution foundation is not the missing product feature. Keep wired runtime
facts separate from formal components that the live composition has not adopted.

### Wired in the live Hub / Runner composition

| Capability | Current implementation / evidence |
| --- | --- |
| Real vendor execution | Codex, Claude, Grok and Kimi adapters under `apps/chat-spike/src/adapters/` |
| Local execution | `apps/chat-spike/src/runners/local.mjs` |
| Remote execution | `remote.mjs`, `runner-worker.mjs`, outbound Worker transport |
| Stable Runner semantics | request idempotency, sessions, cancellation, health, errors and recovery |
| Hub trust boundary | human / Agent / Runner principals, secure web sessions, exact Origin checks |
| Agent participation | authenticated MCP bridge and strict tools |
| Task semantics | lifecycle, routing, review and human acceptance |
| Existing local client | authenticated Hub client, Pulse, Tasks, Agents and thread views in `apps/macos` |
| Deployment | authenticated Ubuntu Hub and Windows Remote Worker paths with signed release tooling |

### Implemented formally, not fully wired into the direct conversation

| Capability | Current implementation / gap |
| --- | --- |
| Event durability | Formal Event Core, SQLite Store, strict replay and snapshots exist; Spike production composition still has JSONL / ACK debt |
| Thread projection | Canonical reducer is `packages/task-engine/src/conversation.ts`; Spike `src/thread.mjs` is diagnostic only |
| Task dependency graph | Formal Task Engine enforces graph semantics; the live Spike task path does not yet expose that graph |
| Memory | Extraction, causal windows, supersession, query and graph packages exist; direct `/say` does not consume the full path |
| Human surfaces | Library, Canvas, formal Memory and approvals exist in `apps/macos`; production serves the simpler Spike page |

The board's previous 100% meant that the former roadmap and deployment
acceptance were complete. It did not prove first-use product usability. The new
entry track intentionally reopens overall product progress.

## What is wrong today

`pnpm experience` currently lands an active project on Project Pulse and exposes
a global `New task` action. That flow is observation-first:

```text
Pulse → New task → free-form capabilities → hidden auto-assignment → wait
```

It has eight product defects:

- the user cannot start from a normal Code Agent prompt;
- the local launcher pins work under `.agent-os/local/workspaces/<agent>` rather
  than opening the user's selected repository;
- the Hub is one hard-coded `proj_hub` with one event log, and dispatch uses the
  Agent id as `workspace`; project selection is not a UI-only path change;
- the Codex adapter is explicitly `read-only` / `approval-policy: never`, while
  the Claude subprocess has no product-level write-permission contract; neither
  proves a safe code-editing experience yet;
- readiness currently proves little beyond executable discovery; it does not
  jointly prove vendor authentication, Runner availability, workspace authority
  and usable permission mode;
- vendor sessions are keyed by `(user, project, agent)`, so two future visible
  Conversations would share model context unless ENTRY-1 isolates them;
- task creation hides placement, dispatch and start, then offers few recovery
  actions outside Review;
- Tasks, capabilities and multi-agent concepts appear before the user has one
  successful local Agent run.

The existing UI is useful as a sourced management surface. It is not the target
entry and should not be incrementally patched into one by adding more hints to
the task modal.

Production currently serves `apps/chat-spike/public/index.html`; the richer
Vite / macOS shell is local. A successful Hub deployment is therefore not proof
that the rich product shell is available online.

## Product objects to settle before UI work

The current code has a project/task thread, a Runner-owned vendor session and a
Task lifecycle. `packages/task-engine/src/conversation.ts` calls its derived
thread collection `ConversationProjectState`, but it still has exactly one
project thread plus task threads; it is not yet the user-visible Conversation
identity described below. A conventional Code Agent entry needs four distinct
concepts. Do not collapse them into another overloaded `task` object or assume
the existing type name closes the gap:

| Concept | User meaning | Durability / authority |
| --- | --- | --- |
| Conversation | A named, reopenable project interaction | Event-derived human surface |
| Run | One prompt execution with active, blocked and terminal facts; exact state names are ENTRY-1 work | Runtime-owned durable lifecycle |
| Vendor session | Opaque Codex / Claude continuation handle | Runner operational optimization |
| Task | Optional accountable unit of work with review and dependencies | Formal Task Engine projection |

The first implementation decision must define their identity and relationships.
The Vendor Session scope must become `(user, project, conversation, agent)` or a
new Conversation must force a fresh session; it may not silently reuse the
legacy `(user, project, agent)` handle. Preserve old state through an explicit
legacy/default Conversation rule rather than guessing. Direct `/say` can wake an
Agent, but today it has no complete durable start,
failure or cancellation lifecycle; `/cancel` is task-only. A UI-only wrapper over
`/say` would look correct until refresh and then lose the authoritative run
state. Freeze this contract before styling the new composer.

## Target first-use flow

The next product slice is deliberately narrow:

```text
open / select project from Runner-authorized workspaces
  → resolve `(project, runnerHost)` working-copy placement
  → detect ready local Agents
  → select Codex or Claude (sensible default)
  → enter a prompt
  → create a durable Run through the existing Hub / Runner path
  → stream Agent output and structured execution state
  → user can guide, stop or answer a blocking request
  → inspect changed files and tests
  → explicitly accept the result only when the Run represents a Task
  → restore the same project conversation after refresh / restart
```

Tasks may be created behind this interaction, but the user must not need to type
capabilities or understand Task / Runner / MCP terminology to begin.

## First implementation milestone

Name the board track `ENTRY`. Complete it in this order.

### 1. Freeze the session and Run contract

- Define identities and transitions for Conversation, Run, Vendor Session and
  optional Task linkage.
- Isolate Vendor Sessions by Conversation and test A/B Conversation context
  separation, switch-back recovery and Remote placement fingerprints.
- Define one UI model for project, selected Agent, readiness, transcript,
  execution state, approvals, changed files, tests and terminal outcome.
- Derive durable fields from events. Keep streaming previews explicitly live-only.
- Decide the narrow command used by the first prompt. Reuse the existing
  authenticated Hub and Runner path instead of introducing another transport.
- Keep human acceptance outside MCP.

Begin ENTRY-1 with a focused ADR that fixes identity, transitions, terminal facts
and the legacy-session rule. Then update the event catalog, reducer and replay
tests before adding emitters. These are permanent behavior contracts, not an
optional documentation follow-up.

### 2. Keep one product client

- `apps/macos` owns the product UI: browser development at 5173 and the Tauri
  window. Add the stable shell-root route id `execution`; keep the seven current
  route ids as secondary project intelligence.
- Use `apps/chat-spike/public/index.html` only as measured interaction and
  diagnostic evidence: Agent targeting, prompt delivery, streams and review.
  Do not expand it into a second product client.
- Reuse `apps/macos/src/HubProduct.tsx` authentication and SSE transport. A
  Hub-side application / read-model adapter applies the formal reducer and sends
  a typed, sourced projection; React consumes that projection and does not import
  domain implementation or reduce events itself.
- New Conversation / Run commands append canonical v1 events to the formal
  Event Store as their only durable truth. Pre-v1 Spike JSONL remains read-only
  diagnostic history in this slice: do not dual-write it, feed it into a v1
  reducer or silently convert it. Any later import is an explicit, versioned
  migration decision.
- Keep `packages/task-engine/src/conversation.ts` canonical for the existing
  thread projection; do not promote Spike `src/thread.mjs` or copy another
  reducer into the product client. ENTRY-1 adds the missing Conversation / Run
  contract at the server-side formal seam.

### 3. Deliver one real local vertical slice

- Start from an empty local project conversation.
- Give Project a stable id and register `(project, runnerHost) → canonical
  working-copy path` through a trusted Runner-side port. A browser may select
  only pre-authorized placements; it never sends an arbitrary absolute path to
  the Hub. A Tauri picker may authorize a path only through narrow IPC added by
  this feature.
- Support independent readiness probes for Codex and Claude, but show only
  Agents actually usable in the current environment. Ready means executable,
  authenticated, Runner-connected, workspace-authorized and able to accept
  work; busy/unavailable states retain source and observation time.
- Submit one prompt and prove a real vendor process executes in the selected
  workspace through `LocalRunner`.
- Define and test a workspace-scoped write policy for at least one Agent. Do not
  replace the current read-only safety with a global auto-approve flag.
- Show the Run's non-terminal, blocked and explicit terminal facts without
  deriving lifecycle from a percentage; ENTRY-1's ADR chooses their exact names.
  When a Run is linked to a Task, show Task Review / Completed as a separate
  lifecycle.
- Support follow-up instruction, stop / cancel and human accept / return.
- Restore the transcript and Run / Task state after a Hub restart.

### 4. Add evidence before breadth

- Surface commands / tool activity without leaking secrets.
- Show changed files and a diff summary from a trusted Runner-side collector.
- Show test command, outcome and source event / execution evidence.
- Connect accepted outputs and decisions to the existing memory path; the formal
  memory package existing is not proof that the live Spike composition uses it.

Do not start remote-entry UX or multi-agent team configuration until this local
slice passes the acceptance below.

## Acceptance criteria

The milestone is complete only when a fresh user can perform this journey
without documentation:

1. Open `http://localhost:5173/`.
2. Select an actual Runner-authorized repository and see which supported Agent
   can run, with actionable reasons for every non-ready state.
3. Enter one natural-language request in the primary composer.
4. Observe a real Agent start inside that repository.
5. Understand what it is doing and whether it is waiting, blocked or failed.
6. Send a follow-up or cancel the Run.
7. Inspect the produced file changes and test result.
8. Accept or return a Task result only when review applies.
9. Refresh or restart and recover the durable conversation and outcome.
10. Start a new vendor session that receives relevant project memory.

Required automated evidence:

- focused reducer / view-model tests for every displayed state;
- Hub security tests proving no bearer reaches URL, storage, logs or Agent output;
- deterministic gate tests using a write-capable subprocess fixture, including
  workspace escape and Conversation A/B session isolation;
- a credential-dependent field smoke for at least one real Codex or Claude CLI,
  recording version, workspace, permission mode and resulting evidence without
  making `pnpm verify` depend on a vendor account;
- browser acceptance at normal and minimum supported widths;
- final `corepack pnpm verify` from a clean tracked diff.

## Files to understand before editing

| Area | Files |
| --- | --- |
| Existing product client | `apps/macos/src/HubProduct.tsx`, `App.tsx`, `Workforce.tsx`, `Threads.tsx` |
| Diagnostic interaction only | `apps/chat-spike/public/index.html`, `apps/chat-spike/src/thread.mjs` |
| Canonical thread reducer | `packages/task-engine/src/conversation.ts`, `tests/conversation.test.ts` |
| Server projection seam | `apps/chat-spike/src/server.mjs`, formal reducer / store ports added by ENTRY-1 |
| HTTP composition | `apps/chat-spike/src/server.mjs`, `apps/chat-spike/src/human-session.mjs`, `apps/chat-spike/src/http-security.mjs` |
| Dispatch | `apps/chat-spike/src/hub.mjs`, `apps/chat-spike/src/runners/contract.mjs`, `apps/chat-spike/src/runners/local.mjs` |
| Vendor behavior | `apps/chat-spike/src/adapters/`, `apps/chat-spike/FINDINGS.md` |
| Local entry | `scripts/start-local-product.mjs` |
| Current UI tests | `tests/macos-hub-product.test.tsx`, `macos-workforce-ui.test.tsx`, `macos-threads-ui.test.tsx` |
| Runtime tests | `tests/hub-local-runner.test.ts`, `hub-security.test.ts`, `local-runner.test.ts` |

## Commands

Current local product, which still shows the legacy Pulse-first entry:

```bash
pnpm experience
# Hub: http://127.0.0.1:4173/
# product: http://localhost:5173/
```

Run the Spike directly:

```bash
corepack pnpm --filter @agent-os/chat-spike start
```

Focused verification while iterating:

```bash
corepack pnpm vitest run \
  tests/conversation.test.ts \
  tests/hub-local-runner.test.ts \
  tests/hub-security.test.ts \
  tests/macos-hub-product.test.tsx \
  tests/macos-threads-ui.test.tsx
corepack pnpm --filter @agent-os/macos build
```

Mandatory repository gate before each commit:

```bash
corepack pnpm verify
```

There is no hosted CI. The command output from the current tree is authoritative;
do not copy a historical test count into a completion claim.

## Architecture constraints that remain load-bearing

- Events are the only durable writes; views are reducers.
- Runtime-owned identity and causality cannot be supplied by a model.
- Vendor-specific behavior belongs in adapters, not domain packages.
- Progress never causes a task transition.
- An Agent cannot approve or accept its own work.
- Hub dispatches; Runners own working copies, vendor credentials and sessions.
- Local and Remote Runners retain one shared contract.
- Project files use a trusted `(project, runnerHost)` placement. An untrusted browser
  request never supplies an arbitrary absolute Runner path.
- Preserve exact authentication, Origin, workspace-containment and credential
  filtering tests while changing the entry.

ADR-019's deterministic formal demo remains valid. Using Chat Spike as the
backend and measured-behavior starting point does not make its diagnostic UI,
JSONL store or pre-formal event shapes canonical. Reuse runtime behavior while
converging application semantics on the formal packages and product UI in
`apps/macos`.

## Scope guardrails

Do not do these in the first milestone:

- add Herdr as a dependency;
- rebuild Local / Remote Runner;
- enable blanket vendor write approval or weaken workspace containment;
- make a Supervisor plan mandatory before the first prompt;
- expose capability entry as first-use configuration;
- build a new task status or approval channel outside the event / command paths;
- redesign production deployment or touch the live server;
- regenerate all seven management surfaces before the session vertical slice;
- turn the 4173 diagnostic page into a second product frontend;
- copy Spike thread/state reducers into the product client;
- commit any untracked field artifact directory.

## Suggested commit sequence

This handoff completes `docs(product): hand off code-session entry`. Continue
with reviewable slices:

1. `architecture(product): define conversation and run semantics` — permanent
   contract, event and replay changes if required.
2. `feat(product): add project code session model` — typed model, reducer and
   focused tests.
3. `feat(product): add local agent session entry` — composer, readiness and
   real dispatch.
4. `feat(product): expose execution evidence` — diff, tests, blocking actions.
5. `test(product): prove first-use code session` — browser and restart journey.

Update `board.html` as each independently verified part lands. A Git commit is
one checkpoint, not the definition of progress.

## Known open issue outside the entry milestone

`PROB-HUB-PRODUCTION` remains real architectural debt: the deployed Spike
composition lacks operation-level ACK / outbox guarantees even though the formal
SQLite Event Store exists. `/task` also creates then assigns through two writes.
Do not hide this, but do not expand the first local entry milestone into another
production migration project.

## Handoff outcome

The next Agent should begin by defining Conversation / Run / Vendor Session /
Task relationships and writing a focused replay test. It should then replace the
landing composition through the existing authenticated Hub client.

If the first visible change is another dashboard card, task filter or
multi-agent configuration screen, the work is moving in the wrong direction.
