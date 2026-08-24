import { z } from "zod";
import { type EventId, newEventId } from "./id.js";
import { type DeepReadonly, deepFreeze } from "./immutable.js";
import {
  EVENT_TYPES,
  type EventPayload,
  type EventType,
  eventPayloadSchemas,
} from "./payloads.js";
import {
  type Actor,
  type EntityId,
  type ProjectId,
  type Seq,
  type Subject,
  type SubjectKind,
  type TaskId,
  actorSchema,
  eventIdSchema,
  positiveIntegerSchema,
  projectIdSchema,
  rfc3339Schema,
  subjectSchema,
  taskIdSchema,
} from "./primitives.js";

export const EVENT_SCHEMA_VERSION = 1 as const;

type SubjectOf<Kind extends SubjectKind, Id = EntityId> = DeepReadonly<{
  kind: Kind;
  id: Id;
}>;

/** The primary projection target permitted for one event type. */
export type EventSubject<Type extends EventType> = Type extends `agent.${string}`
  ? SubjectOf<"agent">
  : Type extends `task.${string}`
    ? SubjectOf<"task", TaskId>
    : Type extends "message.sent"
      ? SubjectOf<"project", ProjectId> | SubjectOf<"task", TaskId>
      : Type extends `approval.${string}`
        ? SubjectOf<"approval">
        : Type extends `knowledge.${string}`
          ? SubjectOf<"knowledge">
          : Type extends `project.${string}`
            ? SubjectOf<"project", ProjectId>
            : Type extends `artifact.${string}`
              ? SubjectOf<"artifact">
              : Type extends `measurement.${string}`
                ? SubjectOf<"measurement">
                : Type extends `pulse.${string}`
                  ? SubjectOf<"pulse">
                  : never;

type EventFields<Type extends EventType> = DeepReadonly<{
  type: Type;
  project: ProjectId;
  actor: Actor;
  subject: EventSubject<Type>;
  causedBy?: EventId;
  payload: EventPayload<Type>;
}>;

/** Internal admission input after authenticated identity and subject are known. */
export type EventInput<Type extends EventType = EventType> = Type extends EventType
  ? EventFields<Type>
  : never;

/** Validated event waiting for the store to allocate its per-project sequence. */
export type EventDraft<Type extends EventType = EventType> = Type extends EventType
  ? DeepReadonly<
      EventFields<Type> & {
        schemaVersion: typeof EVENT_SCHEMA_VERSION;
        id: EventId;
        seq: null;
        at: string;
      }
    >
  : never;

/** Immutable event acknowledged by the store after durable append. */
export type StoredEvent<Type extends EventType = EventType> = Type extends EventType
  ? DeepReadonly<
      EventFields<Type> & {
        schemaVersion: typeof EVENT_SCHEMA_VERSION;
        id: EventId;
        seq: Seq;
        at: string;
      }
    >
  : never;

export type EventOf<Type extends EventType> = StoredEvent<Type>;

const inputCommon = {
  project: projectIdSchema,
  actor: actorSchema,
  subject: subjectSchema,
  causedBy: eventIdSchema.optional(),
};

const persistedCommon = {
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  id: eventIdSchema,
  project: projectIdSchema,
  actor: actorSchema,
  subject: subjectSchema,
  at: rfc3339Schema,
  causedBy: eventIdSchema.optional(),
};

function inputOption<Type extends EventType>(type: Type) {
  return z.strictObject({
    ...inputCommon,
    type: z.literal(type),
    payload: eventPayloadSchemas[type],
  });
}

function draftOption<Type extends EventType>(type: Type) {
  return z.strictObject({
    ...persistedCommon,
    type: z.literal(type),
    seq: z.null(),
    payload: eventPayloadSchemas[type],
  });
}

function storedOption<Type extends EventType>(type: Type) {
  return z.strictObject({
    ...persistedCommon,
    type: z.literal(type),
    seq: positiveIntegerSchema,
    payload: eventPayloadSchemas[type],
  });
}

const [firstType, ...remainingTypes] = EVENT_TYPES;
const inputOptions = [inputOption(firstType), ...remainingTypes.map(inputOption)] as [
  ReturnType<typeof inputOption>,
  ...ReturnType<typeof inputOption>[],
];
const draftOptions = [draftOption(firstType), ...remainingTypes.map(draftOption)] as [
  ReturnType<typeof draftOption>,
  ...ReturnType<typeof draftOption>[],
];
const storedOptions = [storedOption(firstType), ...remainingTypes.map(storedOption)] as [
  ReturnType<typeof storedOption>,
  ...ReturnType<typeof storedOption>[],
];

