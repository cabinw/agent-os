import type { EventBus, StoredEvent } from "../../packages/event-core/dist/index.js";
import {
  TASK_STATUSES,
  registerTaskReducer,
  transitionTaskStatus,
} from "../../packages/task-engine/src/index.js";
import type {
  TaskProjectState,
  TaskStatus,
} from "../../packages/task-engine/src/index.js";

declare const bus: EventBus;
declare const status: TaskStatus;
declare const event: StoredEvent;

const next: TaskStatus = transitionTaskStatus(status, "task.cancelled");
void next;
const statuses: readonly TaskStatus[] = TASK_STATUSES;
void statuses;
const tasks = registerTaskReducer(bus);
const projection: TaskProjectState = tasks.get(event.project);
void projection;

// @ts-expect-error non-task events cannot enter the task transition matrix
transitionTaskStatus(status, "agent.registered");
