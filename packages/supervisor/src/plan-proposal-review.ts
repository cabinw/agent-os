import {
  entityIdSchema,
  nonEmptyStringSchema,
  projectIdSchema,
  taskIdSchema,
} from "@agent-os/event-core";
import type {
  Capability,
  EntityId,
  EventId,
  ProjectId,
  TaskId,
} from "@agent-os/event-core";
import { validateTaskPlan } from "@agent-os/task-engine";
import type { TaskProjectState } from "@agent-os/task-engine";
import { z } from "zod";
import type { PlanProposalState } from "./plan-proposal.js";
import type { AdmittedTask } from "./planner.js";

type Awaitable<Value> = Value | Promise<Value>;

const reviewBase = {
  project: projectIdSchema,
  proposal: entityIdSchema,
  reviewer: z.strictObject({ kind: z.literal("agent"), id: entityIdSchema }),
  operationToken: nonEmptyStringSchema.max(256),
};

const planProposalReviewRequestSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    ...reviewBase,
    decision: z.literal("accept"),
    rationale: nonEmptyStringSchema,
  }),
  z.strictObject({
    ...reviewBase,
    decision: z.literal("reject"),
    reason: nonEmptyStringSchema,
  }),
]);

export type PlanProposalReviewRequest = Readonly<
  z.infer<typeof planProposalReviewRequestSchema>
>;

export type PlanProposalReviewCommand = Readonly<{
  project: ProjectId;
  proposal: EntityId;
  causedBy: EventId;
  operationToken: string;
  outcome:
    | Readonly<{
        type: "plan.accepted";
        by: EntityId;
        rationale: string;
        tasks: readonly Readonly<{ key: string; id: TaskId }>[];
      }>
    | Readonly<{
        type: "plan.rejected";
        by: EntityId;
        reason: string;
      }>;
  tasks: readonly AdmittedTask[];
}>;

export interface PlanProposalReviewPort {
  proposal(project: ProjectId, proposal: EntityId): Awaitable<PlanProposalState | null>;
  currentTasks(project: ProjectId): Awaitable<TaskProjectState>;
  admit(command: PlanProposalReviewCommand): Awaitable<void>;
}

export type PlanProposalReviewOptions = Readonly<{
  port: PlanProposalReviewPort;
  taskIdFactory(key: string, index: number): TaskId;
}>;

export class PlanProposalReviewError extends Error {
  readonly code:
    | "ADMISSION_FAILURE"
    | "GRAPH_FAILURE"
    | "INVALID_ID"
    | "INVALID_OPTIONS"
    | "INVALID_REQUEST"
    | "MISSING_PROPOSAL"
    | "NOT_PENDING"
    | "PROJECTION_FAILURE"
    | "SELF_REVIEW";

  constructor(
    code: PlanProposalReviewError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PlanProposalReviewError";
    this.code = code;
  }
}

function freeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function assertOptions(options: PlanProposalReviewOptions): void {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.port?.proposal !== "function" ||
    typeof options.port.currentTasks !== "function" ||
    typeof options.port.admit !== "function" ||
    typeof options.taskIdFactory !== "function"
  ) {
    throw new PlanProposalReviewError(
      "INVALID_OPTIONS",
      "plan proposal review options are invalid",
    );
  }
}

function allocate(
  proposal: PlanProposalState,
  factory: PlanProposalReviewOptions["taskIdFactory"],
): ReadonlyMap<string, TaskId> {
  const byKey = new Map<string, TaskId>();
  const ids = new Set<TaskId>();
  for (const [index, task] of proposal.tasks.entries()) {
    let candidate: unknown;
    try {
      candidate = factory(task.key, index);
    } catch (cause) {
      throw new PlanProposalReviewError(
        "INVALID_ID",
        `task id allocation failed for ${task.key}`,
        { cause },
      );
    }
    const result = taskIdSchema.safeParse(candidate);
    if (!result.success) {
      throw new PlanProposalReviewError(
        "INVALID_ID",
        `task id allocation failed for ${task.key}`,
        { cause: result.error },
      );
    }
    if (ids.has(result.data)) {
      throw new PlanProposalReviewError(
        "INVALID_ID",
        `task id allocation collided for ${task.key}`,
      );
    }
    byKey.set(task.key, result.data);
    ids.add(result.data);
  }
  return byKey;
}

