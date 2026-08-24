import { describe, expect, it, vi } from "vitest";
import { newEventId, parseStoredEvent } from "../packages/event-core/src/index.js";
import type {
  Actor,
  EventPayload,
  StoredEvent,
} from "../packages/event-core/src/index.js";
import {
  PlanProposalProjectionError,
  PlanProposalReviewError,
  createPlanProposalReviewService,
  emptyPlanProposalProjectState,
  reducePlanProposalProject,
} from "../packages/supervisor/src/index.js";
import type {
  PlanProposalReviewCommand,
  PlanProposalReviewPort,
  PlanProposalState,
} from "../packages/supervisor/src/index.js";
import type { TaskProjectState } from "../packages/task-engine/src/index.js";

const PROJECT = "proj_plan_proposal";
const PROPOSAL = "plan-proposal-001";
const AT = "2026-08-24T13:00:00Z";

function event<Type extends "plan.proposed" | "plan.accepted" | "plan.rejected">(
  seq: number,
  type: Type,
  payload: EventPayload<Type>,
  actor: Actor,
  causedBy?: string,
  project = PROJECT,
): StoredEvent<Type> {
  return parseStoredEvent({
    schemaVersion: 1,
    id: newEventId(),
    seq,
    type,
    project,
    actor,
    subject: { kind: "plan", id: PROPOSAL },
    at: AT,
    ...(causedBy === undefined ? {} : { causedBy }),
    payload,
  }) as StoredEvent<Type>;
}

function proposed() {
  return event(
    1,
    "plan.proposed",
    {
      title: "Add recovery verification",
      summary: "Add implementation and verification tasks.",
      rationale: "The current graph lacks recovery evidence.",
      proposedBy: "worker" as never,
      goal: "goal-release" as never,
      tasks: [
        {
          key: "implement-recovery",
          title: "Implement recovery",
          requires: ["coding"],
          priority: "high",
          dependsOn: [{ kind: "existing", task: "TASK-001" as never }],
          requiresApproval: false,
        },
        {
          key: "verify-recovery",
          title: "Verify recovery",
          requires: ["testing"],
          priority: "high",
          dependsOn: [{ kind: "proposed", key: "implement-recovery" }],
          requiresApproval: true,
        },
      ],
    },
    { kind: "agent", id: "worker" as never },
  );
}

function proposalState(): PlanProposalState {
  const proposal = proposed();
  return reducePlanProposalProject(emptyPlanProposalProjectState(), proposal).proposals[
    PROPOSAL
  ] as PlanProposalState;
}

function accepted(cause: string) {
  return event(
    2,
    "plan.accepted",
    {
      by: "supervisor" as never,
      rationale: "The graph closes a verified gap.",
      tasks: [
        { key: "implement-recovery", id: "TASK-010" as never },
        { key: "verify-recovery", id: "TASK-011" as never },
      ],
    },
    { kind: "agent", id: "supervisor" as never },
    cause,
  );
}

function currentTasks(): TaskProjectState {
  return {
    tasks: {
      "TASK-001": {
        id: "TASK-001",
        project: PROJECT,
        title: "Existing foundation",
        goal: "goal-release",
        requires: [],
        priority: "high",
        dependsOn: [],
        requiresApproval: false,
        status: "completed",
        progress: 100,
        owner: "supervisor",
        executor: "worker",
        outputs: [],
        createdBy: "supervisor",
        createdEvent: newEventId(),
        lastEvent: newEventId(),
        createdAt: AT,
        updatedAt: AT,
      },
    },
  } as never;
}

describe("RM-5.2 · durable plan proposal projection", () => {
  it("replays a complete proposal and exact accepted Task id mapping", () => {
    const proposal = proposed();
    const initial = reducePlanProposalProject(emptyPlanProposalProjectState(), proposal);
    const reviewed = reducePlanProposalProject(initial, accepted(proposal.id));
    expect(reviewed.proposals[PROPOSAL]).toMatchObject({
      status: "accepted",
      proposedBy: "worker",
      reviewedBy: "supervisor",
      acceptedTasks: {
        "implement-recovery": "TASK-010",
        "verify-recovery": "TASK-011",
      },
    });
    expect(Object.isFrozen(reviewed)).toBe(true);
    expect(Object.isFrozen(reviewed.proposals[PROPOSAL]?.tasks)).toBe(true);
    expect(Object.isFrozen(reviewed.proposals[PROPOSAL]?.acceptedTasks)).toBe(true);
  });

  it("retains a rejection without a Task mapping", () => {
    const proposal = proposed();
    const rejected = event(
      2,
      "plan.rejected",
      { by: "supervisor" as never, reason: "The work already exists." },
      { kind: "agent", id: "supervisor" as never },
      proposal.id,
    );
    const state = reducePlanProposalProject(
      reducePlanProposalProject(emptyPlanProposalProjectState(), proposal),
      rejected,
    ).proposals[PROPOSAL];
    expect(state).toMatchObject({
      status: "rejected",
      reviewRationale: "The work already exists.",
    });
    expect(state).not.toHaveProperty("acceptedTasks");
  });

  it("rejects stale, cross-project, self-reviewed and incomplete outcomes", () => {
    const proposal = proposed();
    const state = reducePlanProposalProject(emptyPlanProposalProjectState(), proposal);
    expect(() => reducePlanProposalProject(state, accepted(newEventId()))).toThrowError(
      expect.objectContaining({ code: "INVALID_CAUSE" }),
    );

    const crossProject = event(
      2,
      "plan.rejected",
      { by: "supervisor" as never, reason: "Not needed." },
      { kind: "agent", id: "supervisor" as never },
      proposal.id,
      "proj_other",
    );
    expect(() => reducePlanProposalProject(state, crossProject)).toThrowError(
      expect.objectContaining({ code: "INVALID_PROJECT" }),
    );

    const selfReview = event(
      2,
      "plan.rejected",
      { by: "worker" as never, reason: "Withdrawn." },
      { kind: "agent", id: "worker" as never },
      proposal.id,
    );
    expect(() => reducePlanProposalProject(state, selfReview)).toThrowError(
      expect.objectContaining({ code: "INVALID_ACTOR" }),
    );

    const incomplete = event(
      2,
      "plan.accepted",
      {
        by: "supervisor" as never,
        rationale: "Accept one task.",
        tasks: [{ key: "implement-recovery", id: "TASK-010" as never }],
      },
      { kind: "agent", id: "supervisor" as never },
      proposal.id,
    );
    expect(() => reducePlanProposalProject(state, incomplete)).toThrowError(
      expect.objectContaining({ code: "INVALID_MAPPING" }),
    );
    expect(() =>
      reducePlanProposalProject(
        reducePlanProposalProject(state, accepted(proposal.id)),
        accepted(proposal.id),
      ),
    ).toThrow(PlanProposalProjectionError);
  });
});

