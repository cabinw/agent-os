# Handoff

Written 2026-08-14 for an agent picking this up cold. Read this before
`CLAUDE.md`.

## Read this first: the code is not where you will look for it

`main` is current — everything is merged, and `corepack pnpm verify` passes on it
(65 tests, four layering rules). There is no open PR.

But the directory layout is misleading:

```
packages/*        contracts and TYPES ONLY — no behaviour. Phase 1.1 has not started
apps/chat-spike/  ~2 500 lines of working code. This is the whole implementation
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

`CLAUDE.md` holds the working rules and `docs/README.md` indexes 37 specs. Do not
re-derive architecture from the code; the specs are canonical and were rewritten
to remove conflicts.

## Where the work actually is

| | |
| --- | --- |
| `apps/chat-spike/` | The implementation. Event log, MCP tools, hub runtime, four vendor adapters, one experiment |
| `apps/chat-spike/FINDINGS.md` | The measurements. Several specs were decided here |
| `packages/*` | Contracts and types only. Phase 1.1 starts here |
| `docs/` | 37 specs, 7 ADRs. Canonical |
| `doc.html` / `todo.html` | Generated walkthrough and implementation plan. Both current |
| `tests/` | 65 tests, all passing |

The spike is where every architectural claim was actually tested. Treat
`apps/chat-spike/FINDINGS.md` as evidence, not notes — the numbers in it decided
several specs.

## Verify before you commit

There is **no CI, by decision.** `pnpm verify` is the only gate and it is manual.

```bash
corepack pnpm verify
```

That runs `tsc --build`, Biome, `check:layers`, and Vitest. `check:layers`
mechanically enforces four rules, including that **no event type may be emitted
unless it exists in `docs/protocol/event-catalog.md`**. It reads the catalog's
table rows only.

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

Pick from these. Each has an acceptance criterion, which is the point.

**A · Phase 1.1 — event envelope + Zod schemas + ULID** *(2 days, critical path)*
Implement the envelope from `docs/architecture/event-core.md` in
`packages/event-core`. One payload schema per catalog type (**29 now**), closed
with a discriminated union.
*Done when:* an unknown `type` or an extra field is rejected at parse time.
*Reuse:* the spike's ULID generator and `seq`-assigned-at-write boundary are
already proven; `tests/event-log.test.ts` has the replay-equivalence test.

**B · Bind the hub to localhost and add a shared token** *(half a day)*
`apps/chat-spike/src/server.mjs` calls `server.listen(PORT)` with no host, so Node
binds `::` — every interface, no auth, while the process spawns agent CLIs with
file access. This is a live exposure, not a hypothetical.
*Done when:* default binding is `127.0.0.1` and a bearer token is required.

**C · Hub v2 — projects, sessions, remote runners** *(see `todo.html`)*
Design is settled; the permission/isolation half was **cut by the owner** (trusted
collaborators only, subscription billing). Remaining: project objects with real
directories, sessions as second-class objects that survive restart, a three-column
UI, and runners on other machines.
*Note:* the adapter contract (`send(prompt) → {text, sessionId, ms, fresh}` plus an
`onEvent` stream) already **is** the runner wire protocol. It does not need
redesigning to cross a network.

Order the owner leaned toward: **B → C → A.** C first because the owner uses it
daily, and every valuable finding in this project so far came from running
something rather than reasoning about it.

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

- Where the hub runs long-term: on the owner's Mac, or on a server with the Mac as
  just another runner. This blocks the shape of projects and sessions in C.
- Cross-project knowledge (one project's approach reused in another). Confirmed as
  a real need, deliberately deferred — it is derivable from multiple logs and needs
  no envelope change.
- Whether a Windows machine joins as a runner. The adapters currently assume POSIX
  spawn semantics.
