import {
  entityIdSchema,
  knowledgeTypeSchema,
  nonEmptyStringSchema,
  projectIdSchema,
  rfc3339Schema,
} from "@agent-os/event-core";
import type { DeepReadonly, EntityId, EventId, ProjectId } from "@agent-os/event-core";
import { z } from "zod";
import {
  type KnowledgeItem,
  type KnowledgeProjectState,
  parseKnowledgeProjectState,
} from "./projection.js";
import type { KnowledgeType } from "./schemas.js";

export const MEMORY_QUERY_STATUSES = Object.freeze([
  "active",
  "superseded",
  "all",
] as const);
export type MemoryQueryStatus = (typeof MEMORY_QUERY_STATUSES)[number];

const memoryQuerySchema = z
  .strictObject({
    q: nonEmptyStringSchema.optional(),
    type: knowledgeTypeSchema.optional(),
    after: rfc3339Schema.optional(),
    before: rfc3339Schema.optional(),
    relatedTo: entityIdSchema.optional(),
    relation: nonEmptyStringSchema.optional(),
    status: z.enum(MEMORY_QUERY_STATUSES).optional(),
  })
  .superRefine((query, context) => {
    if (
      query.after !== undefined &&
      query.before !== undefined &&
      Date.parse(query.after) > Date.parse(query.before)
    ) {
      context.addIssue({
        code: "custom",
        message: "after must not be later than before",
        path: ["after"],
      });
    }
    for (const field of [
      "q",
      "type",
      "after",
      "before",
      "relatedTo",
      "relation",
      "status",
    ] as const) {
      if (Object.hasOwn(query, field) && query[field] === undefined) {
        context.addIssue({
          code: "custom",
          message: "optional fields must be omitted",
          path: [field],
        });
      }
    }
  });

export type MemoryQuery = DeepReadonly<{
  q?: string | undefined;
  type?: KnowledgeType | undefined;
  after?: string | undefined;
  before?: string | undefined;
  relatedTo?: EntityId | undefined;
  relation?: string | undefined;
  status?: MemoryQueryStatus | undefined;
}>;

export type MemoryRelationDescriptor = DeepReadonly<{
  kind: "linked" | "related-task" | "superseded-by" | "supersedes";
  from: EntityId;
  to: EntityId;
  relation: string;
  event?: EventId;
}>;

export type MemoryQueryResult = DeepReadonly<{
  item: KnowledgeItem;
  relations: readonly MemoryRelationDescriptor[];
}>;

export type QueryMemorySource = Readonly<{
  project: ProjectId;
  state: KnowledgeProjectState;
  query: MemoryQuery;
}>;

export type MemoryQueryErrorCode = "INVALID_QUERY" | "INVALID_STATE";

export class MemoryQueryError extends Error {
  readonly code: MemoryQueryErrorCode;

  constructor(code: MemoryQueryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryQueryError";
    this.code = code;
  }
}

function freeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
}

function parseSource(source: QueryMemorySource): Readonly<{
  project: ProjectId;
  state: KnowledgeProjectState;
  query: MemoryQuery;
}> {
  if (
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    (Object.getPrototypeOf(source) !== Object.prototype &&
      Object.getPrototypeOf(source) !== null)
  ) {
    throw new MemoryQueryError("INVALID_QUERY", "memory query source is required");
  }
  for (const key of Object.keys(source)) {
    if (!new Set(["project", "state", "query"]).has(key)) {
      throw new MemoryQueryError(
        "INVALID_QUERY",
        `memory query source has unknown field ${key}`,
      );
    }
  }
  const project = projectIdSchema.safeParse(source.project);
  const query = memoryQuerySchema.safeParse(source.query);
  if (!project.success || !query.success) {
    throw new MemoryQueryError("INVALID_QUERY", "memory query is invalid", {
      cause: project.success ? query.error : project.error,
    });
  }
  let state: KnowledgeProjectState;
  try {
    state = parseKnowledgeProjectState(source.state, project.data);
  } catch (cause) {
    throw new MemoryQueryError("INVALID_STATE", "memory query state is invalid", {
      cause,
    });
  }
  return Object.freeze({
    project: project.data,
    state,
    query: query.data as unknown as MemoryQuery,
  });
}

