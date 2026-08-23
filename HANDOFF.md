# Handoff

Updated 2026-08-23 for an agent picking this up cold. Read this before
`CLAUDE.md`.

## Read this first: the code is not where you will look for it

Run `corepack pnpm verify` before trusting the working tree. The gate is build,
Biome, the architectural layer checker and the full Vitest suite; the command's
reported test count is authoritative.

But the directory layout is misleading:

```
packages/*        formal contracts and types; the Phase 1 kernel has not started
apps/chat-spike/  the executable event log, Hub, MCP boundary and vendor adapters
```

Someone reading `packages/` first will conclude the project is an empty skeleton.
It is not: the event log, the MCP trust boundary, the hub runtime, four vendor
adapters and one measured experiment all live under `apps/chat-spike/`. It is
called a spike because it is expected to be partly thrown away, **not** because it
is scratch work — several specs were decided by what it measured.

## What this project is

An AI-native OS for running teams of autonomous agents. A human states a goal, a
Supervisor decomposes it into tasks, agents from any vendor execute over MCP,
every state change is an event, and events reduce into task state, UI views and
durable project knowledge.

`CLAUDE.md` holds the working rules and `docs/README.md` indexes 36 documents. Do not
re-derive architecture from the code; the specs are canonical and were rewritten
to remove conflicts.

## Where the work actually is

| | |
| --- | --- |
| `apps/chat-spike/` | The implementation. Event log, MCP tools, hub runtime, four vendor adapters, one experiment |
| `apps/chat-spike/FINDINGS.md` | The measurements. Several specs were decided here |
| `packages/*` | Formal contracts and types. The Phase 1 kernel starts here after the Runner track |
| `docs/` | 36 documents, including 8 ADRs. Canonical |
| `doc.html` / `todo.html` | Generated walkthrough and implementation plan |
| `tests/` | Gate, Hub, MCP, event-log, workspace and layering regression suites |

The spike is where every architectural claim was actually tested. Treat
`apps/chat-spike/FINDINGS.md` as evidence, not notes — the numbers in it decided
several specs.

## Verify before you commit

There is **no hosted CI, by decision.** `pnpm verify` is the gate and it is
manual.

```bash
corepack pnpm verify
```

That runs `tsc --build`, Biome, `check:layers`, and Vitest. `check:layers`
mechanically enforces four rules, including that **no event type may be emitted
unless it exists in `docs/protocol/event-catalog.md`**. Its parser and failure
paths have regression tests; do not replace it with a permissive grep.

The suite is changing during the Runner extraction. Use the final
`pnpm verify` output rather than a copied test count.

## Hub authentication that is now load-bearing

- Default bind is `127.0.0.1:4173`; widening `HOST` does not weaken auth.
- `AGENT_OS_HUMAN_TOKEN` supplies the human credential. If absent, startup
  creates a 256-bit token and prints it once.
- `AGENT_OS_AGENT_TOKENS` may map agent ids to tokens. Unspecified roster agents
  receive process-local random tokens. Authentication lookup is hash-indexed;
  scoped raw values remain only in process memory for Runner injection.
- The public bootstrap shell contains no project data or capability. After it
  collects a token into memory, event, task and acceptance routes are human-only;
  MCP routes are agent-only. `/mcp/call` derives caller from the token;
  `body.caller` is ignored, and `register_agent.id` must match the principal.
- The shell accepts a password input or `#token=…`, clears the fragment before
  its first request, and writes no token to a query, cookie or `localStorage`.
- The MCP bridge receives `AGENT_OS_TOKEN`, not a caller id. Generated credential
  files use mode `0600`.
- Allowed Origins are exact-match (`AGENT_OS_ALLOWED_ORIGINS`); CSP, `nosniff`
  and frame denial are set on responses.

Do not add a compatibility path that accepts an unauthenticated caller field.

## Measurements that already constrain design

These came from running real vendor CLIs on the owner's machine. Do not redesign
against intuition where a number exists.

1. **There are two channels, and the specs originally described one.** *Wake*
   (Agent OS → agent) is vendor-specific and always needs an adapter. *Participate*
   (agent → Agent OS) is MCP. ADR-001's "no adapter needed" holds only for the
   second.

2. **"Speaks MCP" does not imply "can participate."** All four vendors complete
   the handshake; only Claude Code, Kimi and Grok actually surface our tools to
   their model. Codex never does. It is a measured per-vendor fact —
   `integration.participates` in `agent-schema.md`.

3. **Memory-first is cheap on the axes we feared and expensive on one we were not
   watching.** Dropping the vendor session and rebuilding from `get_context` lost
   **zero facts** across 4 vendors × 3 log sizes (up to 108k chars). The cost is a
   **~2× per-turn premium for re-entering**, almost independent of context volume —
   100× more context added ~30–50%. **Therefore: never truncate `get_context` to
   save money.** The lever is fewer, longer turns.

4. **Attaching the MCP server is vendor-specific too**, even where participation
   works: a CLI flag pointing at a file, a `.mcp.json` in the cwd, and a TOML entry
   gated on folder trust. Adapters own connection configuration, not just
   invocation (`src/mcp-mount.mjs`).

5. **Claude Code's `apiKeyHelper` only works under `--bare`**, which also disables
   keychain reads, LSP, hooks and CLAUDE.md discovery, and forces API-key billing
   instead of subscription. Measured with a deliberately invalid key: normal mode
   ignored it and answered; `--bare` returned 401.

## The bug family to watch for

Three separate bugs, all found by running the thing, all the same mistake: **the
runtime trusted a field the agent controls.**

