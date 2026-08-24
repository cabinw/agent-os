import { eventIdSchema, parseStoredEvent } from "@agent-os/event-core";
import type { EventId, ProjectId, StoredEvent, TaskId } from "@agent-os/event-core";
import type { KnowledgeCandidate, KnowledgeTriggerKind } from "./triggers.js";
import { classifyKnowledgeEvent } from "./triggers.js";

export type KnowledgeWindow = Readonly<{
  project: ProjectId;
  anchor: EventId;
  trigger: KnowledgeTriggerKind;
  possibleTypes: KnowledgeCandidate["possibleTypes"];
  events: readonly StoredEvent[];
  sourceEvents: readonly EventId[];
  relatedTasks: readonly TaskId[];
}>;

export type KnowledgeWindowErrorCode =
  | "DUPLICATE_EVENT"
  | "INSUFFICIENT_CONTEXT"
  | "INVALID_ANCHOR"
  | "INVALID_HISTORY"
  | "INVALID_REFERENCE"
  | "MIXED_PROJECT"
  | "NOT_CANDIDATE"
  | "SEQUENCE_GAP";

export class KnowledgeWindowError extends Error {
  readonly code: KnowledgeWindowErrorCode;
  readonly eventId: string | undefined;

  constructor(
    code: KnowledgeWindowErrorCode,
    message: string,
    eventId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KnowledgeWindowError";
    this.code = code;
    this.eventId = eventId;
  }
}

function parseHistory(value: unknown): readonly StoredEvent[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new KnowledgeWindowError(
      "INVALID_HISTORY",
      "knowledge history must be a non-empty array",
    );
  }
  const events: StoredEvent[] = [];
  const ids = new Set<EventId>();
  let project: ProjectId | undefined;
  for (const [index, raw] of value.entries()) {
    let event: StoredEvent;
    try {
      event = parseStoredEvent(raw);
    } catch (cause) {
      throw new KnowledgeWindowError(
        "INVALID_HISTORY",
        `knowledge history event ${index} is invalid`,
        undefined,
        { cause },
      );
    }
    if (project === undefined) project = event.project;
    if (event.project !== project) {
      throw new KnowledgeWindowError(
        "MIXED_PROJECT",
        `knowledge history event ${event.id} belongs to another project`,
        event.id,
      );
    }
    const expected = index + 1;
    if (event.seq !== expected) {
      throw new KnowledgeWindowError(
        "SEQUENCE_GAP",
        `knowledge history expected seq ${expected}, received ${event.seq}`,
        event.id,
      );
    }
    if (ids.has(event.id)) {
      throw new KnowledgeWindowError(
        "DUPLICATE_EVENT",
        `knowledge history repeats event ${event.id}`,
        event.id,
      );
    }
    ids.add(event.id);
    events.push(event);
  }
  return Object.freeze(events);
}

function messageThread(event: StoredEvent<"message.sent">): string {
  return event.payload.task ?? event.project;
}

function directTaskIds(event: StoredEvent): readonly TaskId[] {
  if (event.type.startsWith("task.")) return [event.subject.id as TaskId];
  if (event.type === "message.sent") {
    return event.payload.task === undefined ? [] : [event.payload.task];
  }
  if (event.type === "approval.requested") {
    return event.payload.task === undefined ? [] : [event.payload.task];
  }
  if (event.type === "artifact.produced") return [event.payload.task];
  if (event.type === "knowledge.created") return event.payload.relatedTasks ?? [];
  return [];
}

function isApprovalDecision(event: StoredEvent): boolean {
  return (
    event.type === "approval.granted" ||
    event.type === "approval.rejected" ||
    event.type === "approval.expired"
  );
}

