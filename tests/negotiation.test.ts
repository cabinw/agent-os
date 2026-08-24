import { describe, expect, it, vi } from "vitest";
import { newEventId, parseStoredEvent } from "../packages/event-core/src/index.js";
import type {
  Actor,
  EventPayload,
  EventType,
  StoredEvent,
} from "../packages/event-core/src/index.js";
import {
  NegotiationProjectionError,
  NegotiationResolutionError,
  createNegotiationResolutionService,
  emptyNegotiationProjectState,
  reduceNegotiationProject,
} from "../packages/supervisor/src/index.js";
import type {
  NegotiationProjectState,
  NegotiationState,
} from "../packages/supervisor/src/index.js";

const PROJECT = "proj_negotiation";
const NEGOTIATION = "negotiation-001";
const AT = "2026-08-24T12:00:00Z";

function event<Type extends EventType>(
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
    subject: { kind: "negotiation", id: NEGOTIATION },
    at: AT,
    ...(causedBy === undefined ? {} : { causedBy }),
    payload,
  }) as StoredEvent<Type>;
}

function opened(architectureChange = true) {
  return event(
    1,
    "negotiation.opened",
    {
      topic: "Event admission boundary",
      proposal: "Keep one runtime-owned event writer.",
      rationale: "It preserves deterministic authority.",
      proposedBy: "architect" as never,
      participants: ["architect", "reviewer"] as never,
      task: "TASK-001" as never,
      architectureChange,
    },
    { kind: "agent", id: "architect" as never },
  );
}

function objected(cause: string) {
  return event(
    2,
    "negotiation.objected",
    {
      by: "reviewer" as never,
      reason: "Failure semantics are underspecified.",
      alternative: "Use a transactional admission port.",
    },
    { kind: "agent", id: "reviewer" as never },
    cause,
  );
}

function escalated(cause: string) {
  return event(
    3,
    "negotiation.escalated",
    {
      by: "reviewer" as never,
      reason: "The architecture options remain incompatible.",
      to: "human-owner" as never,
    },
    { kind: "agent", id: "reviewer" as never },
    cause,
  );
}

function reduce(...events: StoredEvent[]): NegotiationProjectState {
  return events.reduce(reduceNegotiationProject, emptyNegotiationProjectState());
}

function architectureEscalation() {
  const open = opened();
  const objection = objected(open.id);
  const escalation = escalated(objection.id);
  return { escalation, objection, open, state: reduce(open, objection, escalation) };
}

