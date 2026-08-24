import {
  createSupervisorPlanner,
  parseSupervisorPlan,
} from "../../packages/supervisor/src/index.js";
import type {
  PlannerModel,
  SupervisorAdmissionPort,
  SupervisorPlan,
} from "../../packages/supervisor/src/index.js";

declare const model: PlannerModel;
declare const admission: SupervisorAdmissionPort;
declare const plan: SupervisorPlan;

const planner = createSupervisorPlanner({
  model,
  admission,
  taskIdFactory: () => "TASK-001" as never,
});
const parsed: SupervisorPlan = parseSupervisorPlan(plan);
void planner;
void parsed;

// @ts-expect-error model plans are immutable
plan.summary = "mutated";

// @ts-expect-error model output has no executor authority
plan.tasks[0].executor = "codex";
