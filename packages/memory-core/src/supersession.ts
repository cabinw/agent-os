import {
  eventIdSchema,
  knowledgeIdSchema,
  nonEmptyStringSchema,
  projectIdSchema,
} from "@agent-os/event-core";
import type { EventId, KnowledgeId, ProjectId } from "@agent-os/event-core";
import { assertKnowledgeSupersession, parseKnowledgeProjectState } from "./projection.js";
import type { KnowledgeProjectState } from "./projection.js";

type Awaitable<Value> = Value | Promise<Value>;

export type KnowledgeSupersessionRequest = Readonly<{
  project: ProjectId;
  old: KnowledgeId;
  new: KnowledgeId;
  causedBy: EventId;
  operationToken: string;
}>;

export type KnowledgeSupersessionCommand = KnowledgeSupersessionRequest &
  Readonly<{
    oldCreatedEvent: EventId;
    newCreatedEvent: EventId;
  }>;

export interface KnowledgeSupersessionPort {
  current(project: ProjectId): Awaitable<KnowledgeProjectState>;
  admit(command: KnowledgeSupersessionCommand): Awaitable<void>;
}

export type KnowledgeSupersederOptions = Readonly<{
  port: KnowledgeSupersessionPort;
}>;

export type KnowledgeSupersessionErrorCode =
  | "ADMISSION_FAILURE"
  | "INVALID_OPTIONS"
  | "INVALID_REQUEST"
  | "INVALID_STATE";

export class KnowledgeSupersessionError extends Error {
  readonly code: KnowledgeSupersessionErrorCode;

  constructor(
    code: KnowledgeSupersessionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KnowledgeSupersessionError";
    this.code = code;
  }
}

function parseRequest(value: KnowledgeSupersessionRequest): KnowledgeSupersessionRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new KnowledgeSupersessionError(
      "INVALID_REQUEST",
      "knowledge supersession request is required",
    );
  }
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        key !== "project" &&
        key !== "old" &&
        key !== "new" &&
        key !== "causedBy" &&
        key !== "operationToken",
    )
  ) {
    throw new KnowledgeSupersessionError(
      "INVALID_REQUEST",
      "knowledge supersession request has unknown fields",
    );
  }
  const project = projectIdSchema.safeParse(value.project);
  const old = knowledgeIdSchema.safeParse(value.old);
  const next = knowledgeIdSchema.safeParse(value.new);
  const causedBy = eventIdSchema.safeParse(value.causedBy);
  const operationToken = nonEmptyStringSchema.max(256).safeParse(value.operationToken);
  if (
    !project.success ||
    !old.success ||
    !next.success ||
    old.data === next.data ||
    !causedBy.success ||
    !operationToken.success
  ) {
    throw new KnowledgeSupersessionError(
      "INVALID_REQUEST",
      "knowledge supersession authority is invalid",
    );
  }
  return Object.freeze({
    project: project.data,
    old: old.data,
    new: next.data,
    causedBy: causedBy.data,
    operationToken: operationToken.data,
  });
}

export class KnowledgeSuperseder {
  readonly #port: KnowledgeSupersessionPort;

  constructor(options: KnowledgeSupersederOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      options.port === null ||
      typeof options.port !== "object" ||
      typeof options.port.current !== "function" ||
      typeof options.port.admit !== "function"
    ) {
      throw new KnowledgeSupersessionError(
        "INVALID_OPTIONS",
        "KnowledgeSupersessionPort.current/admit are required",
      );
    }
    this.#port = options.port;
  }

  async supersede(
    requestValue: KnowledgeSupersessionRequest,
  ): Promise<KnowledgeSupersessionCommand> {
    const request = parseRequest(requestValue);
    let state: KnowledgeProjectState;
    try {
      state = parseKnowledgeProjectState(
        await this.#port.current(request.project),
        request.project,
      );
      const { old, next } = assertKnowledgeSupersession(state, request.old, request.new);
      const command: KnowledgeSupersessionCommand = Object.freeze({
        ...request,
        oldCreatedEvent: old.createdEvent,
        newCreatedEvent: next.createdEvent,
      });
      try {
        await this.#port.admit(command);
      } catch (cause) {
        throw new KnowledgeSupersessionError(
          "ADMISSION_FAILURE",
          "knowledge supersession admission failed",
          { cause },
        );
      }
      return command;
    } catch (cause) {
      if (cause instanceof KnowledgeSupersessionError) throw cause;
      throw new KnowledgeSupersessionError(
        "INVALID_STATE",
        "knowledge supersession state is invalid",
        { cause },
      );
    }
  }
}

export function createKnowledgeSuperseder(
  options: KnowledgeSupersederOptions,
): KnowledgeSuperseder {
  return new KnowledgeSuperseder(options);
}
