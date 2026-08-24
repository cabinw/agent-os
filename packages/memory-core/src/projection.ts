import {
  actorSchema,
  eventIdSchema,
  knowledgeIdSchema,
  knowledgeTypeSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
  projectIdSchema,
  rfc3339Schema,
  taskIdSchema,
} from "@agent-os/event-core";
import type {
  Actor,
  DeepReadonly,
  EventBus,
  EventId,
  KnowledgeId,
  ProjectId,
  ReducerHandle,
  StoredEvent,
  TaskId,
} from "@agent-os/event-core";
import { z } from "zod";
import type { KnowledgeType } from "./schemas.js";

const uniqueNonEmptyStrings = z
  .array(nonEmptyStringSchema)
  .min(1)
  .refine((items) => new Set(items).size === items.length, {
    error: "must not contain duplicates",
  });
const uniqueEvents = z
  .array(eventIdSchema)
  .min(1)
  .refine((items) => new Set(items).size === items.length, {
    error: "must not contain duplicates",
  });
const uniqueTasks = z
  .array(taskIdSchema)
  .min(1)
  .refine((items) => new Set(items).size === items.length, {
    error: "must not contain duplicates",
  });

const knowledgeItemSchema = z
  .strictObject({
    id: knowledgeIdSchema,
    project: projectIdSchema,
    type: knowledgeTypeSchema,
    title: nonEmptyStringSchema,
    summary: nonEmptyStringSchema,
    rationale: nonEmptyStringSchema.optional(),
    alternatives: uniqueNonEmptyStrings.optional(),
    sourceEvents: uniqueEvents,
    relatedTasks: uniqueTasks.optional(),
    author: actorSchema,
    at: rfc3339Schema,
    createdEvent: eventIdSchema,
    createdSeq: positiveIntegerSchema,
    supersedes: knowledgeIdSchema.optional(),
    supersededBy: knowledgeIdSchema.optional(),
  })
  .superRefine((item, context) => {
    if (item.type === "decision" && item.rationale === undefined) {
      context.addIssue({
        code: "custom",
        message: "decision knowledge requires rationale",
        path: ["rationale"],
      });
    }
    for (const field of [
      "rationale",
      "alternatives",
      "relatedTasks",
      "supersedes",
      "supersededBy",
    ] as const) {
      if (Object.hasOwn(item, field) && item[field] === undefined) {
        context.addIssue({
          code: "custom",
          message: "optional fields must be omitted",
          path: [field],
        });
      }
    }
  });

const knowledgeProjectStateSchema = z.strictObject({
  items: z.record(knowledgeIdSchema, knowledgeItemSchema),
});

type MutableKnowledgeItem = z.output<typeof knowledgeItemSchema>;

export type KnowledgeItem = DeepReadonly<
  Omit<MutableKnowledgeItem, "author" | "type"> & {
    author: Actor;
    type: KnowledgeType;
  }
>;

export type KnowledgeProjectState = DeepReadonly<{
  items: Readonly<Record<string, KnowledgeItem>>;
}>;

export type KnowledgeProjectionErrorCode =
  | "BRANCH"
  | "DUPLICATE_KNOWLEDGE"
  | "INVALID_IDENTITY"
  | "INVALID_ORDER"
  | "INVALID_STATE"
  | "INVALID_TYPE"
  | "MISSING_KNOWLEDGE";

export class KnowledgeProjectionError extends Error {
  readonly code: KnowledgeProjectionErrorCode;
  readonly knowledgeId: string | undefined;

  constructor(
    code: KnowledgeProjectionErrorCode,
    message: string,
    knowledgeId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KnowledgeProjectionError";
    this.code = code;
    this.knowledgeId = knowledgeId;
  }
}

function freeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
}

export function emptyKnowledgeProjectState(): KnowledgeProjectState {
  return freeze({ items: {} });
}

function createdItem(event: StoredEvent<"knowledge.created">): KnowledgeItem {
  const id = knowledgeIdSchema.safeParse(event.subject.id);
  if (!id.success) {
    throw new KnowledgeProjectionError(
      "INVALID_IDENTITY",
      `knowledge subject ${event.subject.id} is not canonical`,
      event.subject.id,
      { cause: id.error },
    );
  }
  return freeze({
    id: id.data,
    project: event.project,
    type: event.payload.type,
    title: event.payload.title,
    summary: event.payload.summary,
    ...(event.payload.rationale === undefined
      ? {}
      : { rationale: event.payload.rationale }),
    ...(event.payload.alternatives === undefined
      ? {}
      : { alternatives: event.payload.alternatives }),
    sourceEvents: event.payload.sourceEvents,
    ...(event.payload.relatedTasks === undefined
      ? {}
      : { relatedTasks: event.payload.relatedTasks }),
    author: event.actor,
    at: event.at,
    createdEvent: event.id,
    createdSeq: event.seq,
  });
}

function requireItem(state: KnowledgeProjectState, id: KnowledgeId): KnowledgeItem {
  const item = state.items[id];
  if (item === undefined) {
    throw new KnowledgeProjectionError(
      "MISSING_KNOWLEDGE",
      `knowledge ${id} does not exist`,
      id,
    );
  }
  return item;
}

