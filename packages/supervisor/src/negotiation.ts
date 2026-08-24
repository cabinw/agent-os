import type {
  EntityId,
  EventBus,
  EventId,
  ProjectId,
  ReducerHandle,
  StoredEvent,
  TaskId,
} from "@agent-os/event-core";

export const NEGOTIATION_STATUSES = Object.freeze([
  "open",
  "objected",
  "escalated",
  "resolved",
] as const);
export type NegotiationStatus = (typeof NEGOTIATION_STATUSES)[number];

export type NegotiationObjection = Readonly<{
  by: EntityId;
  reason: string;
  alternative: string;
  event: EventId;
  at: string;
}>;

export type NegotiationEscalation = Readonly<{
  by: EntityId;
  to: EntityId;
  reason: string;
  event: EventId;
  at: string;
}>;

export type NegotiationResolution = Readonly<{
  by: EntityId;
  decision: string;
  rationale: string;
  event: EventId;
  at: string;
}>;

export type NegotiationState = Readonly<{
  id: EntityId;
  project: ProjectId;
  topic: string;
  proposal: string;
  rationale: string;
  proposedBy: EntityId;
  participants: readonly EntityId[];
  task?: TaskId;
  architectureChange: boolean;
  status: NegotiationStatus;
  objections: readonly NegotiationObjection[];
  escalation?: NegotiationEscalation;
  resolution?: NegotiationResolution;
  openedEvent: EventId;
  lastEvent: EventId;
  openedAt: string;
}>;

export type NegotiationProjectState = Readonly<{
  negotiations: Readonly<Record<string, NegotiationState>>;
}>;

export class NegotiationProjectionError extends Error {
  readonly code:
    | "DUPLICATE_NEGOTIATION"
    | "DUPLICATE_OBJECTION"
    | "INVALID_ACTOR"
    | "INVALID_CAUSE"
    | "INVALID_PARTICIPANT"
    | "INVALID_PROJECT"
    | "INVALID_TRANSITION"
    | "MISSING_NEGOTIATION";
  readonly negotiation: string;

  constructor(
    code: NegotiationProjectionError["code"],
    message: string,
    negotiation: string,
  ) {
    super(message);
    this.name = "NegotiationProjectionError";
    this.code = code;
    this.negotiation = negotiation;
  }
}

function freeze<Value>(value: Value): Readonly<Value> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value;
}

export function emptyNegotiationProjectState(): NegotiationProjectState {
  return freeze({ negotiations: {} });
}

function requireNegotiation(
  state: NegotiationProjectState,
  id: string,
): NegotiationState {
  const negotiation = state.negotiations[id];
  if (negotiation === undefined) {
    throw new NegotiationProjectionError(
      "MISSING_NEGOTIATION",
      `negotiation ${id} does not exist`,
      id,
    );
  }
  return negotiation;
}

function assertCause(negotiation: NegotiationState, event: StoredEvent): void {
  if (event.project !== negotiation.project) {
    throw new NegotiationProjectionError(
      "INVALID_PROJECT",
      `negotiation ${negotiation.id} belongs to project ${negotiation.project}`,
      negotiation.id,
    );
  }
  if (event.causedBy !== negotiation.lastEvent) {
    throw new NegotiationProjectionError(
      "INVALID_CAUSE",
      `negotiation ${negotiation.id} must continue from ${negotiation.lastEvent}`,
      negotiation.id,
    );
  }
}

function assertParticipant(negotiation: NegotiationState, by: EntityId): void {
  if (!negotiation.participants.includes(by)) {
    throw new NegotiationProjectionError(
      "INVALID_PARTICIPANT",
      `agent ${by} is not a participant in negotiation ${negotiation.id}`,
      negotiation.id,
    );
  }
}

function replace(
  state: NegotiationProjectState,
  negotiation: NegotiationState,
): NegotiationProjectState {
  return freeze({
    negotiations: {
      ...state.negotiations,
      [negotiation.id]: negotiation,
    },
  });
}

function openNegotiation(
  state: NegotiationProjectState,
  event: StoredEvent<"negotiation.opened">,
): NegotiationProjectState {
  const id = event.subject.id;
  if (state.negotiations[id] !== undefined) {
    throw new NegotiationProjectionError(
      "DUPLICATE_NEGOTIATION",
      `negotiation ${id} is already open`,
      id,
    );
  }
  if (event.actor.kind !== "agent" || event.actor.id !== event.payload.proposedBy) {
    throw new NegotiationProjectionError(
      "INVALID_ACTOR",
      `negotiation ${id} proposer must match its agent actor`,
      id,
    );
  }
  return replace(state, {
    id,
    project: event.project,
    topic: event.payload.topic,
    proposal: event.payload.proposal,
    rationale: event.payload.rationale,
    proposedBy: event.payload.proposedBy,
    participants: event.payload.participants,
    ...(event.payload.task === undefined ? {} : { task: event.payload.task }),
    architectureChange: event.payload.architectureChange,
    status: "open",
    objections: [],
    openedEvent: event.id,
    lastEvent: event.id,
    openedAt: event.at,
  });
}