describe("RM-5.1 · immutable negotiation projection", () => {
  it("replays an architecture objection through escalation and human resolution", () => {
    const { escalation, objection, open, state } = architectureEscalation();
    const resolution = event(
      4,
      "negotiation.resolved",
      {
        by: "human-owner" as never,
        decision: "Use the transactional admission port.",
        rationale: "It keeps one writer and makes failure atomic.",
      },
      { kind: "human", id: "human-owner" as never },
      escalation.id,
    );
    const resolved = reduceNegotiationProject(state, resolution);
    expect(resolved.negotiations[NEGOTIATION]).toMatchObject({
      status: "resolved",
      openedEvent: open.id,
      lastEvent: resolution.id,
      objections: [{ event: objection.id, by: "reviewer" }],
      escalation: { event: escalation.id, to: "human-owner" },
      resolution: { event: resolution.id, by: "human-owner" },
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.negotiations)).toBe(true);
    expect(Object.isFrozen(resolved.negotiations[NEGOTIATION]?.objections)).toBe(true);
  });

  it("allows participants to resolve an un-escalated non-architecture objection", () => {
    const open = opened(false);
    const objection = objected(open.id);
    const resolution = event(
      3,
      "negotiation.resolved",
      {
        by: "architect" as never,
        decision: "Adopt the alternative.",
        rationale: "The reviewer supplied stronger evidence.",
      },
      { kind: "agent", id: "architect" as never },
      objection.id,
    );
    expect(reduce(open, objection, resolution).negotiations[NEGOTIATION]?.status).toBe(
      "resolved",
    );
  });

  it("rejects stale causes, cross-project events and invalid transitions", () => {
    const open = opened();
    const objection = objected(open.id);
    expect(() => reduce(open, objected(newEventId()))).toThrowError(
      expect.objectContaining({ code: "INVALID_CAUSE" }),
    );
    expect(() =>
      reduceNegotiationProject(
        reduce(open),
        event(
          2,
          "negotiation.objected",
          objection.payload,
          objection.actor,
          open.id,
          "proj_other",
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PROJECT" }));
    expect(() => reduce(open, escalated(open.id))).toThrowError(
      expect.objectContaining({ code: "INVALID_TRANSITION" }),
    );
    const duplicate = event(
      3,
      "negotiation.objected",
      objection.payload,
      objection.actor,
      objection.id,
    );
    expect(() => reduce(open, objection, duplicate)).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_OBJECTION" }),
    );
    expect(() => reduce(open, open)).toThrow(NegotiationProjectionError);
  });

  it("requires architecture objections to be resolved by the escalation target", () => {
    const open = opened();
    const objection = objected(open.id);
    const agentResolution = event(
      3,
      "negotiation.resolved",
      {
        by: "architect" as never,
        decision: "Ignore the objection.",
        rationale: "The proposal is sufficient.",
      },
      { kind: "agent", id: "architect" as never },
      objection.id,
    );
    expect(() => reduce(open, objection, agentResolution)).toThrowError(
      expect.objectContaining({ code: "INVALID_TRANSITION" }),
    );

    const escalation = escalated(objection.id);
    const wrongHuman = event(
      4,
      "negotiation.resolved",
      {
        by: "another-human" as never,
        decision: "Use the alternative.",
        rationale: "It is safer.",
      },
      { kind: "human", id: "another-human" as never },
      escalation.id,
    );
    expect(() => reduce(open, objection, escalation, wrongHuman)).toThrowError(
      expect.objectContaining({ code: "INVALID_TRANSITION" }),
    );
  });
});

describe("RM-5.1 · human negotiation resolution boundary", () => {
  function request() {
    return {
      project: PROJECT as never,
      negotiation: NEGOTIATION as never,
      human: { kind: "human" as const, id: "human-owner" as never },
      decision: "Use the transactional admission port.",
      rationale: "It keeps event admission atomic and replayable.",
      operationToken: "resolve-negotiation-001",
    };
  }

  it("builds one causal resolution plus a sourced Memory decision command", async () => {
    const { escalation, state } = architectureEscalation();
    const negotiation = state.negotiations[NEGOTIATION] as NegotiationState;
    const resolve = vi.fn(async () => undefined);
    const service = createNegotiationResolutionService({
      negotiation: async () => negotiation,
      resolve,
    });
    const command = await service.resolve(request());
    expect(command).toMatchObject({
      causedBy: escalation.id,
      by: "human-owner",
      operationToken: "resolve-negotiation-001",
      memory: {
        type: "decision",
        title: "Event admission boundary",
        relatedTasks: ["TASK-001"],
        alternatives: [
          "Keep one runtime-owned event writer.",
          "Use a transactional admission port.",
        ],
      },
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith(command);
    expect(Object.isFrozen(command.memory.alternatives)).toBe(true);
  });

  it("fails closed for missing, premature, wrong-target and failed admission", async () => {
    await expect(
      createNegotiationResolutionService({
        negotiation: async () => null,
        resolve: async () => undefined,
      }).resolve(request()),
    ).rejects.toMatchObject({ code: "MISSING_NEGOTIATION" });

    const openState = reduce(opened()).negotiations[NEGOTIATION] as NegotiationState;
    await expect(
      createNegotiationResolutionService({
        negotiation: async () => openState,
        resolve: async () => undefined,
      }).resolve(request()),
    ).rejects.toMatchObject({ code: "NOT_ESCALATED" });

    const negotiation = architectureEscalation().state.negotiations[
      NEGOTIATION
    ] as NegotiationState;
    const service = createNegotiationResolutionService({
      negotiation: async () => negotiation,
      resolve: async () => {
        throw new Error("store offline");
      },
    });
    await expect(
      service.resolve({
        ...request(),
        human: { kind: "human", id: "another-human" as never },
      }),
    ).rejects.toMatchObject({ code: "NOT_ESCALATION_TARGET" });
    await expect(service.resolve(request())).rejects.toBeInstanceOf(
      NegotiationResolutionError,
    );
    await expect(service.resolve(request())).rejects.toMatchObject({
      code: "RESOLUTION_FAILURE",
    });
  });
});