function relationDescriptors(
  state: KnowledgeProjectState,
  item: KnowledgeItem,
): readonly MemoryRelationDescriptor[] {
  const relations: MemoryRelationDescriptor[] = [];
  for (const task of item.relatedTasks ?? []) {
    relations.push({
      kind: "related-task",
      from: item.id as unknown as EntityId,
      to: task as unknown as EntityId,
      relation: "related-task",
    });
  }
  if (item.supersedes !== undefined) {
    relations.push({
      kind: "supersedes",
      from: item.id as unknown as EntityId,
      to: item.supersedes as unknown as EntityId,
      relation: "supersedes",
    });
  }
  if (item.supersededBy !== undefined) {
    relations.push({
      kind: "superseded-by",
      from: item.id as unknown as EntityId,
      to: item.supersededBy as unknown as EntityId,
      relation: "superseded-by",
    });
  }
  for (const relation of Object.values(state.relations)) {
    const endpoint = item.id as unknown as EntityId;
    if (relation.from !== endpoint && relation.to !== endpoint) continue;
    relations.push({
      kind: "linked",
      from: relation.from,
      to: relation.to,
      relation: relation.relation,
      event: relation.event,
    });
  }
  return Object.freeze(
    relations
      .sort(
        (left, right) =>
          left.kind.localeCompare(right.kind) ||
          left.relation.localeCompare(right.relation) ||
          left.from.localeCompare(right.from) ||
          left.to.localeCompare(right.to) ||
          (left.event ?? "").localeCompare(right.event ?? ""),
      )
      .map((relation) => freeze({ ...relation })),
  );
}

function textMatches(item: KnowledgeItem, q: string | undefined): boolean {
  if (q === undefined) return true;
  const needle = q.toLowerCase();
  return [
    item.title,
    item.summary,
    item.rationale ?? "",
    ...(item.alternatives ?? []),
  ].some((value) => value.toLowerCase().includes(needle));
}

function relationMatches(
  descriptor: MemoryRelationDescriptor,
  query: MemoryQuery,
): boolean {
  const entityMatches =
    query.relatedTo === undefined ||
    descriptor.from === query.relatedTo ||
    descriptor.to === query.relatedTo;
  const labelMatches =
    query.relation === undefined || descriptor.relation === query.relation;
  return entityMatches && labelMatches;
}

export function queryMemory(
  sourceValue: QueryMemorySource,
): readonly MemoryQueryResult[] {
  const { state, query } = parseSource(sourceValue);
  const after = query.after === undefined ? undefined : Date.parse(query.after);
  const before = query.before === undefined ? undefined : Date.parse(query.before);
  const status = query.status ?? "all";
  const usesRelation = query.relatedTo !== undefined || query.relation !== undefined;
  const results: MemoryQueryResult[] = [];

  for (const item of Object.values(state.items).sort(
    (left, right) =>
      left.createdSeq - right.createdSeq || left.id.localeCompare(right.id),
  )) {
    if (
      !textMatches(item, query.q) ||
      (query.type !== undefined && item.type !== query.type)
    ) {
      continue;
    }
    const instant = Date.parse(item.at);
    if (
      (after !== undefined && instant < after) ||
      (before !== undefined && instant > before)
    ) {
      continue;
    }
    const active = item.supersededBy === undefined;
    if ((status === "active" && !active) || (status === "superseded" && active)) {
      continue;
    }
    const descriptors = relationDescriptors(state, item);
    const matched = usesRelation
      ? descriptors.filter((descriptor) => relationMatches(descriptor, query))
      : descriptors;
    if (usesRelation && matched.length === 0) continue;
    results.push(freeze({ item, relations: matched }));
  }
  return Object.freeze(results);
}
