/**
 * task-engine — the unit of work.
 *
 * Owns legal state transitions, dependency readiness, and capability routing.
 * Registers reducers into event-core; never talks to agents directly.
 *
 * Sibling of memory-core: the two must not import each other
 * (docs/architecture/packages.md).
 *
 * Contract to implement (Phase 1.5–1.7, 1.13):
 *   transition(task, event)  → ADR-002 matrix; illegal transitions rejected
 *   dependsOn readiness      → cycles rejected at creation
 *   route(requires)          → reads `capabilities` only, never `provider`
 *   threadOf(task)           → messages + lifecycle events, seq-ordered
 */

import type { ProjectId } from "@agent-os/event-core";

/** Canonical task lifecycle — ADR-002. Lowercase everywhere, including JSON. */
export type TaskStatus =
  | "created"
  | "assigned"
  | "running"
  | "blocked"
  | "review"
  | "completed"
  | "failed"
  | "cancelled";

/** Terminal states. `blocked` is a bypass back to `running`, not a stage. */
export const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

/** `TASK-nnn`, unique per project, never reused. */
export type TaskId = string & { readonly __brand: "TaskId" };

export type TaskRef = {
  readonly project: ProjectId;
  readonly id: TaskId;
};

export const PACKAGE = "task-engine" as const;