const EVENT_SUBJECT_KINDS = {
  "agent.registered": ["agent"],
  "agent.status.changed": ["agent"],
  "agent.disconnected": ["agent"],
  "task.created": ["task"],
  "task.assigned": ["task"],
  "task.started": ["task"],
  "task.progress.updated": ["task"],
  "task.blocked": ["task"],
  "task.unblocked": ["task"],
  "task.review.requested": ["task"],
  "task.completed": ["task"],
  "task.failed": ["task"],
  "task.cancelled": ["task"],
  "message.sent": ["project", "task"],
  "approval.requested": ["approval"],
  "approval.granted": ["approval"],
  "approval.rejected": ["approval"],
  "approval.expired": ["approval"],
  "knowledge.created": ["knowledge"],
  "knowledge.linked": ["knowledge"],
  "knowledge.superseded": ["knowledge"],
  "project.created": ["project"],
  "project.human.participation.configured": ["project"],
  "project.state.changed": ["project"],
  "project.snapshot.captured": ["project"],
  "project.revived": ["project"],
  "project.environment.checked": ["project"],
  "artifact.produced": ["artifact"],
  "artifact.derived": ["artifact"],
  "measurement.recorded": ["measurement"],
  "pulse.story.generated": ["pulse"],
} as const satisfies Record<EventType, readonly SubjectKind[]>;

type CrossFieldEvent = {
  readonly type: EventType;
  readonly project: ProjectId;
  readonly actor: Actor;
  readonly subject: Subject;
  readonly payload: EventPayload;
  readonly causedBy?: EventId | undefined;
};

function validateSubject(event: CrossFieldEvent, context: z.RefinementCtx): void {
  if (Object.hasOwn(event, "causedBy") && event.causedBy === undefined) {
    context.addIssue({
      code: "custom",
      message: "causedBy must be omitted rather than set to undefined",
      path: ["causedBy"],
    });
  }

  const allowedKinds = EVENT_SUBJECT_KINDS[event.type] as readonly SubjectKind[];
  if (!allowedKinds.includes(event.subject.kind)) {
    context.addIssue({
      code: "custom",
      message: `${event.type} requires subject kind ${allowedKinds.join(" or ")}`,
      path: ["subject", "kind"],
    });
    return;
  }

  if (
    event.subject.kind === "task" &&
    !taskIdSchema.safeParse(event.subject.id).success
  ) {
    context.addIssue({
      code: "custom",
      message: "task subjects require a canonical TASK-nnn id",
      path: ["subject", "id"],
    });
  }

  if (
    event.type === "task.created" &&
    (event.payload as EventPayload<"task.created">).dependsOn.some(
      (task) => String(task) === String(event.subject.id),
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "a task cannot depend on itself",
      path: ["payload", "dependsOn"],
    });
  }

  if (event.type === "message.sent") {
    const payload = event.payload as EventPayload<"message.sent">;
    const expected = payload.task
      ? { kind: "task", id: String(payload.task) }
      : { kind: "project", id: String(event.project) };
    if (event.subject.kind !== expected.kind) {
      context.addIssue({
        code: "custom",
        message: `message subject kind must be ${expected.kind}`,
        path: ["subject", "kind"],
      });
    }
    if (String(event.subject.id) !== expected.id) {
      context.addIssue({
        code: "custom",
        message: "message subject id must match payload.task or envelope.project",
        path: ["subject", "id"],
      });
    }
  }

  if (
    event.type.startsWith("project.") &&
    String(event.subject.id) !== String(event.project)
  ) {
    context.addIssue({
      code: "custom",
      message: "project event subject id must match envelope.project",
      path: ["subject", "id"],
    });
  }

  if (
    event.type === "project.human.participation.configured" &&
    event.actor.kind !== "human"
  ) {
    context.addIssue({
      code: "custom",
      message: "human participation can only be configured by a human",
      path: ["actor", "kind"],
    });
  }

  if (
    (event.type === "agent.registered" || event.type === "agent.disconnected") &&
    String(
      (event.payload as EventPayload<"agent.registered" | "agent.disconnected">).id,
    ) !== String(event.subject.id)
  ) {
    context.addIssue({
      code: "custom",
      message: "agent event subject id must match payload.id",
      path: ["subject", "id"],
    });
  }
}