export function assertKnowledgeSupersession(
  state: KnowledgeProjectState,
  oldId: KnowledgeId,
  newId: KnowledgeId,
  supersessionSeq?: number,
): Readonly<{ old: KnowledgeItem; next: KnowledgeItem }> {
  const old = requireItem(state, oldId);
  const next = requireItem(state, newId);
  if (old.type !== "decision" || next.type !== "decision") {
    throw new KnowledgeProjectionError(
      "INVALID_TYPE",
      "only decisions can form a supersession chain",
      old.type !== "decision" ? old.id : next.id,
    );
  }
  if (
    old.createdSeq >= next.createdSeq ||
    (supersessionSeq !== undefined && next.createdSeq >= supersessionSeq)
  ) {
    throw new KnowledgeProjectionError(
      "INVALID_ORDER",
      `replacement ${next.id} must be created after ${old.id} and before supersession`,
      next.id,
    );
  }
  if (old.supersededBy !== undefined) {
    throw new KnowledgeProjectionError(
      "BRANCH",
      `knowledge ${old.id} is already superseded by ${old.supersededBy}`,
      old.id,
    );
  }
  if (next.supersedes !== undefined || next.supersededBy !== undefined) {
    throw new KnowledgeProjectionError(
      "BRANCH",
      `replacement ${next.id} is already attached to a chain`,
      next.id,
    );
  }
  return Object.freeze({ old, next });
}

export function reduceKnowledgeProject(
  state: KnowledgeProjectState,
  event: StoredEvent,
): KnowledgeProjectState {
  if (event.type === "knowledge.created") {
    const item = createdItem(event);
    if (state.items[item.id] !== undefined) {
      throw new KnowledgeProjectionError(
        "DUPLICATE_KNOWLEDGE",
        `knowledge ${item.id} already exists`,
        item.id,
      );
    }
    return { items: { ...state.items, [item.id]: item } };
  }
  if (event.type !== "knowledge.superseded") return state;
  const subject = knowledgeIdSchema.safeParse(event.subject.id);
  if (!subject.success || subject.data !== event.payload.old) {
    throw new KnowledgeProjectionError(
      "INVALID_IDENTITY",
      "knowledge.superseded subject must equal old",
      event.payload.old,
    );
  }
  const { old, next } = assertKnowledgeSupersession(
    state,
    event.payload.old,
    event.payload.new,
    event.seq,
  );
  return {
    items: {
      ...state.items,
      [old.id]: { ...old, supersededBy: next.id },
      [next.id]: { ...next, supersedes: old.id },
    },
  };
}

function assertSnapshotLinks(state: KnowledgeProjectState): void {
  const creationEvents = new Set<EventId>();
  const creationSeqs = new Set<number>();
  for (const [key, item] of Object.entries(state.items)) {
    if (item.id !== key) {
      throw new KnowledgeProjectionError(
        "INVALID_STATE",
        `knowledge map key ${key} mismatches ${item.id}`,
        key,
      );
    }
    if (creationEvents.has(item.createdEvent) || creationSeqs.has(item.createdSeq)) {
      throw new KnowledgeProjectionError(
        "INVALID_STATE",
        `knowledge ${item.id} repeats creation identity`,
        item.id,
      );
    }
    creationEvents.add(item.createdEvent);
    creationSeqs.add(item.createdSeq);
    if (item.supersedes !== undefined) {
      const previous = state.items[item.supersedes];
      if (
        previous === undefined ||
        previous.supersededBy !== item.id ||
        previous.type !== "decision" ||
        item.type !== "decision" ||
        previous.createdSeq >= item.createdSeq
      ) {
        throw new KnowledgeProjectionError(
          "INVALID_STATE",
          `knowledge ${item.id} has invalid predecessor`,
          item.id,
        );
      }
    }
    if (item.supersededBy !== undefined) {
      const successor = state.items[item.supersededBy];
      if (
        successor === undefined ||
        successor.supersedes !== item.id ||
        successor.type !== "decision" ||
        item.type !== "decision" ||
        successor.createdSeq <= item.createdSeq
      ) {
        throw new KnowledgeProjectionError(
          "INVALID_STATE",
          `knowledge ${item.id} has invalid successor`,
          item.id,
        );
      }
    }
  }
}

export function parseKnowledgeProjectState(
  value: unknown,
  project: ProjectId,
): KnowledgeProjectState {
  let parsed: z.output<typeof knowledgeProjectStateSchema>;
  try {
    parsed = knowledgeProjectStateSchema.parse(value);
  } catch (cause) {
    throw new KnowledgeProjectionError(
      "INVALID_STATE",
      "knowledge projection snapshot is invalid",
      undefined,
      { cause },
    );
  }
  for (const item of Object.values(parsed.items)) {
    if (item.project !== project) {
      throw new KnowledgeProjectionError(
        "INVALID_STATE",
        `knowledge ${item.id} belongs to another project`,
        item.id,
      );
    }
  }
  const state = freeze(parsed) as KnowledgeProjectState;
  assertSnapshotLinks(state);
  return state;
}

export function registerKnowledgeReducer(
  bus: EventBus,
): ReducerHandle<KnowledgeProjectState> {
  return bus.registerReducer(
    "memory",
    emptyKnowledgeProjectState,
    reduceKnowledgeProject,
    { version: "1", parseState: parseKnowledgeProjectState },
  );
}