/** Build the exact replay-stable evidence set for one candidate anchor. */
export function buildKnowledgeWindow(
  historyValue: unknown,
  anchorValue: unknown,
): KnowledgeWindow {
  const history = parseHistory(historyValue);
  const parsedAnchor = eventIdSchema.safeParse(anchorValue);
  if (!parsedAnchor.success) {
    throw new KnowledgeWindowError("INVALID_ANCHOR", "anchor is not an event id");
  }
  const anchorIndex = history.findIndex((event) => event.id === parsedAnchor.data);
  if (anchorIndex < 0) {
    throw new KnowledgeWindowError(
      "INVALID_ANCHOR",
      `anchor ${parsedAnchor.data} is absent from history`,
      parsedAnchor.data,
    );
  }
  const anchor = history[anchorIndex] as StoredEvent;
  const classified = classifyKnowledgeEvent(anchor);
  if (classified.kind !== "candidate") {
    throw new KnowledgeWindowError(
      "NOT_CANDIDATE",
      `event ${anchor.id} is ${classified.reason}, not a knowledge candidate`,
      anchor.id,
    );
  }

  const throughAnchor = history.slice(0, anchorIndex + 1);
  const indices = new Map<EventId, number>();
  for (const [index, event] of throughAnchor.entries()) indices.set(event.id, index);

  for (const [index, event] of throughAnchor.entries()) {
    if (event.causedBy !== undefined) {
      const causeIndex = indices.get(event.causedBy);
      if (causeIndex === undefined || causeIndex >= index) {
        throw new KnowledgeWindowError(
          "INVALID_REFERENCE",
          `event ${event.id} has a missing or non-prior cause ${event.causedBy}`,
          event.id,
        );
      }
    }
    if (event.type === "message.sent" && event.payload.replyTo !== undefined) {
      const replyIndex = indices.get(event.payload.replyTo);
      const reply = replyIndex === undefined ? undefined : throughAnchor[replyIndex];
      if (
        replyIndex === undefined ||
        replyIndex >= index ||
        reply?.type !== "message.sent" ||
        messageThread(reply) !== messageThread(event)
      ) {
        throw new KnowledgeWindowError(
          "INVALID_REFERENCE",
          `message ${event.id} has an invalid reply ${event.payload.replyTo}`,
          event.id,
        );
      }
    }
  }

  const included = new Set<number>();
  const addReferenceClosure = (index: number): void => {
    if (included.has(index)) return;
    included.add(index);
    const event = throughAnchor[index] as StoredEvent;
    if (event.causedBy !== undefined) {
      addReferenceClosure(indices.get(event.causedBy) as number);
    }
    if (event.type === "message.sent" && event.payload.replyTo !== undefined) {
      addReferenceClosure(indices.get(event.payload.replyTo) as number);
    }
  };
  addReferenceClosure(anchorIndex);

  const addApprovalRequests = (): boolean => {
    let changed = false;
    for (const index of [...included]) {
      const event = throughAnchor[index] as StoredEvent;
      if (!isApprovalDecision(event)) continue;
      const requests = throughAnchor
        .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
        .filter(
          ({ candidate, candidateIndex }) =>
            candidateIndex < index &&
            candidate.type === "approval.requested" &&
            candidate.subject.id === event.subject.id,
        );
      if (requests.length !== 1) {
        throw new KnowledgeWindowError(
          "INVALID_REFERENCE",
          `approval decision ${event.id} requires exactly one prior request`,
          event.id,
        );
      }
      const requestIndex = requests[0]?.candidateIndex as number;
      if (!included.has(requestIndex)) {
        addReferenceClosure(requestIndex);
        changed = true;
      }
    }
    return changed;
  };

  const artifactByPath = new Map<string, number[]>();
  for (const [index, event] of throughAnchor.entries()) {
    if (event.type !== "artifact.produced" && event.type !== "artifact.derived") {
      continue;
    }
    const paths = artifactByPath.get(event.payload.path) ?? [];
    paths.push(index);
    artifactByPath.set(event.payload.path, paths);
  }
  const addArtifactLineage = (): boolean => {
    let changed = false;
    for (const index of [...included]) {
      const event = throughAnchor[index] as StoredEvent;
      if (event.type !== "artifact.derived") continue;
      for (const source of event.payload.from) {
        for (const sourceIndex of artifactByPath.get(source) ?? []) {
          if (sourceIndex >= index || included.has(sourceIndex)) continue;
          addReferenceClosure(sourceIndex);
          changed = true;
        }
      }
    }
    return changed;
  };

  while (addApprovalRequests() || addArtifactLineage()) {
    // New closure members can reveal another approval request or artifact source.
  }

  const scopeTasks = new Set<TaskId>();
  for (const index of included) {
    const event = throughAnchor[index] as StoredEvent;
    if (event.type === "knowledge.created") continue;
    for (const task of directTaskIds(event)) scopeTasks.add(task);
  }
  for (const [index, event] of throughAnchor.entries()) {
    const eventTasks = new Set(directTaskIds(event));
    if (isApprovalDecision(event)) {
      const request = throughAnchor.find(
        (candidate, candidateIndex) =>
          candidateIndex < index &&
          candidate.type === "approval.requested" &&
          candidate.subject.id === event.subject.id,
      );
      if (request?.type === "approval.requested" && request.payload.task !== undefined) {
        eventTasks.add(request.payload.task);
      }
    }
    if ([...eventTasks].some((task) => scopeTasks.has(task))) included.add(index);
  }

  const selected = [...included]
    .sort((left, right) => left - right)
    .map((index) => throughAnchor[index] as StoredEvent);
  if (selected.length < 2) {
    throw new KnowledgeWindowError(
      "INSUFFICIENT_CONTEXT",
      `candidate ${anchor.id} has no supporting event`,
      anchor.id,
    );
  }
  const events = Object.freeze(selected);
  const sourceEvents = Object.freeze(events.map((event) => event.id));
  const relatedTasks = Object.freeze([...scopeTasks].sort());
  return Object.freeze({
    project: anchor.project,
    anchor: anchor.id,
    trigger: classified.trigger,
    possibleTypes: classified.possibleTypes,
    events,
    sourceEvents,
    relatedTasks,
  });
}
