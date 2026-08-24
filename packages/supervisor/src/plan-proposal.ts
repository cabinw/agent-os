import type {
  EntityId,
  EventBus,
  EventId,
  EventPayload,
  ProjectId,
  ReducerHandle,
  StoredEvent,
  TaskId,
} from "@agent-os/event-core";

export const PLAN_PROPOSAL_STATUSES = Object.freeze([
  "proposed",
  "accepted",
  "rejected",
] as const);
export type PlanProposalStatus = (typeof PLAN_PROPOSAL_STATUSES)[number];
export type PlanProposalTask = EventPayload<"plan.proposed">["tasks"][number];

export type PlanProposalState = Readonly<{
  id: EntityId;
  project: ProjectId;
  goal: EntityId;
  title: string;
  summary: string;
  rationale: string;
  proposedBy: EntityId;
  tasks: readonly PlanProposalTask[];
  status: PlanProposalStatus;
  proposedEvent: EventId;
  proposedAt: string;
  reviewedBy?: EntityId;
  reviewRationale?: string;
  acceptedTasks?: Readonly<Record<string, TaskId>>;
  reviewedEvent?: EventId;
  reviewedAt?: string;
}>;

export type PlanProposalProjectState = Readonly<{
  proposals: Readonly<Record<string, PlanProposalState>>;
}>;

export class PlanProposalProjectionError extends Error {
  readonly code:
    | "DUPLICATE_PROPOSAL"
    | "INVALID_ACTOR"
    | "INVALID_CAUSE"
    | "INVALID_MAPPING"
    | "INVALID_PROJECT"
    | "INVALID_TRANSITION"
    | "MISSING_PROPOSAL";
  readonly proposal: string;

  constructor(
    code: PlanProposalProjectionError["code"],
    message: string,
    proposal: string,
  ) {
    super(message);
    this.name = "PlanProposalProjectionError";
    this.code = code;
    this.proposal = proposal;
  }
}

function freeze<Value>(value: Value): Readonly<Value> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export function emptyPlanProposalProjectState(): PlanProposalProjectState {
  return freeze({ proposals: {} });
}

function replace(
  state: PlanProposalProjectState,
  proposal: PlanProposalState,
): PlanProposalProjectState {
  return freeze({ proposals: { ...state.proposals, [proposal.id]: proposal } });
}

function requireProposal(state: PlanProposalProjectState, id: string): PlanProposalState {
  const proposal = state.proposals[id];
  if (proposal === undefined) {
    throw new PlanProposalProjectionError(
      "MISSING_PROPOSAL",
      `plan proposal ${id} does not exist`,
      id,
    );
  }
  return proposal;
}

function propose(
  state: PlanProposalProjectState,
  event: StoredEvent<"plan.proposed">,
): PlanProposalProjectState {
  const id = event.subject.id;
  if (state.proposals[id] !== undefined) {
    throw new PlanProposalProjectionError(
      "DUPLICATE_PROPOSAL",
      `plan proposal ${id} already exists`,
      id,
    );
  }
  if (event.actor.kind !== "agent" || event.actor.id !== event.payload.proposedBy) {
    throw new PlanProposalProjectionError(
      "INVALID_ACTOR",
      `plan proposal ${id} proposer must match its agent actor`,
      id,
    );
  }
  return replace(state, {
    id,
    project: event.project,
    goal: event.payload.goal,
    title: event.payload.title,
    summary: event.payload.summary,
    rationale: event.payload.rationale,
    proposedBy: event.payload.proposedBy,
    tasks: event.payload.tasks,
    status: "proposed",
    proposedEvent: event.id,
    proposedAt: event.at,
  });
}

function assertReview(
  proposal: PlanProposalState,
  event: StoredEvent<"plan.accepted" | "plan.rejected">,
): void {
  if (proposal.status !== "proposed") {
    throw new PlanProposalProjectionError(
      "INVALID_TRANSITION",
      `plan proposal ${proposal.id} is already ${proposal.status}`,
      proposal.id,
    );
  }
  if (event.actor.kind !== "agent" || event.actor.id !== event.payload.by) {
    throw new PlanProposalProjectionError(
      "INVALID_ACTOR",
      `plan proposal ${proposal.id} reviewer must match its agent actor`,
      proposal.id,
    );
  }
  if (event.project !== proposal.project) {
    throw new PlanProposalProjectionError(
      "INVALID_PROJECT",
      `plan proposal ${proposal.id} belongs to project ${proposal.project}`,
      proposal.id,
    );
  }
  if (event.causedBy !== proposal.proposedEvent) {
    throw new PlanProposalProjectionError(
      "INVALID_CAUSE",
      `plan proposal ${proposal.id} review must be caused by ${proposal.proposedEvent}`,
      proposal.id,
    );
  }
  if (event.payload.by === proposal.proposedBy) {
    throw new PlanProposalProjectionError(
      "INVALID_ACTOR",
      "a plan proposer cannot review its own proposal",
      proposal.id,
    );
  }
}

function accept(
  state: PlanProposalProjectState,
  event: StoredEvent<"plan.accepted">,
): PlanProposalProjectState {
  const proposal = requireProposal(state, event.subject.id);
  assertReview(proposal, event);
  const expected = [...proposal.tasks.map((task) => task.key)].sort();
  const actual = [...event.payload.tasks.map((task) => task.key)].sort();
  if (
    expected.length !== actual.length ||
    expected.some((key, index) => key !== actual[index])
  ) {
    throw new PlanProposalProjectionError(
      "INVALID_MAPPING",
      "accepted task mapping must cover every proposed key exactly once",
      proposal.id,
    );
  }
  return replace(state, {
    ...proposal,
    status: "accepted",
    reviewedBy: event.payload.by,
    reviewRationale: event.payload.rationale,
    acceptedTasks: Object.fromEntries(
      event.payload.tasks.map((task) => [task.key, task.id]),
    ),
    reviewedEvent: event.id,
    reviewedAt: event.at,
  });
}

function reject(
  state: PlanProposalProjectState,
  event: StoredEvent<"plan.rejected">,
): PlanProposalProjectState {
  const proposal = requireProposal(state, event.subject.id);
  assertReview(proposal, event);
  return replace(state, {
    ...proposal,
    status: "rejected",
    reviewedBy: event.payload.by,
    reviewRationale: event.payload.reason,
    reviewedEvent: event.id,
    reviewedAt: event.at,
  });
}

export function reducePlanProposalProject(
  state: PlanProposalProjectState,
  event: StoredEvent,
): PlanProposalProjectState {
  switch (event.type) {
    case "plan.proposed":
      return propose(state, event);
    case "plan.accepted":
      return accept(state, event);
    case "plan.rejected":
      return reject(state, event);
    default:
      return state;
  }
}

export function registerPlanProposalReducer(
  bus: EventBus,
  name = "plan-proposals",
): ReducerHandle<PlanProposalProjectState> {
  return bus.registerReducer(
    name,
    emptyPlanProposalProjectState,
    reducePlanProposalProject,
  );
}
