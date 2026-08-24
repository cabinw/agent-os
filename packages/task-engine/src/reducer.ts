import {
  CAPABILITIES,
  PRIORITIES,
  entityIdSchema,
  projectIdSchema,
  rfc3339Schema,
  taskIdSchema,
} from "@agent-os/event-core";
import type {
  Capability,
  EventBus,
  ProjectId,
  ReducerHandle,
  StoredEvent,
  TaskId,
} from "@agent-os/event-core";
import { TASK_STATUSES, isTaskEventType, transitionTaskStatus } from "./lifecycle.js";
import type { TaskStatus } from "./lifecycle.js";

export type TaskBlocker = Readonly<{
  reason: string;
  severity: "low" | "medium" | "high" | "critical";
  needs: "human" | "agent" | "resource";
}>;

export type TaskFailure = Readonly<{ reason: string; attempts: number }>;
export type TaskCancellation = Readonly<{ by: string; reason: string }>;

export type TaskState = Readonly<{
  id: TaskId;
  project: ProjectId;
  title: string;
  goal: string;
  description?: string;
  status: TaskStatus;
  progress: number;
  priority: "low" | "medium" | "high" | "critical";
  requires: readonly Capability[];
  owner: string;
  executor?: string;
  dependsOn: readonly TaskId[];
  outputs: readonly string[];
  requiresApproval: boolean;
  createdAt: string;
  startedAt?: string;
  blocker?: TaskBlocker;
  reviewSummary?: string;
  reviewedAt?: string;
  acceptedBy?: string;
  failure?: TaskFailure;
  cancellation?: TaskCancellation;
  terminalAt?: string;
}>;

export type TaskProjectState = Readonly<{
  tasks: Readonly<Record<string, TaskState>>;
}>;

const TASK_STATE_KEYS = new Set([
  "id",
  "project",
  "title",
  "goal",
  "description",
  "status",
  "progress",
  "priority",
  "requires",
  "owner",
  "executor",
  "dependsOn",
  "outputs",
  "requiresApproval",
  "createdAt",
  "startedAt",
  "blocker",
  "reviewSummary",
  "reviewedAt",
  "acceptedBy",
  "failure",
  "cancellation",
  "terminalAt",
]);

export class TaskProjectionError extends Error {
  readonly code: "DUPLICATE_TASK" | "INVALID_STATE" | "MISSING_TASK";
  readonly taskId: string | undefined;