function objectNegotiation(
  state: NegotiationProjectState,
  event: StoredEvent<"negotiation.objected">,
): NegotiationProjectState {
  const negotiation = requireNegotiation(state, event.subject.id);
  if (negotiation.status !== "open" && negotiation.status !== "objected") {
    throw new NegotiationProjectionError(
      "INVALID_TRANSITION",
      `negotiation ${negotiation.id} cannot be objected while ${negotiation.status}`,
      negotiation.id,
    );
  }
  assertCause(negotiation, event);
  assertParticipant(negotiation, event.payload.by);
  if (event.payload.by === negotiation.proposedBy) {
    throw new NegotiationProjectionError(
      "INVALID_PARTICIPANT",
      "the proposer cannot object to its own proposal",
      negotiation.id,
    );
  }
  if (negotiation.objections.some((objection) => objection.by === event.payload.by)) {
    throw new NegotiationProjectionError(
      "DUPLICATE_OBJECTION",
      `agent ${event.payload.by} already objected`,
      negotiation.id,
    );
  }
  return replace(state, {
    ...negotiation,
    status: "objected",
    objections: [
      ...negotiation.objections,
      {
        by: event.payload.by,
        reason: event.payload.reason,
        alternative: event.payload.alternative,
        event: event.id,
        at: event.at,
      },
    ],
    lastEvent: event.id,
  });
}

function escalateNegotiation(
  state: NegotiationProjectState,
  event: StoredEvent<"negotiation.escalated">,
): NegotiationProjectState {
  const negotiation = requireNegotiation(state, event.subject.id);
  if (negotiation.status !== "objected") {
    throw new NegotiationProjectionError(
      "INVALID_TRANSITION",
      `negotiation ${negotiation.id} requires an objection before escalation`,
      negotiation.id,
    );
  }
  assertCause(negotiation, event);
  assertParticipant(negotiation, event.payload.by);
  return replace(state, {
    ...negotiation,
    status: "escalated",
    escalation: {
      by: event.payload.by,
      to: event.payload.to,
      reason: event.payload.reason,
      event: event.id,
      at: event.at,
    },
    lastEvent: event.id,
  });
}

function resolveNegotiation(
  state: NegotiationProjectState,
  event: StoredEvent<"negotiation.resolved">,
): NegotiationProjectState {
  const negotiation = requireNegotiation(state, event.subject.id);
  if (negotiation.status === "resolved") {
    throw new NegotiationProjectionError(
      "INVALID_TRANSITION",
      `negotiation ${negotiation.id} is already resolved`,
      negotiation.id,
    );
  }
  assertCause(negotiation, event);
  if (negotiation.architectureChange && negotiation.objections.length > 0) {
    if (
      negotiation.status !== "escalated" ||
      event.actor.kind !== "human" ||
      event.actor.id !== negotiation.escalation?.to
    ) {
      throw new NegotiationProjectionError(
        "INVALID_TRANSITION",
        "an architecture objection must be escalated and resolved by its human target",
        negotiation.id,
      );
    }
  } else if (negotiation.status === "escalated") {
    if (event.actor.kind !== "human" || event.actor.id !== negotiation.escalation?.to) {
      throw new NegotiationProjectionError(
        "INVALID_ACTOR",
        "an escalated negotiation must be resolved by its human target",
        negotiation.id,
      );
    }
  } else {
    if (event.actor.kind !== "agent") {
      throw new NegotiationProjectionError(
        "INVALID_ACTOR",
        "an un-escalated negotiation must be resolved by a participating agent",
        negotiation.id,
      );
    }
    assertParticipant(negotiation, event.payload.by);
  }
  return replace(state, {
    ...negotiation,
    status: "resolved",
    resolution: {
      by: event.payload.by,
      decision: event.payload.decision,
      rationale: event.payload.rationale,
      event: event.id,
      at: event.at,
    },
    lastEvent: event.id,
  });
}

export function reduceNegotiationProject(
  state: NegotiationProjectState,
  event: StoredEvent,
): NegotiationProjectState {
  switch (event.type) {
    case "negotiation.opened":
      return openNegotiation(state, event);
    case "negotiation.objected":
      return objectNegotiation(state, event);
    case "negotiation.escalated":
      return escalateNegotiation(state, event);
    case "negotiation.resolved":
      return resolveNegotiation(state, event);
    default:
      return state;
  }
}

export function registerNegotiationReducer(
  bus: EventBus,
  name = "negotiation",
): ReducerHandle<NegotiationProjectState> {
  return bus.registerReducer(
    name,
    emptyNegotiationProjectState,
    reduceNegotiationProject,
  );
}
