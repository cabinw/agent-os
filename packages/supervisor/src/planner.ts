import { taskIdSchema } from "@agent-os/event-core";
import type {
  Capability,
  EntityId,
  EventId,
  ProjectId,
  TaskId,
} from "@agent-os/event-core";
import { validateTaskPlan } from "@agent-os/task-engine";
import type { TaskProjectState } from "@agent-os/task-engine";
import {
  SUPERVISOR_PLAN_JSON_SCHEMA,
  parseGoalPlanningRequest,
  parseSupervisorPlan,
} from "./schemas.js";
import type { GoalPlanningRequest, SupervisorPlan } from "./schemas.js";

type Awaitable<T> = T | Promise<T>;

export type PlannerModelInput = Readonly<{
  goal: Readonly<{
    id: string;
    title: string;
    detail: string;
    constraints: readonly string[];
  }>;
  outputSchema: Readonly<Record<string, unknown>>;
}>;

export interface PlannerModel {
  plan(input: PlannerModelInput): Awaitable<unknown>;
}

export type AdmittedTask = Readonly<{
  id: TaskId;
  title: string;
  goal: EntityId;
  description?: string;
  requires: readonly Capability[];
  priority: "low" | "medium" | "high" | "critical";
  dependsOn: readonly TaskId[];
  requiresApproval: boolean;
}>;

export type AdmittedDecision = Readonly<{
  title: string;
  summary: string;
  rationale: string;
  alternatives: readonly string[];
  relatedTasks: readonly TaskId[];
  sourceEvents: readonly [EventId];
}>;

export type SupervisorAdmissionCommand = Readonly<{
  project: ProjectId;
  goal: EntityId;
  causedBy: EventId;
  operationToken: string;
  summary: string;
  tasks: readonly AdmittedTask[];
  decisions: readonly AdmittedDecision[];
}>;

export interface SupervisorAdmissionPort {
  currentTasks(project: ProjectId): Awaitable<TaskProjectState>;
  admit(command: SupervisorAdmissionCommand): Awaitable<void>;
}

export type SupervisorPlannerOptions = Readonly<{
  model: PlannerModel;
  admission: SupervisorAdmissionPort;
  taskIdFactory(key: string, index: number): TaskId;
}>;

export class SupervisorPlanError extends Error {
  readonly code:
    | "ADMISSION_FAILURE"
    | "GRAPH_FAILURE"
    | "INVALID_ID"
    | "INVALID_OPTIONS"
    | "INVALID_PLAN"
    | "INVALID_REQUEST"
    | "MODEL_FAILURE";

  constructor(
    code: SupervisorPlanError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SupervisorPlanError";
    this.code = code;
  }
}

function freeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function assertOptions(options: SupervisorPlannerOptions): void {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.model?.plan !== "function" ||
    typeof options.admission?.currentTasks !== "function" ||
    typeof options.admission.admit !== "function" ||
    typeof options.taskIdFactory !== "function"
  ) {
    throw new SupervisorPlanError(
      "INVALID_OPTIONS",
      "Supervisor planner options are invalid",
    );
  }
}

export class SupervisorPlanner {
  readonly #options: SupervisorPlannerOptions;

  constructor(options: SupervisorPlannerOptions) {
    assertOptions(options);
    this.#options = options;
  }

  async plan(requestValue: unknown): Promise<SupervisorAdmissionCommand> {
    let request: GoalPlanningRequest;
    try {
      request = parseGoalPlanningRequest(requestValue);
    } catch (cause) {
      throw new SupervisorPlanError(
        "INVALID_REQUEST",
        "goal planning request is invalid",
        { cause },
      );
    }

    let raw: unknown;
    try {
      raw = await this.#options.model.plan(
        Object.freeze({
          goal: Object.freeze({
            id: request.goal,
            title: request.title,
            detail: request.detail,
            constraints: request.constraints,
          }),
          outputSchema: SUPERVISOR_PLAN_JSON_SCHEMA,
        }),
      );
    } catch (cause) {
      throw new SupervisorPlanError("MODEL_FAILURE", "PlannerModel failed", { cause });
    }

    let plan: SupervisorPlan;
    try {
      plan = parseSupervisorPlan(raw);
    } catch (cause) {
      throw new SupervisorPlanError(
        "INVALID_PLAN",
        "PlannerModel returned an invalid plan",
        { cause },
      );
    }

    const byKey = new Map<string, TaskId>();
    for (const [index, task] of plan.tasks.entries()) {
      const candidate = this.#options.taskIdFactory(task.key, index);
      const parsed = taskIdSchema.safeParse(candidate);
      if (
        !parsed.success ||
        byKey.has(task.key) ||
        [...byKey.values()].includes(parsed.data)
      ) {
        throw new SupervisorPlanError(
          "INVALID_ID",
          `task id allocation failed for ${task.key}`,
        );
      }
      byKey.set(task.key, parsed.data);
    }

    const mapped = plan.tasks.map((task) => ({
      id: byKey.get(task.key) as TaskId,
      dependsOn: task.dependsOn.map((key) => byKey.get(key) as TaskId),
    }));
    let state: TaskProjectState;
    let order: readonly TaskId[];
    try {
      state = await this.#options.admission.currentTasks(request.project as ProjectId);
      order = validateTaskPlan(state, mapped);
    } catch (cause) {
      throw new SupervisorPlanError("GRAPH_FAILURE", "planned task graph is invalid", {
        cause,
      });
    }

    const taskById = new Map(
      plan.tasks.map((task) => {
        const id = byKey.get(task.key) as TaskId;
        return [
          id,
          Object.freeze({
            id,
            title: task.title,
            goal: request.goal,
            ...(task.description === undefined ? {} : { description: task.description }),
            requires: task.requires,
            priority: task.priority,
            dependsOn: task.dependsOn.map((key) => byKey.get(key) as TaskId),
            requiresApproval: task.requiresApproval,
          }),
        ] as const;
      }),
    );
    const command: SupervisorAdmissionCommand = freeze({
      project: request.project,
      goal: request.goal,
      causedBy: request.causedBy,
      operationToken: request.operationToken,
      summary: plan.summary,
      tasks: Object.freeze(order.map((id) => taskById.get(id) as AdmittedTask)),
      decisions: Object.freeze(
        [...plan.decisions]
          .sort((left, right) => left.key.localeCompare(right.key))
          .map((decision) =>
            Object.freeze({
              title: decision.title,
              summary: decision.summary,
              rationale: decision.rationale,
              alternatives: decision.alternatives,
              relatedTasks: decision.affects
                .map((key) => byKey.get(key) as TaskId)
                .sort(),
              sourceEvents: [request.causedBy] as [EventId],
            }),
          ),
      ),
    });
    try {
      await this.#options.admission.admit(command);
    } catch (cause) {
      throw new SupervisorPlanError(
        "ADMISSION_FAILURE",
        "Supervisor plan admission failed",
        { cause },
      );
    }
    return command;
  }
}

export function createSupervisorPlanner(
  options: SupervisorPlannerOptions,
): SupervisorPlanner {
  return new SupervisorPlanner(options);
}