function admittedTask(
  proposal: PlanProposalState,
  task: PlanProposalState["tasks"][number],
  byKey: ReadonlyMap<string, TaskId>,
): AdmittedTask {
  const id = byKey.get(task.key) as TaskId;
  const dependsOn = task.dependsOn.map((dependency) =>
    dependency.kind === "existing"
      ? dependency.task
      : (byKey.get(dependency.key) as TaskId),
  );
  return freeze({
    id,
    title: task.title,
    goal: proposal.goal,
    ...(task.description === undefined ? {} : { description: task.description }),
    requires: task.requires as readonly Capability[],
    priority: task.priority,
    dependsOn,
    requiresApproval: task.requiresApproval,
  });
}

async function accept(
  options: PlanProposalReviewOptions,
  request: Extract<PlanProposalReviewRequest, { decision: "accept" }>,
  proposal: PlanProposalState,
): Promise<PlanProposalReviewCommand> {
  const byKey = allocate(proposal, options.taskIdFactory);
  const tasks = proposal.tasks.map((task) => admittedTask(proposal, task, byKey));
  let current: TaskProjectState;
  let order: readonly TaskId[];
  try {
    current = await options.port.currentTasks(request.project);
    order = validateTaskPlan(current, tasks);
  } catch (cause) {
    throw new PlanProposalReviewError(
      "GRAPH_FAILURE",
      "proposed incremental task graph is invalid",
      { cause },
    );
  }
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  return freeze({
    project: request.project,
    proposal: request.proposal,
    causedBy: proposal.proposedEvent,
    operationToken: request.operationToken,
    outcome: {
      type: "plan.accepted",
      by: request.reviewer.id,
      rationale: request.rationale,
      tasks: [...byKey.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, id]) => ({ key, id })),
    },
    tasks: order.map((id) => taskById.get(id) as AdmittedTask),
  });
}

function reject(
  request: Extract<PlanProposalReviewRequest, { decision: "reject" }>,
  proposal: PlanProposalState,
): PlanProposalReviewCommand {
  return freeze({
    project: request.project,
    proposal: request.proposal,
    causedBy: proposal.proposedEvent,
    operationToken: request.operationToken,
    outcome: {
      type: "plan.rejected",
      by: request.reviewer.id,
      reason: request.reason,
    },
    tasks: [],
  });
}

export function createPlanProposalReviewService(
  options: PlanProposalReviewOptions,
): Readonly<{
  review(request: unknown): Promise<PlanProposalReviewCommand>;
}> {
  assertOptions(options);
  return Object.freeze({
    async review(requestValue: unknown) {
      const result = planProposalReviewRequestSchema.safeParse(requestValue);
      if (!result.success) {
        throw new PlanProposalReviewError(
          "INVALID_REQUEST",
          "plan proposal review request is invalid",
          { cause: result.error },
        );
      }
      const request = freeze(result.data);
      let proposal: PlanProposalState | null;
      try {
        proposal = await options.port.proposal(request.project, request.proposal);
      } catch (cause) {
        throw new PlanProposalReviewError(
          "PROJECTION_FAILURE",
          "plan proposal projection is unavailable",
          { cause },
        );
      }
      if (proposal === null) {
        throw new PlanProposalReviewError(
          "MISSING_PROPOSAL",
          `plan proposal ${request.proposal} does not exist`,
        );
      }
      if (proposal.project !== request.project || proposal.id !== request.proposal) {
        throw new PlanProposalReviewError(
          "PROJECTION_FAILURE",
          "plan proposal projection returned mismatched identity",
        );
      }
      if (proposal.status !== "proposed") {
        throw new PlanProposalReviewError(
          "NOT_PENDING",
          `plan proposal ${request.proposal} is already ${proposal.status}`,
        );
      }
      if (proposal.proposedBy === request.reviewer.id) {
        throw new PlanProposalReviewError(
          "SELF_REVIEW",
          "a plan proposer cannot review its own proposal",
        );
      }
      const command =
        request.decision === "accept"
          ? await accept(options, request, proposal)
          : reject(request, proposal);
      try {
        await options.port.admit(command);
      } catch (cause) {
        throw new PlanProposalReviewError(
          "ADMISSION_FAILURE",
          "plan proposal review was not durably admitted",
          { cause },
        );
      }
      return command;
    },
  });
}
