import {
  capabilitySchema,
  entityIdSchema,
  eventIdSchema,
  nonEmptyStringSchema,
  prioritySchema,
  projectIdSchema,
} from "@agent-os/event-core";
import type { DeepReadonly } from "@agent-os/event-core";
import { z } from "zod";

function freeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
}

const localKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const uniqueStrings = <T extends z.ZodType>(schema: T) =>
  z.array(schema).refine((items) => new Set(items).size === items.length, {
    error: "must not contain duplicates",
  });

export const goalPlanningRequestSchema = z.strictObject({
  project: projectIdSchema,
  goal: entityIdSchema,
  title: nonEmptyStringSchema,
  detail: nonEmptyStringSchema,
  constraints: uniqueStrings(nonEmptyStringSchema),
  causedBy: eventIdSchema,
  operationToken: nonEmptyStringSchema.max(256),
});

const plannedTaskSchema = z.strictObject({
  key: localKeySchema,
  title: nonEmptyStringSchema,
  description: nonEmptyStringSchema.optional(),
  requires: uniqueStrings(capabilitySchema),
  priority: prioritySchema,
  dependsOn: uniqueStrings(localKeySchema),
  requiresApproval: z.boolean(),
});

const plannedDecisionSchema = z.strictObject({
  key: localKeySchema,
  title: nonEmptyStringSchema,
  summary: nonEmptyStringSchema,
  rationale: nonEmptyStringSchema,
  alternatives: uniqueStrings(nonEmptyStringSchema).min(2),
  affects: uniqueStrings(localKeySchema).min(1),
});

export const supervisorPlanSchema = z
  .strictObject({
    summary: nonEmptyStringSchema,
    tasks: z.array(plannedTaskSchema).min(1).max(100),
    decisions: z.array(plannedDecisionSchema).max(50),
  })
  .superRefine((plan, context) => {
    const taskKeys = new Set(plan.tasks.map((task) => task.key));
    if (taskKeys.size !== plan.tasks.length) {
      context.addIssue({
        code: "custom",
        message: "task keys must be unique",
        path: ["tasks"],
      });
    }
    const decisionKeys = new Set(plan.decisions.map((decision) => decision.key));
    if (decisionKeys.size !== plan.decisions.length) {
      context.addIssue({
        code: "custom",
        message: "decision keys must be unique",
        path: ["decisions"],
      });
    }
    for (const [index, task] of plan.tasks.entries()) {
      for (const dependency of task.dependsOn) {
        if (!taskKeys.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: `unknown local dependency ${dependency}`,
            path: ["tasks", index, "dependsOn"],
          });
        }
        if (dependency === task.key) {
          context.addIssue({
            code: "custom",
            message: "task cannot depend on itself",
            path: ["tasks", index, "dependsOn"],
          });
        }
      }
    }
    for (const [index, decision] of plan.decisions.entries()) {
      for (const affected of decision.affects) {
        if (!taskKeys.has(affected)) {
          context.addIssue({
            code: "custom",
            message: `unknown affected task ${affected}`,
            path: ["decisions", index, "affects"],
          });
        }
      }
    }
  });

export type GoalPlanningRequest = DeepReadonly<z.infer<typeof goalPlanningRequestSchema>>;
export type SupervisorPlan = DeepReadonly<z.infer<typeof supervisorPlanSchema>>;
export type PlannedTask = SupervisorPlan["tasks"][number];
export type PlannedDecision = SupervisorPlan["decisions"][number];

export function parseGoalPlanningRequest(value: unknown): GoalPlanningRequest {
  return freeze(goalPlanningRequestSchema.parse(value));
}

export function parseSupervisorPlan(value: unknown): SupervisorPlan {
  return freeze(supervisorPlanSchema.parse(value));
}

export const SUPERVISOR_PLAN_JSON_SCHEMA = freeze(
  z.toJSONSchema(supervisorPlanSchema) as Record<string, unknown>,
);
