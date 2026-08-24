import { describe, expect, it, vi } from "vitest";
import { newEventId } from "../packages/event-core/src/index.js";
import {
  SUPERVISOR_PLAN_JSON_SCHEMA,
  SupervisorPlanError,
  createSupervisorPlanner,
  parseGoalPlanningRequest,
  parseSupervisorPlan,
} from "../packages/supervisor/src/index.js";
import type {
  PlannerModel,
  SupervisorAdmissionCommand,
  SupervisorAdmissionPort,
} from "../packages/supervisor/src/index.js";
import type { TaskProjectState } from "../packages/task-engine/src/index.js";

const REQUEST = Object.freeze({
  project: "proj_supervisor" as never,
  goal: "goal-release" as never,
  title: "Ship release",
  detail: "Research, implement and verify the release.",
  constraints: ["No provider coupling", "All changes tested"],
  causedBy: newEventId(),
  operationToken: "plan-operation-001",
});

const PLAN = Object.freeze({
  summary: "Research before implementation.",
  tasks: [
    {
      key: "implement",
      title: "Implement release",
      description: "Implement the selected design.",
      requires: ["coding"],
      priority: "high",
      dependsOn: ["research"],
      requiresApproval: false,
    },
    {
      key: "research",
      title: "Research designs",
      requires: ["research"],
      priority: "medium",
      dependsOn: [],
      requiresApproval: false,
    },
    {
      key: "verify",
      title: "Verify release",
      requires: ["testing"],
      priority: "high",
      dependsOn: ["implement"],
      requiresApproval: true,
    },
  ],
  decisions: [
    {
      key: "delivery-shape",
      title: "Use staged delivery",
      summary: "Stage before production.",
      rationale: "It preserves rollback evidence.",
      alternatives: ["Direct production", "Staged delivery"],
      affects: ["implement", "verify"],
    },
    {
      key: "architecture",
      title: "Keep provider neutral",
      summary: "Route by capability.",
      rationale: "Providers change independently.",
      alternatives: ["Provider branches", "Capability routing"],
      affects: ["research", "implement"],
    },
  ],
});

function harness(
  overrides: {
    model?: Partial<PlannerModel>;
    admission?: Partial<SupervisorAdmissionPort>;
    ids?: readonly string[];
  } = {},
) {
  const admitted: SupervisorAdmissionCommand[] = [];
  const model: PlannerModel = {
    plan: vi.fn(() => PLAN),
    ...overrides.model,
  };
  const admission: SupervisorAdmissionPort = {
    currentTasks: vi.fn(() => ({ tasks: {} }) as TaskProjectState),
    admit: vi.fn((command) => {
      admitted.push(command);
    }),
    ...overrides.admission,
  };
  const ids = overrides.ids ?? ["TASK-103", "TASK-101", "TASK-102"];
  const planner = createSupervisorPlanner({
    model,
    admission,
    taskIdFactory: (_key, index) => ids[index] as never,
  });
  return { admitted, admission, model, planner };
}

describe("RM-1.5a · strict structured Supervisor plan", () => {
  it("strictly parses and freezes trusted requests and model plans", () => {
    const request = parseGoalPlanningRequest(REQUEST);
    const plan = parseSupervisorPlan(PLAN);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.constraints)).toBe(true);
    expect(Object.isFrozen(plan.tasks[0])).toBe(true);
    expect(() => parseGoalPlanningRequest({ ...REQUEST, actor: "model" })).toThrow();
    expect(() => parseSupervisorPlan({ ...PLAN, executor: "codex" })).toThrow();
  });

  it("publishes a closed structured-output JSON Schema", () => {
    expect(SUPERVISOR_PLAN_JSON_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["summary", "tasks", "decisions"],
    });
    expect(Object.isFrozen(SUPERVISOR_PLAN_JSON_SCHEMA)).toBe(true);
  });

  it.each([
    [{ ...PLAN, tasks: [{ ...PLAN.tasks[0], status: "completed" }] }, "authority field"],
    [
      { ...PLAN, tasks: [PLAN.tasks[0], { ...PLAN.tasks[1], key: "implement" }] },
      "duplicate task key",
    ],
    [
      { ...PLAN, tasks: [{ ...PLAN.tasks[0], dependsOn: ["missing"] }] },
      "missing local dependency",
    ],
    [
      { ...PLAN, tasks: [{ ...PLAN.tasks[0], dependsOn: ["implement"] }] },
      "self dependency",
    ],
    [
      { ...PLAN, decisions: [{ ...PLAN.decisions[0], affects: ["missing"] }] },
      "missing affected task",
    ],
    [
      { ...PLAN, decisions: [{ ...PLAN.decisions[0], alternatives: ["only"] }] },
      "single alternative",
    ],
  ])("rejects %s (%s)", (value) => {
    expect(() => parseSupervisorPlan(value)).toThrow();
  });
});