  constructor(
    code: "DUPLICATE_TASK" | "INVALID_STATE" | "MISSING_TASK",
    message: string,
    taskId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TaskProjectionError";
    this.code = code;
    this.taskId = taskId;
  }
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TaskProjectionError("INVALID_STATE", `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TaskProjectionError("INVALID_STATE", `${label} has unknown field ${key}`);
    }
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TaskProjectionError("INVALID_STATE", `${label} must be non-empty`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new TaskProjectionError("INVALID_STATE", `${label} must be an array`);
  }
  const parsed = value.map((item, index) => stringValue(item, `${label}[${index}]`));
  if (new Set(parsed).size !== parsed.length) {
    throw new TaskProjectionError("INVALID_STATE", `${label} contains duplicates`);
  }
  return parsed;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const result = rfc3339Schema.safeParse(value);
  if (!result.success) {
    throw new TaskProjectionError("INVALID_STATE", `${label} is invalid`, undefined, {
      cause: result.error,
    });
  }
  return result.data;
}

function entityValue(value: unknown, label: string): string {
  const result = entityIdSchema.safeParse(value);
  if (!result.success) {
    throw new TaskProjectionError("INVALID_STATE", `${label} is invalid`, undefined, {
      cause: result.error,
    });
  }
  return result.data;
}

function parseBlocker(value: unknown, label: string): TaskBlocker {
  const blocker = plainObject(value, label);
  exactKeys(blocker, new Set(["reason", "severity", "needs"]), label);
  if (!PRIORITIES.includes(blocker.severity as TaskBlocker["severity"])) {
    throw new TaskProjectionError("INVALID_STATE", `${label}.severity is invalid`);
  }
  if (!(["human", "agent", "resource"] as const).includes(blocker.needs as never)) {
    throw new TaskProjectionError("INVALID_STATE", `${label}.needs is invalid`);
  }
  return {
    reason: stringValue(blocker.reason, `${label}.reason`),
    severity: blocker.severity as TaskBlocker["severity"],
    needs: blocker.needs as TaskBlocker["needs"],
  };
}

function parseFailure(value: unknown, label: string): TaskFailure {
  const failure = plainObject(value, label);
  exactKeys(failure, new Set(["reason", "attempts"]), label);
  if (!Number.isSafeInteger(failure.attempts) || (failure.attempts as number) <= 0) {
    throw new TaskProjectionError("INVALID_STATE", `${label}.attempts is invalid`);
  }
  return {
    reason: stringValue(failure.reason, `${label}.reason`),
    attempts: failure.attempts as number,
  };
}

function parseCancellation(value: unknown, label: string): TaskCancellation {
  const cancellation = plainObject(value, label);
  exactKeys(cancellation, new Set(["by", "reason"]), label);
  return {
    by: entityValue(cancellation.by, `${label}.by`),
    reason: stringValue(cancellation.reason, `${label}.reason`),
  };
}

function parseTaskState(value: unknown, key: string, project: ProjectId): TaskState {
  const task = plainObject(value, `task ${key}`);
  exactKeys(task, TASK_STATE_KEYS, `task ${key}`);
  const id = taskIdSchema.safeParse(task.id);
  if (!id.success || id.data !== key) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} has invalid id`);
  }
  const taskProject = projectIdSchema.safeParse(task.project);
  if (!taskProject.success || taskProject.data !== project) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} has wrong project`);
  }
  if (!TASK_STATUSES.includes(task.status as TaskStatus)) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} has invalid status`);
  }
  if (
    typeof task.progress !== "number" ||
    !Number.isFinite(task.progress) ||
    task.progress < 0 ||
    task.progress > 100
  ) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} has invalid progress`);
  }
  if (!PRIORITIES.includes(task.priority as (typeof PRIORITIES)[number])) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} has invalid priority`);
  }
  const requires = stringArray(task.requires, `task ${key}.requires`);
  if (requires.some((item) => !CAPABILITIES.includes(item as Capability))) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} has invalid capability`);
  }
  const dependsOn = stringArray(task.dependsOn, `task ${key}.dependsOn`);
  if (dependsOn.some((item) => !taskIdSchema.safeParse(item).success)) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} has invalid dependency`);
  }
  if (typeof task.requiresApproval !== "boolean") {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} approval flag invalid`);
  }
  const createdAt = optionalTimestamp(task.createdAt, `task ${key}.createdAt`);
  if (createdAt === undefined) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} createdAt is required`);
  }
  const outputs = stringArray(task.outputs, `task ${key}.outputs`);
  const parsed: TaskState = {
    id: id.data,
    project: taskProject.data,
    title: stringValue(task.title, `task ${key}.title`),
    goal: entityValue(task.goal, `task ${key}.goal`),
    ...(task.description === undefined
      ? {}
      : { description: stringValue(task.description, `task ${key}.description`) }),
    status: task.status as TaskStatus,
    progress: task.progress,
    priority: task.priority as TaskState["priority"],
    requires: requires as Capability[],
    owner: entityValue(task.owner, `task ${key}.owner`),
    ...(task.executor === undefined
      ? {}
      : { executor: entityValue(task.executor, `task ${key}.executor`) }),
    dependsOn: dependsOn as TaskId[],
    outputs,
    requiresApproval: task.requiresApproval,
    createdAt,
    ...(optionalTimestamp(task.startedAt, `task ${key}.startedAt`) === undefined
      ? {}
      : { startedAt: task.startedAt as string }),
    ...(task.blocker === undefined
      ? {}
      : { blocker: parseBlocker(task.blocker, `task ${key}.blocker`) }),
    ...(task.reviewSummary === undefined
      ? {}
      : { reviewSummary: stringValue(task.reviewSummary, `task ${key}.reviewSummary`) }),
    ...(optionalTimestamp(task.reviewedAt, `task ${key}.reviewedAt`) === undefined
      ? {}
      : { reviewedAt: task.reviewedAt as string }),
    ...(task.acceptedBy === undefined
      ? {}
      : { acceptedBy: entityValue(task.acceptedBy, `task ${key}.acceptedBy`) }),
    ...(task.failure === undefined
      ? {}
      : { failure: parseFailure(task.failure, `task ${key}.failure`) }),
    ...(task.cancellation === undefined
      ? {}
      : {
          cancellation: parseCancellation(task.cancellation, `task ${key}.cancellation`),
        }),
    ...(optionalTimestamp(task.terminalAt, `task ${key}.terminalAt`) === undefined
      ? {}
      : { terminalAt: task.terminalAt as string }),
  };
  if (
    (
      ["assigned", "running", "blocked", "review", "completed", "failed"] as const
    ).includes(parsed.status as never) &&
    parsed.executor === undefined
  ) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} needs an executor`);
  }
  if (
    (["running", "blocked", "review", "completed", "failed"] as const).includes(
      parsed.status as never,
    ) &&
    parsed.startedAt === undefined
  ) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} needs startedAt`);
  }
  if (parsed.status === "blocked" && parsed.blocker === undefined) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} needs a blocker`);
  }
  if (parsed.status !== "blocked" && parsed.blocker !== undefined) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} has stale blocker state`);
  }
  if (parsed.status === "completed" && parsed.acceptedBy === undefined) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} needs acceptedBy`);
  }
  if (parsed.status === "failed" && parsed.failure === undefined) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} needs failure detail`);
  }
  if (parsed.status !== "failed" && parsed.failure !== undefined) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} has stale failure state`);
  }
  if (parsed.status === "cancelled" && parsed.cancellation === undefined) {
    throw new TaskProjectionError(
      "INVALID_STATE",
      `task ${key} needs cancellation detail`,
    );
  }
  if (parsed.status !== "cancelled" && parsed.cancellation !== undefined) {
    throw new TaskProjectionError(
      "INVALID_STATE",
      `task ${key} has stale cancellation state`,
    );
  }
  if (parsed.status !== "completed" && parsed.acceptedBy !== undefined) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} has stale acceptance`);
  }
  if (
    (["completed", "failed", "cancelled"] as const).includes(parsed.status as never) &&
    parsed.terminalAt === undefined
  ) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} needs terminalAt`);
  }
  if (
    !(["completed", "failed", "cancelled"] as const).includes(parsed.status as never) &&
    parsed.terminalAt !== undefined
  ) {
    throw new TaskProjectionError("INVALID_STATE", `task ${key} has stale terminalAt`);
  }
  return parsed;
}

export function parseTaskProjectState(
  value: unknown,
  project: ProjectId,
): TaskProjectState {
  const root = plainObject(value, "task project state");
  exactKeys(root, new Set(["tasks"]), "task project state");
  const tasks = plainObject(root.tasks, "tasks");
  const parsed: Record<string, TaskState> = {};
  for (const [key, task] of Object.entries(tasks)) {
    parsed[key] = parseTaskState(task, key, project);
  }
  return { tasks: parsed };
}

function createTask(event: StoredEvent<"task.created">): TaskState {
  const payload = event.payload;
  return {
    id: event.subject.id as TaskId,
    project: event.project,
    title: payload.title,
    goal: payload.goal,
    ...(payload.description === undefined ? {} : { description: payload.description }),
    status: "created",
    progress: 0,
    priority: payload.priority,
    requires: [...payload.requires],
    owner: event.actor.id,
    dependsOn: [...payload.dependsOn],
    outputs: [],
    requiresApproval: payload.requiresApproval,
    createdAt: event.at,
  };
}

function evolveTask(task: TaskState, event: StoredEvent): TaskState {
  if (!isTaskEventType(event.type) || event.type === "task.created") return task;
  const status = transitionTaskStatus(task.status, event.type);
  switch (event.type) {
    case "task.assigned":
      return { ...task, status, executor: event.payload.executor };
    case "task.started":
      if (task.executor !== event.payload.executor) {
        throw new TaskProjectionError(
          "INVALID_STATE",
          `task ${task.id} started by a different executor`,
          task.id,
        );
      }
      if (task.status === "review") {
        const {
          reviewSummary: _reviewSummary,
          reviewedAt: _reviewedAt,
          ...rework
        } = task;
        return { ...rework, status, outputs: [] };
      }
      return { ...task, status, startedAt: task.startedAt ?? event.at };
    case "task.progress.updated":
      return { ...task, status, progress: event.payload.progress };
    case "task.blocked":
      return { ...task, status, blocker: { ...event.payload } };
    case "task.unblocked": {
      const { blocker: _blocker, ...unblocked } = task;
      return { ...unblocked, status };
    }
    case "task.review.requested":
      return {
        ...task,
        status,
        outputs: [...event.payload.outputs],
        reviewSummary: event.payload.summary,
        reviewedAt: event.at,
      };
    case "task.completed":
      return {
        ...task,
        status,
        acceptedBy: event.payload.acceptedBy,
        terminalAt: event.at,
      };
    case "task.failed":
      return {
        ...task,
        status,
        failure: { ...event.payload },
        terminalAt: event.at,
      };
    case "task.cancelled": {
      const { blocker: _blocker, ...cancelled } = task;
      return {
        ...cancelled,
        status,
        cancellation: { ...event.payload },
        terminalAt: event.at,
      };
    }
  }
}

export function reduceTaskProject(
  state: TaskProjectState,
  event: StoredEvent,
): TaskProjectState {
  if (!isTaskEventType(event.type)) return state;
  const taskId = event.subject.id;
  const existing = state.tasks[taskId];
  if (event.type === "task.created") {
    if (existing !== undefined) {
      throw new TaskProjectionError(
        "DUPLICATE_TASK",
        `task ${taskId} already exists`,
        taskId,
      );
    }
    return { tasks: { ...state.tasks, [taskId]: createTask(event) } };
  }
  if (existing === undefined) {
    throw new TaskProjectionError(
      "MISSING_TASK",
      `task ${taskId} does not exist`,
      taskId,
    );
  }
  return { tasks: { ...state.tasks, [taskId]: evolveTask(existing, event) } };
}

export function registerTaskReducer(bus: EventBus): ReducerHandle<TaskProjectState> {
  return bus.registerReducer("tasks", () => ({ tasks: {} }), reduceTaskProject, {
    version: "1",
    parseState: parseTaskProjectState,
  });
}
