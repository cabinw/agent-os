import { projectIdSchema } from "@agent-os/event-core";
import type {
  Actor,
  Capability,
  DeepReadonly,
  EventId,
  KnowledgeId,
  ProjectId,
  TaskId,
} from "@agent-os/event-core";
import {
  type KnowledgeItem,
  type KnowledgeProjectState,
  parseKnowledgeProjectState,
} from "@agent-os/memory-core";
import {
  type TaskProjectState,
  type TaskState,
  parseTaskProjectState,
} from "@agent-os/task-engine";
import {
  CONTEXT_INCLUDE_KINDS,
  type ContextIncludeKind,
  type ToolInputMap,
  toolInputSchemas,
} from "./schemas.js";

export type ContextTask = DeepReadonly<{
  id: TaskId;
  title: string;
  goal: string;
  description?: string;
  status: TaskState["status"];
  progress: number;
  priority: TaskState["priority"];
  requires: readonly Capability[];
  dependsOn: readonly TaskId[];
}>;

export type ContextDecision = DeepReadonly<{
  id: KnowledgeId;
  title: string;
  summary: string;
  rationale: string;
  alternatives: readonly string[];
  sourceEvents: readonly EventId[];
  relatedTasks: readonly TaskId[];
  author: Actor;
  at: string;
}>;

export type ContextOutput = DeepReadonly<{
  task: TaskId;
  title: string;
  summary: string;
  outputs: readonly string[];
}>;

export type TaskContext = DeepReadonly<{
  project: ProjectId;
  included: readonly ContextIncludeKind[];
  task: ContextTask;
  scopeTasks: readonly TaskId[];
  decisions: readonly ContextDecision[];
  outputs: readonly ContextOutput[];
}>;

export type TaskContextSource = Readonly<{
  project: ProjectId;
  request: ToolInputMap["get_context"];
  tasks: TaskProjectState;
  memory: KnowledgeProjectState;
}>;

export type TaskContextErrorCode =
  | "INVALID_MEMORY_RELATION"
  | "INVALID_MEMORY_STATE"
  | "INVALID_OUTPUT"
  | "INVALID_REQUEST"
  | "INVALID_TASK_GRAPH"
  | "INVALID_TASK_STATE"
  | "MISSING_TASK";

export class TaskContextError extends Error {
  readonly code: TaskContextErrorCode;
  readonly entityId: string | undefined;

  constructor(
    code: TaskContextErrorCode,
    message: string,
    entityId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TaskContextError";
    this.code = code;
    this.entityId = entityId;
  }
}

function freeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
}

function plainSource(value: TaskContextSource): TaskContextSource {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TaskContextError("INVALID_REQUEST", "task context source is required");
  }
  const allowed = new Set(["project", "request", "tasks", "memory"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TaskContextError(
        "INVALID_REQUEST",
        `task context source has unknown field ${key}`,
      );
    }
  }
  return value;
}

function parseSource(value: TaskContextSource): Readonly<{
  project: ProjectId;
  request: ToolInputMap["get_context"];
  tasks: TaskProjectState;
  memory: KnowledgeProjectState;
}> {
  const source = plainSource(value);
  const project = projectIdSchema.safeParse(source.project);
  const request = toolInputSchemas.get_context.safeParse(source.request);
  if (!project.success || !request.success) {
    throw new TaskContextError(
      "INVALID_REQUEST",
      "task context project or request is invalid",
      undefined,
      { cause: project.success ? request.error : project.error },
    );
  }

  let tasks: TaskProjectState;
  try {
    tasks = parseTaskProjectState(source.tasks, project.data);
  } catch (cause) {
    throw new TaskContextError(
      "INVALID_TASK_STATE",
      "task context received an invalid Task projection",
      request.data.task,
      { cause },
    );
  }

  let memory: KnowledgeProjectState;
  try {
    memory = parseKnowledgeProjectState(source.memory, project.data);
  } catch (cause) {
    throw new TaskContextError(
      "INVALID_MEMORY_STATE",
      "task context received an invalid Memory projection",
      undefined,
      { cause },
    );
  }
  return Object.freeze({ project: project.data, request: request.data, tasks, memory });
}