const RFC3339_INSTANT = /^(.*:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u;

function instantParts(value: string): {
  readonly whole: number;
  readonly fraction: string;
} {
  const match = RFC3339_INSTANT.exec(value);
  if (!match) throw new TypeError("Invalid validated RFC3339 instant");
  return {
    whole: Date.parse(`${match[1]}${match[3]}`),
    fraction: match[2] ?? "",
  };
}

/** Compare RFC3339 instants without truncating arbitrary fractional seconds. */
function compareRfc3339Instants(left: string, right: string): number {
  const leftInstant = instantParts(left);
  const rightInstant = instantParts(right);
  if (leftInstant.whole !== rightInstant.whole) {
    return leftInstant.whole < rightInstant.whole ? -1 : 1;
  }
  const width = Math.max(leftInstant.fraction.length, rightInstant.fraction.length);
  const leftFraction = leftInstant.fraction.padEnd(width, "0");
  const rightFraction = rightInstant.fraction.padEnd(width, "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
}

type PersistedCrossFieldEvent = CrossFieldEvent & {
  readonly id: EventId;
  readonly at: string;
  readonly causedBy?: EventId | undefined;
};

function validatePersistedEnvelope(
  event: PersistedCrossFieldEvent,
  context: z.RefinementCtx,
): void {
  validateSubject(event, context);

  if (event.causedBy === event.id) {
    context.addIssue({
      code: "custom",
      message: "an event cannot cause itself",
      path: ["causedBy"],
    });
  }

  if (
    event.type === "message.sent" &&
    (event.payload as EventPayload<"message.sent">).replyTo === event.id
  ) {
    context.addIssue({
      code: "custom",
      message: "a message cannot reply to itself",
      path: ["payload", "replyTo"],
    });
  }

  let observedAt: string | null = null;
  if (event.type === "approval.expired") {
    observedAt = (event.payload as EventPayload<"approval.expired">).after;
  } else if (event.type === "project.snapshot.captured") {
    observedAt = (event.payload as EventPayload<"project.snapshot.captured">).at;
  } else if (event.type === "measurement.recorded") {
    observedAt = (event.payload as EventPayload<"measurement.recorded">).at;
  }
  if (observedAt !== null && compareRfc3339Instants(observedAt, event.at) > 0) {
    context.addIssue({
      code: "custom",
      message: "payload time cannot be later than envelope.at",
      path: ["payload", event.type === "approval.expired" ? "after" : "at"],
    });
  }

  if (
    (event.type === "knowledge.created" || event.type === "pulse.story.generated") &&
    (
      event.payload as EventPayload<"knowledge.created" | "pulse.story.generated">
    ).sourceEvents.includes(event.id)
  ) {
    context.addIssue({
      code: "custom",
      message: "sourceEvents cannot contain the event being created",
      path: ["payload", "sourceEvents"],
    });
  }
}

const v1InputSchema = z
  .discriminatedUnion("type", inputOptions)
  .superRefine(validateSubject);
const v1DraftSchema = z
  .discriminatedUnion("type", draftOptions)
  .superRefine(validatePersistedEnvelope);
const v1StoredSchema = z
  .discriminatedUnion("type", storedOptions)
  .superRefine(validatePersistedEnvelope);

export const eventInputSchema = v1InputSchema.transform((event) =>
  deepFreeze(event),
) as unknown as z.ZodType<EventInput>;
export const eventDraftSchema = z
  .discriminatedUnion("schemaVersion", [v1DraftSchema])
  .transform((event) => deepFreeze(event)) as unknown as z.ZodType<EventDraft>;
export const storedEventSchema = z
  .discriminatedUnion("schemaVersion", [v1StoredSchema])
  .transform((event) => deepFreeze(event)) as unknown as z.ZodType<StoredEvent>;

export function parseEventInput(input: unknown): EventInput {
  return eventInputSchema.parse(input) as EventInput;
}

export function parseEventDraft(input: unknown): EventDraft {
  return eventDraftSchema.parse(input) as EventDraft;
}

export function parseStoredEvent(input: unknown): StoredEvent {
  return storedEventSchema.parse(input) as StoredEvent;
}

export type CreateEventDraftOptions = {
  readonly idFactory?: () => EventId;
  readonly now?: () => Date;
};

/** Add runtime-owned envelope fields, then validate the complete v1 draft. */
export function createEventDraft<Type extends EventType>(
  input: EventInput<Type>,
  options: CreateEventDraftOptions = {},
): EventDraft<Type> {
  const admitted = parseEventInput(input) as EventInput<Type>;
  const id = (options.idFactory ?? newEventId)();
  const at = (options.now ?? (() => new Date()))().toISOString();
  return parseEventDraft({
    schemaVersion: EVENT_SCHEMA_VERSION,
    id,
    seq: null,
    at,
    ...admitted,
  }) as EventDraft<Type>;
}
