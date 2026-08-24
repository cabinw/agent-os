import type { EntityId, EventId, ProjectId, TaskId } from "@agent-os/event-core";
import type { NegotiationState } from "./negotiation.js";

type Awaitable<Value> = Value | Promise<Value>;

export type HumanNegotiationResolutionRequest = Readonly<{
  project: ProjectId;
  negotiation: EntityId;
  human: Readonly<{ kind: "human"; id: EntityId }>;
  decision: string;
  rationale: string;
  operationToken: string;
}>;

export type NegotiationResolutionCommand = Readonly<{
  project: ProjectId;
  negotiation: EntityId;
  by: EntityId;
  decision: string;
  rationale: string;
  causedBy: EventId;
  operationToken: string;
  memory: Readonly<{
    type: "decision";
    title: string;
    summary: string;
    rationale: string;
    alternatives: readonly string[];
    relatedTasks: readonly TaskId[];
  }>;
}>;

export interface NegotiationResolutionPort {
  negotiation(
    project: ProjectId,
    negotiation: EntityId,
  ): Awaitable<NegotiationState | null>;
  resolve(command: NegotiationResolutionCommand): Awaitable<void>;
}

export class NegotiationResolutionError extends Error {
  readonly code:
    | "INVALID_REQUEST"
    | "MISSING_NEGOTIATION"
    | "NOT_ESCALATION_TARGET"
    | "NOT_ESCALATED"
    | "RESOLUTION_FAILURE";

  constructor(
    code: NegotiationResolutionError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NegotiationResolutionError";
    this.code = code;
  }
}

function requiredText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function assertRequest(request: HumanNegotiationResolutionRequest): void {
  if (
    request === null ||
    typeof request !== "object" ||
    request.human?.kind !== "human" ||
    !requiredText(request.project) ||
    !requiredText(request.negotiation) ||
    !requiredText(request.human.id) ||
    !requiredText(request.decision) ||
    !requiredText(request.rationale) ||
    !requiredText(request.operationToken)
  ) {
    throw new NegotiationResolutionError(
      "INVALID_REQUEST",
      "human negotiation resolution request is invalid",
    );
  }
}

function command(
  request: HumanNegotiationResolutionRequest,
  negotiation: NegotiationState,
): NegotiationResolutionCommand {
  const alternatives = [
    ...new Set([
      negotiation.proposal,
      ...negotiation.objections.map((objection) => objection.alternative),
    ]),
  ];
  return Object.freeze({
    project: request.project,
    negotiation: request.negotiation,
    by: request.human.id,
    decision: request.decision,
    rationale: request.rationale,
    causedBy: negotiation.escalation?.event as EventId,
    operationToken: request.operationToken,
    memory: Object.freeze({
      type: "decision",
      title: negotiation.topic,
      summary: request.decision,
      rationale: request.rationale,
      alternatives: Object.freeze(alternatives),
      relatedTasks: Object.freeze(
        negotiation.task === undefined ? [] : [negotiation.task],
      ),
    }),
  });
}

export function createNegotiationResolutionService(
  port: NegotiationResolutionPort,
): Readonly<{
  resolve(
    request: HumanNegotiationResolutionRequest,
  ): Promise<NegotiationResolutionCommand>;
}> {
  if (
    port === null ||
    typeof port !== "object" ||
    typeof port.negotiation !== "function" ||
    typeof port.resolve !== "function"
  ) {
    throw new TypeError("NegotiationResolutionPort is invalid");
  }
  return Object.freeze({
    async resolve(request: HumanNegotiationResolutionRequest) {
      assertRequest(request);
      const negotiation = await port.negotiation(request.project, request.negotiation);
      if (negotiation === null) {
        throw new NegotiationResolutionError(
          "MISSING_NEGOTIATION",
          `negotiation ${request.negotiation} does not exist`,
        );
      }
      if (negotiation.status !== "escalated" || negotiation.escalation === undefined) {
        throw new NegotiationResolutionError(
          "NOT_ESCALATED",
          `negotiation ${request.negotiation} is not awaiting human resolution`,
        );
      }
      if (negotiation.escalation.to !== request.human.id) {
        throw new NegotiationResolutionError(
          "NOT_ESCALATION_TARGET",
          `human ${request.human.id} is not the escalation target`,
        );
      }
      const resolution = command(request, negotiation);
      try {
        await port.resolve(resolution);
      } catch (cause) {
        throw new NegotiationResolutionError(
          "RESOLUTION_FAILURE",
          "negotiation resolution was not durably admitted",
          { cause },
        );
      }
      return resolution;
    },
  });
}