function collectScope(tasks: TaskProjectState, target: TaskId): readonly TaskId[] {
  if (tasks.tasks[target] === undefined) {
    throw new TaskContextError("MISSING_TASK", `task ${target} does not exist`, target);
  }

  const scope = new Set<TaskId>();
  const visiting = new Set<TaskId>();
  const visit = (id: TaskId): void => {
    if (visiting.has(id)) {
      throw new TaskContextError(
        "INVALID_TASK_GRAPH",
        `task dependency cycle reaches ${id}`,
        id,
      );
    }
    if (scope.has(id)) return;
    const task = tasks.tasks[id];
    if (task === undefined) {
      throw new TaskContextError(
        "INVALID_TASK_GRAPH",
        `task dependency ${id} does not exist`,
        id,
      );
    }
    visiting.add(id);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(id);
    scope.add(id);
  };
  visit(target);

  const upstream = [...scope].filter((id) => id !== target);
  const indegree = new Map<TaskId, number>();
  const dependents = new Map<TaskId, TaskId[]>();
  for (const id of upstream) indegree.set(id, 0);
  for (const id of upstream) {
    const task = tasks.tasks[id] as TaskState;
    for (const dependency of task.dependsOn) {
      if (!indegree.has(dependency)) continue;
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      const children = dependents.get(dependency) ?? [];
      children.push(id);
      dependents.set(dependency, children);
    }
  }

  const ready = upstream.filter((id) => indegree.get(id) === 0).sort();
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
  if (ordered.length !== upstream.length) {
    throw new TaskContextError(
      "INVALID_TASK_GRAPH",
      `task dependency cycle reaches ${target}`,
      target,
    );
  }
  return Object.freeze([target, ...ordered]);
}

function contextTask(task: TaskState): ContextTask {
  return freeze({
    id: task.id,
    title: task.title,
    goal: task.goal,
    ...(task.description === undefined ? {} : { description: task.description }),
    status: task.status,
    progress: task.progress,
    priority: task.priority,
    requires: [...task.requires],
    dependsOn: [...task.dependsOn],
  });
}

function contextDecision(item: KnowledgeItem): ContextDecision {
  if (item.rationale === undefined) {
    throw new TaskContextError(
      "INVALID_MEMORY_STATE",
      `decision ${item.id} has no rationale`,
      item.id,
    );
  }
  return freeze({
    id: item.id,
    title: item.title,
    summary: item.summary,
    rationale: item.rationale,
    alternatives: [...(item.alternatives ?? [])],
    sourceEvents: [...item.sourceEvents],
    relatedTasks: [...(item.relatedTasks ?? [])],
    author: { ...item.author },
    at: item.at,
  });
}

function selectDecisions(
  tasks: TaskProjectState,
  memory: KnowledgeProjectState,
  scope: readonly TaskId[],
): readonly ContextDecision[] {
  for (const item of Object.values(memory.items)) {
    for (const related of item.relatedTasks ?? []) {
      if (tasks.tasks[related] === undefined) {
        throw new TaskContextError(
          "INVALID_MEMORY_RELATION",
          `knowledge ${item.id} relates to missing task ${related}`,
          item.id,
        );
      }
    }
  }
  const scopeSet = new Set(scope);
  return Object.freeze(
    Object.values(memory.items)
      .filter(
        (item) =>
          item.type === "decision" &&
          item.supersededBy === undefined &&
          (item.relatedTasks === undefined ||
            item.relatedTasks.some((task) => scopeSet.has(task))),
      )
      .sort(
        (left, right) =>
          left.createdSeq - right.createdSeq || left.id.localeCompare(right.id),
      )
      .map(contextDecision),
  );
}

function selectOutputs(
  tasks: TaskProjectState,
  scope: readonly TaskId[],
): readonly ContextOutput[] {
  const outputs: ContextOutput[] = [];
  for (const id of scope.slice(1)) {
    const task = tasks.tasks[id] as TaskState;
    if (task.status !== "completed") continue;
    if (task.reviewSummary === undefined) {
      throw new TaskContextError(
        "INVALID_OUTPUT",
        `completed task ${id} has no accepted review summary`,
        id,
      );
    }
    outputs.push(
      freeze({
        task: id,
        title: task.title,
        summary: task.reviewSummary,
        outputs: [...task.outputs],
      }),
    );
  }
  return Object.freeze(outputs);
}

export function buildTaskContext(value: TaskContextSource): TaskContext {
  const { project, request, tasks, memory } = parseSource(value);
  const scopeTasks = collectScope(tasks, request.task);
  const included = CONTEXT_INCLUDE_KINDS.filter((kind) => request.include.includes(kind));
  const includedSet = new Set(included);
  const target = tasks.tasks[request.task] as TaskState;
  return freeze({
    project,
    included,
    task: contextTask(target),
    scopeTasks,
    decisions: includedSet.has("decisions")
      ? selectDecisions(tasks, memory, scopeTasks)
      : [],
    outputs: includedSet.has("outputs") ? selectOutputs(tasks, scopeTasks) : [],
  });
}
