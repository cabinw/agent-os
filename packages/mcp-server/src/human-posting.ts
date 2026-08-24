import {
  type DeepReadonly,
  type EntityId,
  type EventId,
  type EventInput,
  type ProjectId,
  type StoredEvent,
  type TaskId,
  entityIdSchema,
  nonEmptyStringSchema,
  parseEventInput,
  parseStoredEvent,
  projectIdSchema,
  taskIdSchema,
} from "@agent-os/event-core";
import { z } from "zod";

export type HumanPostingPolicy = DeepReadonly<{
  project: ProjectId;
  enabled: boolean;
  sourceEvents: readonly EventId[];
}>;

export type HumanPostingPolicySource = Readonly<{
  project: ProjectId;
  history: readonly unknown[];
}>;

export type HumanMessageCommand = DeepReadonly<{
  to: EntityId | "*";
  task?: TaskId;
  content: string;
  clientToken: string;
}>;

export interface HumanMessageWriter {
  append(
    input: EventInput<"message.sent">,
    options: Readonly<{ token: string }>,
  ): StoredEvent<"message.sent"> | Promise<StoredEvent<"message.sent">>;
}

export type HumanPostingServiceOptions = Readonly<{
  project: ProjectId;
  human: EntityId;
  policy: () => HumanPostingPolicy;
  writer: HumanMessageWriter;
}>;

export interface HumanPostingService {
  send(command: HumanMessageCommand): Promise<StoredEvent<"message.sent">>;
}

export class HumanPostingCommandError extends Error {
  readonly code: "DISABLED" | "INVALID_COMMAND" | "INVALID_OPTIONS" | "POLICY_MISMATCH";

  constructor(
    code: HumanPostingCommandError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HumanPostingCommandError";
    this.code = code;
  }
}

function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return length;
}

const humanMessageCommandSchema = z.strictObject({
  to: z.union([entityIdSchema, z.literal("*")]),
  task: taskIdSchema.optional(),
  content: nonEmptyStringSchema,
  clientToken: nonEmptyStringSchema.refine((value) => utf8ByteLength(value) <= 256, {
    error: "client token exceeds 256 UTF-8 bytes",
  }),
});

export class HumanPostingPolicyError extends Error {
  readonly code:
    | "INVALID_HISTORY"
    | "MIXED_PROJECT"
    | "SEQUENCE_GAP"
    | "DUPLICATE_EVENT"
    | "MISSING_PROJECT";

  constructor(
    code: HumanPostingPolicyError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HumanPostingPolicyError";
    this.code = code;
  }
}

function freeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value as DeepReadonly<Value>;
}

export function buildHumanPostingPolicy(
  source: HumanPostingPolicySource,
): HumanPostingPolicy {
  const seen = new Set<string>();
  const history = source.history.map((value, index) => {
    let event: StoredEvent;
    try {
      event = parseStoredEvent(value);
    } catch (cause) {
      throw new HumanPostingPolicyError(
        "INVALID_HISTORY",
        `history[${index}] is invalid`,
        { cause },
      );
    }
    if (event.project !== source.project) {
      throw new HumanPostingPolicyError(
        "MIXED_PROJECT",
        `history[${index}] belongs to ${event.project}`,
      );
    }
    if (Number(event.seq) !== index + 1) {
      throw new HumanPostingPolicyError(
        "SEQUENCE_GAP",
        `history[${index}] must have seq ${index + 1}`,
      );
    }
    if (seen.has(event.id)) {
      throw new HumanPostingPolicyError(
        "DUPLICATE_EVENT",
        `event ${event.id} appears more than once`,
      );
    }
    seen.add(event.id);
    return event;
  });
  const created = history[0];
  if (created?.type !== "project.created") {
    throw new HumanPostingPolicyError(
      "MISSING_PROJECT",
      "human posting policy history must start with project.created",
    );
  }
  if (history.slice(1).some((event) => event.type === "project.created")) {
    throw new HumanPostingPolicyError(
      "INVALID_HISTORY",
      "human posting policy history contains duplicate project.created",
    );
  }
  let configured: StoredEvent<"project.human.participation.configured"> | undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    if (event?.type === "project.human.participation.configured") {
      configured = event;
      break;
    }
  }
  return freeze({
    project: source.project,
    enabled: configured?.payload.enabled ?? false,
    sourceEvents: [configured?.id ?? created.id],
  });
}

export function createHumanPostingService(
  options: HumanPostingServiceOptions,
): HumanPostingService {
  const project = projectIdSchema.safeParse(options?.project);
  const human = entityIdSchema.safeParse(options?.human);
  if (
    !project.success ||
    !human.success ||
    typeof options?.policy !== "function" ||
    options.writer === null ||
    typeof options?.writer !== "object" ||
    typeof options.writer.append !== "function"
  ) {
    throw new HumanPostingCommandError(
      "INVALID_OPTIONS",
      "project, authenticated human, policy provider, and message writer are required",
    );
  }

  return Object.freeze({
    async send(value: HumanMessageCommand): Promise<StoredEvent<"message.sent">> {
      const parsed = humanMessageCommandSchema.safeParse(value);
      if (!parsed.success) {
        throw new HumanPostingCommandError(
          "INVALID_COMMAND",
          "invalid human message command",
          {
            cause: parsed.error,
          },
        );
      }
      const policy = options.policy();
      if (policy.project !== project.data) {
        throw new HumanPostingCommandError(
          "POLICY_MISMATCH",
          `human posting policy belongs to ${policy.project}`,
        );
      }
      if (!policy.enabled) {
        throw new HumanPostingCommandError(
          "DISABLED",
          `human posting is disabled for ${project.data}`,
        );
      }
      const input = parseEventInput({
        type: "message.sent",
        project: project.data,
        actor: { kind: "human", id: human.data },
        subject: parsed.data.task
          ? { kind: "task", id: parsed.data.task }
          : { kind: "project", id: project.data },
        payload: {
          from: human.data,
          to: parsed.data.to,
          type: "instruction",
          ...(parsed.data.task === undefined ? {} : { task: parsed.data.task }),
          content: parsed.data.content,
        },
      }) as EventInput<"message.sent">;
      return await options.writer.append(input, { token: parsed.data.clientToken });
    },
  });
}
