# ADR-018: Thread Projection Uses Event Attribution and Lossless Progress Runs

Status: accepted

## Context

ADR-006 fixes one thread per task plus one project thread. The formal Event Core
does not expose a common `task` field across every event rendered in a thread:

- task events use the task subject;
- messages carry optional `payload.task`;
- only `approval.requested` carries optional `payload.task`;
- later approval events carry only the approval subject;
- knowledge may name several `relatedTasks`.

The Spike has one global item list, an obsolete task transition table and no
approval, knowledge or snapshot semantics. Copying it would make replay and the
future UI disagree with the canonical log.

## Decision

The formal reducer lives in `task-engine`. It owns no storage and returns one
project projection containing a reserved project thread and task-keyed threads.
Thread identity remains derived; no thread event or table is introduced.

Attribution is deterministic:

| Event | Thread attribution |
| --- | --- |
| `message.sent` | `payload.task`, otherwise project thread |
| `task.*` | task subject |
| `approval.requested` | `payload.task`, otherwise project thread; remember attribution by approval subject |
| later `approval.*` | remembered request attribution |
| `knowledge.created` | every `relatedTasks` entry, otherwise project thread |

Task creation creates its empty thread and metadata. Assignment and progress
update metadata only. Started, blocked, unblocked, review requested, completed,
failed and cancelled render as lifecycle dividers. Every approval event and
attributed `knowledge.created` renders as a divider. Events remain ordered by
project `seq`; knowledge may therefore produce the same event in several task
threads without creating another fact.

Messages are kept losslessly. Adjacent `progress` messages from the same sender
and recipient in one thread form one progress-run item containing every original
message. Any divider, non-progress message or sender/recipient change closes the
run. Expanded/collapsed UI state is not part of the project projection.

The reducer validates the same task lifecycle as the Task projection. A task
reference before creation, an approval decision before its request, a duplicate
task or approval request, or a reply to a missing or different-thread message
fails replay. Snapshot restore uses an explicit version and strict synchronous
state parser. Full replay and event-by-event reduction use the same reducer.

## Alternatives

**Store thread rows or membership events.** Rejected: membership is already
derived from immutable events and would create a second source of truth.

**Join independent Task, Approval and Memory projections in the UI.** Rejected:
each surface would reimplement attribution and ordering, so Task Detail and
Agents could disagree.

**Drop individual progress messages after collapsing.** Rejected: it would make
the transcript sparse and violate lossless replay. A progress run is a view over
the original messages.

**Put the reducer in a new package.** Rejected: threads extend task projection
semantics and require the canonical task lifecycle; a sibling package would add
an artificial boundary.

## Consequences

- Approval task attribution is fixed when requested and cannot move later.
- One knowledge event can appear in several threads while remaining one event.
- Invalid historical relationships fail loudly instead of being silently
  dropped into the project thread.
- The future UI receives ordered, lossless thread items and never invents
  lifecycle or collapse state.
