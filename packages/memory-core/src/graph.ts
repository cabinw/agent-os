import { parseStoredEvent, projectIdSchema } from "@agent-os/event-core";
import type { DeepReadonly, EventId, ProjectId, StoredEvent } from "@agent-os/event-core";
import {
  type KnowledgeRelation,
  emptyKnowledgeProjectState,
  reduceKnowledgeProject,
} from "./projection.js";

export type MemoryGraphEdge = DeepReadonly<{
  from: EventId;
  to: EventId;
  relation: "causedBy";
}>;

export type MemoryGraph = DeepReadonly<{
  project: ProjectId;
  nodes: readonly StoredEvent[];
  edges: readonly MemoryGraphEdge[];
  semanticRelations: readonly KnowledgeRelation[];
}>;

export type MemoryGraphSource = Readonly<{
  project: ProjectId;
  history: readonly unknown[];
}>;

export type MemoryGraphErrorCode =
  | "DUPLICATE_EVENT"
  | "INVALID_CAUSE"
  | "INVALID_HISTORY"
  | "INVALID_MEMORY_EVENT"
  | "INVALID_SEQUENCE";

export class MemoryGraphError extends Error {
  readonly code: MemoryGraphErrorCode;
  readonly eventId: string | undefined;

  constructor(
    code: MemoryGraphErrorCode,
    message: string,
    eventId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MemoryGraphError";
    this.code = code;
    this.eventId = eventId;
  }
}

function freeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
}

function parseSource(value: MemoryGraphSource): Readonly<{
  project: ProjectId;
  history: readonly unknown[];
}> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new MemoryGraphError("INVALID_HISTORY", "memory graph source is required");
  }
  for (const key of Object.keys(value)) {
    if (key !== "project" && key !== "history") {
      throw new MemoryGraphError(
        "INVALID_HISTORY",
        `memory graph source has unknown field ${key}`,
      );
    }
  }
  const project = projectIdSchema.safeParse(value.project);
  if (!project.success || !Array.isArray(value.history)) {
    throw new MemoryGraphError(
      "INVALID_HISTORY",
      "memory graph source is invalid",
      undefined,
      {
        cause: project.success ? undefined : project.error,
      },
    );
  }
  return Object.freeze({ project: project.data, history: value.history });
}

export function buildMemoryGraph(sourceValue: MemoryGraphSource): MemoryGraph {
  const { project, history } = parseSource(sourceValue);
  const nodes: StoredEvent[] = [];
  const edges: MemoryGraphEdge[] = [];
  const indices = new Map<EventId, number>();
  let memory = emptyKnowledgeProjectState();

  for (const [index, raw] of history.entries()) {
    let event: StoredEvent;
    try {
      event = parseStoredEvent(raw);
    } catch (cause) {
      throw new MemoryGraphError(
        "INVALID_HISTORY",
        `memory graph history item ${index} is invalid`,
        undefined,
        { cause },
      );
    }
    if (event.project !== project) {
      throw new MemoryGraphError(
        "INVALID_HISTORY",
        `event ${event.id} belongs to another project`,
        event.id,
      );
    }
    if (event.seq !== index + 1) {
      throw new MemoryGraphError(
        "INVALID_SEQUENCE",
        `event ${event.id} has sequence ${event.seq}; expected ${index + 1}`,
        event.id,
      );
    }
    if (indices.has(event.id)) {
      throw new MemoryGraphError(
        "DUPLICATE_EVENT",
        `event ${event.id} is duplicated`,
        event.id,
      );
    }
    if (event.causedBy !== undefined) {
      if (!indices.has(event.causedBy)) {
        throw new MemoryGraphError(
          "INVALID_CAUSE",
          `event ${event.id} has a missing or non-prior cause ${event.causedBy}`,
          event.id,
        );
      }
      edges.push(freeze({ from: event.id, to: event.causedBy, relation: "causedBy" }));
    }
    indices.set(event.id, index);
    nodes.push(event);
    try {
      memory = reduceKnowledgeProject(memory, event);
    } catch (cause) {
      throw new MemoryGraphError(
        "INVALID_MEMORY_EVENT",
        `event ${event.id} violates Memory projection semantics`,
        event.id,
        { cause },
      );
    }
  }

  return freeze({
    project,
    nodes,
    edges,
    semanticRelations: Object.values(memory.relations).sort(
      (left, right) => left.eventSeq - right.eventSeq,
    ),
  });
}