describe("RM-1.5a · planning and atomic admission", () => {
  it("maps local keys, validates the graph and admits stable topological order", async () => {
    const { admitted, model, planner } = harness();
    const command = await planner.plan(REQUEST);
    expect(model.plan).toHaveBeenCalledOnce();
    expect(command.tasks.map((task) => task.id)).toEqual([
      "TASK-101",
      "TASK-103",
      "TASK-102",
    ]);
    expect(command.tasks[1]).toMatchObject({
      title: "Implement release",
      goal: REQUEST.goal,
      dependsOn: ["TASK-101"],
    });
    expect(admitted).toEqual([command]);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.tasks)).toBe(true);
    expect(Object.isFrozen(command.tasks[1]?.dependsOn)).toBe(true);
  });

  it("sorts decisions by local key and maps durable sources and related tasks", async () => {
    const command = await harness().planner.plan(REQUEST);
    expect(command.decisions.map((decision) => decision.title)).toEqual([
      "Keep provider neutral",
      "Use staged delivery",
    ]);
    expect(command.decisions[0]).toMatchObject({
      relatedTasks: ["TASK-101", "TASK-103"],
      sourceEvents: [REQUEST.causedBy],
    });
    expect(Object.isFrozen(command.decisions[0]?.sourceEvents)).toBe(true);
  });

  it("passes only goal content and schema to the model", async () => {
    const { model, planner } = harness();
    await planner.plan(REQUEST);
    const input = vi.mocked(model.plan).mock.calls[0]?.[0];
    expect(input).toEqual({
      goal: {
        id: REQUEST.goal,
        title: REQUEST.title,
        detail: REQUEST.detail,
        constraints: REQUEST.constraints,
      },
      outputSchema: SUPERVISOR_PLAN_JSON_SCHEMA,
    });
    expect(JSON.stringify(input)).not.toContain(REQUEST.operationToken);
    expect(JSON.stringify(input)).not.toContain(REQUEST.causedBy);
    expect(Object.isFrozen(input)).toBe(true);
  });

  it("rejects cycles after id mapping without admitting anything", async () => {
    const cyclic = {
      ...PLAN,
      tasks: [
        { ...PLAN.tasks[0], dependsOn: ["research"] },
        { ...PLAN.tasks[1], dependsOn: ["implement"] },
      ],
      decisions: [],
    };
    const { admitted, planner } = harness({
      model: { plan: () => cyclic },
      ids: ["TASK-101", "TASK-102"],
    });
    await expect(planner.plan(REQUEST)).rejects.toMatchObject({ code: "GRAPH_FAILURE" });
    expect(admitted).toEqual([]);
  });

  it.each([
    [
      "invalid request",
      { request: { ...REQUEST, actor: "model" }, expected: "INVALID_REQUEST" },
    ],
    [
      "invalid model plan",
      { model: { plan: () => ({ tasks: [] }) }, expected: "INVALID_PLAN" },
    ],
    ["invalid allocated id", { ids: ["model-id"], expected: "INVALID_ID" }],
    [
      "duplicate allocated id",
      { ids: ["TASK-101", "TASK-101", "TASK-102"], expected: "INVALID_ID" },
    ],
  ] as const)("fails closed on %s", async (_label, scenario) => {
    const { admitted, admission, model, planner } = harness({
      ...(scenario.model ? { model: scenario.model } : {}),
      ...(scenario.ids ? { ids: scenario.ids } : {}),
    });
    await expect(
      planner.plan("request" in scenario ? scenario.request : REQUEST),
    ).rejects.toMatchObject({ code: scenario.expected });
    expect(admitted).toEqual([]);
    if (scenario.expected === "INVALID_REQUEST")
      expect(model.plan).not.toHaveBeenCalled();
    if (scenario.expected === "INVALID_PLAN")
      expect(admission.currentTasks).not.toHaveBeenCalled();
  });

  it("wraps model, state and atomic admission failures without fallback writes", async () => {
    const modelFailure = harness({
      model: {
        plan: () => {
          throw new Error("model unavailable");
        },
      },
    });
    await expect(modelFailure.planner.plan(REQUEST)).rejects.toMatchObject({
      code: "MODEL_FAILURE",
    });
    expect(modelFailure.admitted).toEqual([]);

    const stateFailure = harness({
      admission: {
        currentTasks: () => {
          throw new Error("projection unavailable");
        },
      },
    });
    await expect(stateFailure.planner.plan(REQUEST)).rejects.toMatchObject({
      code: "GRAPH_FAILURE",
    });
    expect(stateFailure.admitted).toEqual([]);

    const admit = vi.fn(() => {
      throw new Error("transaction rolled back");
    });
    const atomicFailure = harness({ admission: { admit } });
    await expect(atomicFailure.planner.plan(REQUEST)).rejects.toMatchObject({
      code: "ADMISSION_FAILURE",
    });
    expect(admit).toHaveBeenCalledOnce();
  });
});
