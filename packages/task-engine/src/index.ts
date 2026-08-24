/**
 * task-engine — the unit of work.
 *
 * Owns legal state transitions, dependency readiness, and capability routing.
 * Registers reducers into event-core; never talks to agents directly.
 *
 * Sibling of memory-core: the two must not import each other
 * (docs/architecture/packages.md).
 *
 * Contract to implement (Phase 1.2a–1.2c, 1.5b):
 *   transition(task, event)  → ADR-002 matrix; illegal transitions rejected
 *   dependsOn readiness      → cycles rejected at creation
 *   route(requires)          → reads `capabilities` only, never `provider`
 *   threadOf(task)           → messages + lifecycle events, seq-ordered
 */

export {
  TASK_EVENT_TYPES,
  TASK_STATUSES,
  TASK_TRANSITION_MATRIX,
  TERMINAL_STATUSES,
  IllegalTaskTransitionError,
  isTaskEventType,
  transitionTaskStatus,
} from "./lifecycle.js";
export type { TaskEventType, TaskStatus } from "./lifecycle.js";
export {
  TaskProjectionError,
  parseTaskProjectState,
  reduceTaskProject,
  registerTaskReducer,
} from "./reducer.js";
export type {
  TaskBlocker,
  TaskCancellation,
  TaskFailure,
  TaskProjectState,
  TaskState,
} from "./reducer.js";
export type { TaskId } from "@agent-os/event-core";
export type TaskRef = Readonly<{
  project: import("@agent-os/event-core").ProjectId;
  id: import("@agent-os/event-core").TaskId;
}>;

export const PACKAGE = "task-engine" as const;