| | Trusted | Consequence |
| --- | --- | --- |
| 1 | `replyTo` being supplied | Omitting it detached the causal chain, so the runaway budget never fired |
| 2 | Re-registration being harmless | A duplicate `agent.registered` poisons every future replay |
| 3 | Causal links to detect "did it speak" | A task wake had no real cause event, so the delivered summary was echoed twice |

The fix in every case was to key on something the runtime owns: the runtime
supplies `causedBy`, `task.started` is a real event, and "did this agent write
anything" is answered by comparing log `seq`. **Any limit keyed on data the agent
supplies is advisory.** Assume the next bug in this family is waiting somewhere.

## Rules that are load-bearing

From `CLAUDE.md`, restated because they are the ones most often violated by
accident:

1. **Event is the only writable object.** Tasks, agents, knowledge and approvals
   are reducer outputs. Needing a table you cannot derive is a design smell —
   raise it, do not add the table.
2. **Never branch on `provider`.** Routing reads `capabilities` only. Vendor names
   may appear in adapters and nowhere else.
3. **Agents request; the runtime decides.** An agent cannot write an event, set
   task status, or approve anything. `report_result` takes `status: completed |
   failed` and the runtime still writes `task.review.requested` — there is no
   argument that reaches `completed`.
4. **`progress` never causes a transition.**
5. **Approvals never auto-grant.** A human message in a thread is guidance, never
   a grant. Acceptance has no MCP tool and must not acquire one.

Adding an event type: **catalog entry first**, then reducer, then a replay test,
then emit. Events are permanent — a type that ships wrong stays in old logs
forever.

## Just landed (2026-08-14)

Two event families were added to the catalog **with no implementation**, because
they are the only part of the memory layer that cannot be built later:

- `artifact.produced` / `artifact.derived` — a corpus and its per-role digests
- `measurement.recorded` — external results about shipped work

Rationale is in `docs/architecture/memory.md` under *Consequences* and *Corpora*.
The short version: everything downstream of the log is derivable and therefore
deferrable, but **an event that was never written cannot be recovered**. Payloads
are deliberately minimal — the content is on disk and can be re-analysed; only
provenance must be captured live.

## What to do next

Follow one route. Do not start Remote Runner work early:

```
Gates + Hub auth ✓
       ↓
Local Runner foundation ✓
       ↓
Local Runner end-to-end ✓
       ↓
Shared Runner contract ← next
       ↓
Remote Runner transport
       ↓
Phase 1.1 Event Core
```

**G · Gates and Hub trust boundary — complete.** Every data, control,
event-stream and MCP route authenticates before handling; a public bootstrap
shell is inert. A server-side principal supplies caller identity; human and
agent routes are separate. The Hub defaults to loopback and widens only by
configuration.
Missing token, wrong role, caller impersonation and cross-site requests have
regression coverage.

**LF · Local Runner foundation — complete.** `src/runners/contract.mjs` defines
strict request, normalized event / result / error shapes. `LocalRunner` calls a
real subprocess through the adapter boundary, rejects `..` and symlink workspace
escapes, serializes work per logical session and restores an atomic `0600`
session snapshot after restart. Four focused tests cover success / stream,
failure, containment and `(user, project, agent)` isolation.

**L · Local Runner end to end — complete as an injectable vertical slice.** When
a Runner is injected, Hub dispatch supplies runtime-owned
`requestId / causedBy`, streams normalized events and writes the Runner reply
through the existing tool callback. Tests drive a real subprocess through Hub →
Local Runner → adapter, carry a task to review, normalize failure and prove the
per-agent queue recovers.

**C · Finish the shared contract — next.** Keep adapter result
`{text, sessionId, ms, fresh}` plus its event stream. Specify cancellation,
retry, errors and liveness. Persist logical ownership at
`(user, project, agent)`: the Hub records the host; that Runner keeps the opaque
vendor handle, adapter and canonical workspace.
Make Runner injection mandatory in the server composition root and remove the
Hub's temporary direct-adapter fallback: without a Runner it must fail closed,
not execute. *Done when:* contract tests do not know whether the transport is
local or remote and the Hub has no vendor execution path.

**R · Remote Runner.** Add authentication, serialization, reconnect and
backpressure to an outbound Runner connection. Workstations expose no inbound
port. Capability is registered for `(agent, host)`.
*Done when:* the unchanged Local acceptance task runs remotely and produces the
same normalized event sequence.

**A · Phase 1.1 Event Core.** Move the proven envelope into
`packages/event-core`: Zod schemas for all catalog types, ULID and strict unknown
field rejection.
*Done when:* an unknown `type` or extra field is rejected at parse time.

The deployment decision is canonical in
`docs/decisions/ADR-008-server-hub-local-first-runners.md`: the Hub owns project
metadata and events; working copies live on Runners; the Git remote is the
cross-host file boundary. ADR-007's single-machine scope is superseded.

## Do not do these

- Do not merge to `main` or force-push without asking.
- Do not add a second document for a concept that already has one. The previous
  doc set had three copies of the event architecture; extend, do not duplicate.
- Do not build the memory/retrieval layer yet. The owner deliberately deferred it;
  only the event types above were pulled forward.
- Do not add an approval or task-status tool to the MCP surface.
- Do not "fix" `apps/chat-spike/src/log.mjs`'s JSONL storage. It is knowingly
  throwaway; Phase 1.2 replaces it with SQLite.

## Open questions the owner has not settled

- Cross-project knowledge (one project's approach reused in another). Confirmed as
  a real need, deliberately deferred — it is derivable from multiple logs and needs
  no envelope change.
- Whether a Windows machine joins as a runner. The adapters currently assume POSIX
  spawn semantics.