describe("RM-5.2 · trusted Supervisor proposal review", () => {
  function request(decision: "accept" | "reject" = "accept") {
    const common = {
      project: PROJECT,
      proposal: PROPOSAL,
      reviewer: { kind: "agent" as const, id: "supervisor" },
      operationToken: `review-${decision}-001`,
    };
    return decision === "accept"
      ? { ...common, decision, rationale: "The graph closes a verified gap." }
      : { ...common, decision, reason: "The work already exists." };
  }

  function harness(overrides: Partial<PlanProposalReviewPort> = {}) {
    const admitted: PlanProposalReviewCommand[] = [];
    const state = proposalState();
    const port: PlanProposalReviewPort = {
      proposal: vi.fn(async () => state),
      currentTasks: vi.fn(async () => currentTasks()),
      admit: vi.fn(async (command) => {
        admitted.push(command);
      }),
      ...overrides,
    };
    const service = createPlanProposalReviewService({
      port,
      taskIdFactory: (_key, index) => ["TASK-010", "TASK-011"][index] as never,
    });
    return { admitted, port, service, state };
  }

  it("maps both dependency forms, validates and atomically admits stable order", async () => {
    const { admitted, port, service, state } = harness();
    const command = await service.review(request());
    expect(command.outcome).toEqual({
      type: "plan.accepted",
      by: "supervisor",
      rationale: "The graph closes a verified gap.",
      tasks: [
        { key: "implement-recovery", id: "TASK-010" },
        { key: "verify-recovery", id: "TASK-011" },
      ],
    });
    expect(command.tasks.map((task) => task.id)).toEqual(["TASK-010", "TASK-011"]);
    expect(command.tasks[0]?.dependsOn).toEqual(["TASK-001"]);
    expect(command.tasks[1]?.dependsOn).toEqual(["TASK-010"]);
    expect(command.tasks.every((task) => task.goal === "goal-release")).toBe(true);
    expect(command.causedBy).toBe(state.proposedEvent);
    expect(port.admit).toHaveBeenCalledWith(command);
    expect(admitted).toEqual([command]);
    expect(Object.isFrozen(command.tasks[1]?.dependsOn)).toBe(true);
  });

  it("rejects with zero Task writes and does not read Task state", async () => {
    const { port, service } = harness();
    const command = await service.review(request("reject"));
    expect(command).toMatchObject({
      outcome: { type: "plan.rejected", reason: "The work already exists." },
      tasks: [],
    });
    expect(port.currentTasks).not.toHaveBeenCalled();
    expect(port.admit).toHaveBeenCalledOnce();
  });

  it("fails closed for missing, reviewed, self-reviewed and malformed requests", async () => {
    await expect(
      harness({ proposal: async () => null }).service.review(request()),
    ).rejects.toMatchObject({ code: "MISSING_PROPOSAL" });
    await expect(
      harness({
        proposal: async () => ({ ...proposalState(), status: "rejected" }),
      }).service.review(request()),
    ).rejects.toMatchObject({ code: "NOT_PENDING" });
    await expect(
      harness().service.review({
        ...request(),
        reviewer: { kind: "agent", id: "worker" },
      }),
    ).rejects.toMatchObject({ code: "SELF_REVIEW" });
    await expect(
      harness().service.review({ ...request(), actor: "forged" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      harness({
        proposal: async () => {
          throw new Error("projection offline");
        },
      }).service.review(request()),
    ).rejects.toMatchObject({ code: "PROJECTION_FAILURE" });
  });

  it("admits nothing on id, graph or atomic write failure", async () => {
    const invalidIdPort = harness().port;
    const invalidId = createPlanProposalReviewService({
      port: invalidIdPort,
      taskIdFactory: () => "model-id" as never,
    });
    await expect(invalidId.review(request())).rejects.toMatchObject({
      code: "INVALID_ID",
    });
    expect(invalidIdPort.admit).not.toHaveBeenCalled();

    const graph = harness({ currentTasks: async () => ({ tasks: {} }) as never });
    await expect(graph.service.review(request())).rejects.toMatchObject({
      code: "GRAPH_FAILURE",
    });
    expect(graph.port.admit).not.toHaveBeenCalled();

    const admission = harness({
      admit: async () => {
        throw new Error("transaction rolled back");
      },
    });
    await expect(admission.service.review(request())).rejects.toBeInstanceOf(
      PlanProposalReviewError,
    );
    await expect(admission.service.review(request())).rejects.toMatchObject({
      code: "ADMISSION_FAILURE",
    });
  });
});
