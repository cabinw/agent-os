import type { EventType } from "@agent-os/event-core";

export const TASK_STATUSES = [
  "created",
  "assigned",
  "running",
  "blocked",
  "review",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export const TASK_EVENT_TYPES = [
  "task.created",
  "task.assigned",
  "task.started",
  "task.progress.updated",
  "task.blocked",
  "task.unblocked",
  "task.review.requested",
  "task.completed",
  "task.failed",
  "task.cancelled",
] as const satisfies readonly EventType[];

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export const TASK_TRANSITION_MATRIX: Readonly<
  Record<TaskStatus, Readonly<Partial<Record<TaskEventType, TaskStatus>>>>
> = Object.freeze({
  created: Object.freeze({
    "task.assigned": "assigned",
    "task.cancelled": "cancelled",
  }),
  assigned: Object.freeze({
    "task.started": "running",
    "task.cancelled": "cancelled",
  }),
  running: Object.freeze({
    "task.progress.updated": "running",
    "task.blocked": "blocked",
    "task.review.requested": "review",
    "task.failed": "failed",
    "task.cancelled": "cancelled",
  }),
  blocked: Object.freeze({
    "task.unblocked": "running",
    "task.cancelled": "cancelled",
  }),
  review: Object.freeze({
    "task.started": "running",
    "task.completed": "completed",
    "task.failed": "failed",
    "task.cancelled": "cancelled",
  }),
  completed: Object.freeze({}),
  failed: Object.freeze({}),
  cancelled: Object.freeze({}),
});

export class IllegalTaskTransitionError extends Error {
  readonly code = "ILLEGAL_TASK_TRANSITION" as const;
  readonly current: TaskStatus;
  readonly eventType: TaskEventType;

  constructor(current: TaskStatus, eventType: TaskEventType) {
    super(`illegal task transition: ${current} + ${eventType}`);
    this.name = "IllegalTaskTransitionError";
    this.current = current;
    this.eventType = eventType;
  }
}

export function transitionTaskStatus(
  current: TaskStatus,
  eventType: TaskEventType,
): TaskStatus {
  const next = TASK_TRANSITION_MATRIX[current][eventType];
  if (next === undefined) throw new IllegalTaskTransitionError(current, eventType);
  return next;
}

export function isTaskEventType(value: EventType): value is TaskEventType {
  return (TASK_EVENT_TYPES as readonly string[]).includes(value);
}
