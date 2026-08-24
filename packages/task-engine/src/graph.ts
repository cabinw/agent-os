import { taskIdSchema } from "@agent-os/event-core";
import type { TaskId } from "@agent-os/event-core";
import type { TaskProjectState } from "./reducer.js";

export type ProposedTask = Readonly<{
  id: TaskId;
  dependsOn: readonly TaskId[];
}>;

type TaskGraphCode =
  | "CYCLIC_DEPENDENCY"
  | "DUPLICATE_TASK"
  | "MISSING_DEPENDENCY"
  | "MISSING_TASK"
  | "TASK_NOT_READY";

export class TaskGraphError extends Error {
  readonly code: TaskGraphCode;
  readonly taskId: TaskId | undefined;

  constructor(
    code: TaskGraphCode,
    message: string,
    taskId?: TaskId,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TaskGraphError";
    this.code = code;
    this.taskId = taskId;
  }
}

export class TaskNotReadyError extends TaskGraphError {
  readonly unmet: readonly TaskId[];

  constructor(taskId: TaskId, unmet: readonly TaskId[], status: string) {
    super(
      "TASK_NOT_READY",
      `task ${taskId} is ${status}, unmet: ${unmet.join(", ")}`,
      taskId,
    );
    this.name = "TaskNotReadyError";
    this.unmet = Object.freeze([...unmet]);
  }
}

function admittedTaskId(value: unknown, label: string): TaskId {
  const result = taskIdSchema.safeParse(value);
  if (!result.success) {
    throw new TaskGraphError(
      "MISSING_TASK",
      `${label} is not a canonical task id`,
      undefined,
      {
        cause: result.error,
      },
    );
  }
  return result.data;
}

export function validateTaskPlan(
  state: TaskProjectState,
  proposed: readonly ProposedTask[],
): readonly TaskId[] {
  if (!Array.isArray(proposed)) {
    throw new TaskGraphError("MISSING_TASK", "task plan must be an array");
  }
  const nodes = new Map<TaskId, readonly TaskId[]>();
  for (const [index, candidate] of proposed.entries()) {
    if (candidate === null || typeof candidate !== "object") {
      throw new TaskGraphError("MISSING_TASK", `task plan item ${index} is invalid`);
    }
    const id = admittedTaskId(candidate.id, `task plan item ${index}.id`);
    if (state.tasks[id] !== undefined || nodes.has(id)) {
      throw new TaskGraphError(
        "DUPLICATE_TASK",
        `task ${id} already exists in graph`,
        id,
      );
    }
    if (!Array.isArray(candidate.dependsOn)) {
      throw new TaskGraphError(
        "MISSING_DEPENDENCY",
        `task ${id} dependencies are invalid`,
        id,
      );
    }
    const dependencies = candidate.dependsOn.map(
      (dependency: TaskId, dependencyIndex: number) =>
        admittedTaskId(dependency, `task ${id}.dependsOn[${dependencyIndex}]`),
    );
    if (new Set(dependencies).size !== dependencies.length) {
      throw new TaskGraphError("DUPLICATE_TASK", `task ${id} repeats a dependency`, id);
    }
    nodes.set(id, Object.freeze(dependencies));
  }

  for (const [id, dependencies] of nodes) {
    for (const dependency of dependencies) {
      if (state.tasks[dependency] === undefined && !nodes.has(dependency)) {
        throw new TaskGraphError(
          "MISSING_DEPENDENCY",
          `task ${id} depends on missing ${dependency}`,
          id,
        );
      }
    }
  }

  const indegree = new Map<TaskId, number>();
  const dependents = new Map<TaskId, TaskId[]>();
  for (const id of nodes.keys()) indegree.set(id, 0);
  for (const [id, dependencies] of nodes) {
    for (const dependency of dependencies) {
      if (!nodes.has(dependency)) continue;
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      const list = dependents.get(dependency) ?? [];
      list.push(id);
      dependents.set(dependency, list);
    }
  }
  const ready = [...nodes.keys()].filter((id) => indegree.get(id) === 0).sort();
  const ordered: TaskId[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    ordered.push(id);
    for (const dependent of (dependents.get(id) ?? []).sort()) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (ordered.length !== nodes.size) {
    const cyclic = [...nodes.keys()].filter((id) => !ordered.includes(id)).sort();
    throw new TaskGraphError(
      "CYCLIC_DEPENDENCY",
      `task dependency cycle: ${cyclic.join(", ")}`,
      cyclic[0],
    );
  }
  return Object.freeze(ordered);
}

export function unmetDependencies(
  state: TaskProjectState,
  taskId: TaskId,
): readonly TaskId[] {
  const task = state.tasks[taskId];
  if (task === undefined) {
    throw new TaskGraphError("MISSING_TASK", `task ${taskId} does not exist`, taskId);
  }
  const unmet = task.dependsOn.filter((dependency) => {
    const referenced = state.tasks[dependency];
    if (referenced === undefined) {
      throw new TaskGraphError(
        "MISSING_DEPENDENCY",
        `task ${taskId} depends on missing ${dependency}`,
        taskId,
      );
    }
    return referenced.status !== "completed";
  });
  return Object.freeze([...unmet].sort());
}

export function readyTaskIds(state: TaskProjectState): readonly TaskId[] {
  return Object.freeze(
    Object.values(state.tasks)
      .filter(
        (task) =>
          task.status === "created" && unmetDependencies(state, task.id).length === 0,
      )
      .map((task) => task.id)
      .sort(),
  );
}

export function assertTaskReady(state: TaskProjectState, taskId: TaskId): void {
  const task = state.tasks[taskId];
  if (task === undefined) {
    throw new TaskGraphError("MISSING_TASK", `task ${taskId} does not exist`, taskId);
  }
  const unmet = unmetDependencies(state, taskId);
  if (task.status !== "created" || unmet.length > 0) {
    throw new TaskNotReadyError(taskId, unmet, task.status);
  }
}
