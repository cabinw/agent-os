import {
  entityIdSchema,
  eventIdSchema,
  parseStoredEvent,
  projectIdSchema,
  taskIdSchema,
} from "@agent-os/event-core";
import type {
  EntityId,
  EventBus,
  EventType,
  ProjectId,
  ReducerHandle,
  StoredEvent,
  TaskId,
} from "@agent-os/event-core";
import { TASK_STATUSES, isTaskEventType, transitionTaskStatus } from "./lifecycle.js";
import type { TaskStatus } from "./lifecycle.js";

export const PROJECT_THREAD_KEY = "$project" as const;

const DIVIDER_EVENT_TYPES = [
  "task.started",
  "task.blocked",
  "task.unblocked",
  "task.review.requested",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "approval.requested",
  "approval.granted",
  "approval.rejected",
  "approval.expired",
  "knowledge.created",
] as const satisfies readonly EventType[];

type DividerEventType = (typeof DIVIDER_EVENT_TYPES)[number];
type ApprovalEventType =
  | "approval.requested"
  | "approval.granted"
  | "approval.rejected"
  | "approval.expired";
type ConversationThreadKey = typeof PROJECT_THREAD_KEY | TaskId;

export type ConversationMessage = Readonly<{
  kind: "message";
  event: StoredEvent<"message.sent">;
}>;

export type ConversationProgressRun = Readonly<{
  kind: "progress-run";
  events: readonly StoredEvent<"message.sent">[];
}>;

export type ConversationDivider = Readonly<{
  kind: "divider";
  event: StoredEvent<DividerEventType>;
}>;

export type ConversationItem =
  | ConversationMessage
  | ConversationProgressRun
  | ConversationDivider;

export type ConversationThread = Readonly<{
  task?: TaskId;
  title?: string;
  status?: TaskStatus;
  progress?: number;
  executor?: EntityId;
  items: readonly ConversationItem[];
}>;

export type ConversationApprovalIndex = Readonly<{
  thread: ConversationThreadKey;
  status: "pending" | "granted" | "rejected" | "expired";
}>;

export type ConversationProjectState = Readonly<{
  threads: Readonly<Record<string, ConversationThread>>;
  approvals: Readonly<Record<string, ConversationApprovalIndex>>;
  messageThreads: Readonly<Record<string, ConversationThreadKey>>;
}>;

export class ConversationProjectionError extends Error {
  readonly code:
    | "DUPLICATE_APPROVAL"
    | "DUPLICATE_TASK"
    | "INVALID_ACTOR"
    | "INVALID_REPLY"
    | "INVALID_STATE"
    | "MISSING_APPROVAL"
    | "MISSING_THREAD"
    | "TERMINAL_APPROVAL";
  readonly subject: string | undefined;

  constructor(
    code: ConversationProjectionError["code"],
    message: string,
    subject?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConversationProjectionError";
    this.code = code;
    this.subject = subject;
  }
}

export function emptyConversationProjectState(): ConversationProjectState {
  return {
    threads: { [PROJECT_THREAD_KEY]: { items: [] } },
    approvals: {},
    messageThreads: {},
  };
}

function hasDividerType(type: EventType): type is DividerEventType {
  return (DIVIDER_EVENT_TYPES as readonly string[]).includes(type);
}

function requireThread(
  state: ConversationProjectState,
  key: ConversationThreadKey,
): ConversationThread {
  const thread = state.threads[key];
  if (thread === undefined) {
    throw new ConversationProjectionError(
      "MISSING_THREAD",
      `conversation thread ${key} does not exist`,
      key,
    );
  }
  return thread;
}

function replaceThread(
  state: ConversationProjectState,
  key: ConversationThreadKey,
  thread: ConversationThread,
): ConversationProjectState {
  return { ...state, threads: { ...state.threads, [key]: thread } };
}

function appendItem(
  state: ConversationProjectState,
  key: ConversationThreadKey,
  item: ConversationItem,
): ConversationProjectState {
  const thread = requireThread(state, key);
  return replaceThread(state, key, { ...thread, items: [...thread.items, item] });
}

function sameProgressParticipants(
  left: StoredEvent<"message.sent">,
  right: StoredEvent<"message.sent">,
): boolean {
  return left.payload.from === right.payload.from && left.payload.to === right.payload.to;
}

function appendMessage(
  state: ConversationProjectState,
  key: ConversationThreadKey,
  event: StoredEvent<"message.sent">,
): ConversationProjectState {
  const thread = requireThread(state, key);
  const items = [...thread.items];
  const last = items.at(-1);
  if (event.payload.type === "progress" && last?.kind === "message") {
    if (
      last.event.payload.type === "progress" &&
      sameProgressParticipants(last.event, event)
    ) {
      items[items.length - 1] = { kind: "progress-run", events: [last.event, event] };
    } else {
      items.push({ kind: "message", event });
    }
  } else if (event.payload.type === "progress" && last?.kind === "progress-run") {
    const prior = last.events.at(-1);
    if (prior !== undefined && sameProgressParticipants(prior, event)) {
      items[items.length - 1] = {
        kind: "progress-run",
        events: [...last.events, event],
      };
    } else {
      items.push({ kind: "message", event });
    }
  } else {
    items.push({ kind: "message", event });
  }
  return {
    ...state,
    threads: { ...state.threads, [key]: { ...thread, items } },
    messageThreads: { ...state.messageThreads, [event.id]: key },
  };
}

function reduceTaskEvent(
  state: ConversationProjectState,
  event: StoredEvent,
): ConversationProjectState {
  if (!isTaskEventType(event.type)) return state;
  const key = event.subject.id as TaskId;
  if (event.type === "task.created") {
    if (state.threads[key] !== undefined) {
      throw new ConversationProjectionError(
        "DUPLICATE_TASK",
        `conversation thread ${key} already exists`,
        key,
      );
    }
    return {
      ...state,
      threads: {
        ...state.threads,
        [key]: {
          task: key,
          title: event.payload.title,
          status: "created",
          progress: 0,
          items: [],
        },
      },
    };
  }

  const thread = requireThread(state, key);
  if (thread.status === undefined) {
    throw new ConversationProjectionError(
      "INVALID_STATE",
      `task thread ${key} has no lifecycle status`,
      key,
    );
  }
  const status = transitionTaskStatus(thread.status, event.type);
  let nextThread: ConversationThread = { ...thread, status };
  if (event.type === "task.assigned") {
    nextThread = { ...nextThread, executor: event.payload.executor };
  } else if (event.type === "task.started") {
    if (thread.executor !== event.payload.executor) {
      throw new ConversationProjectionError(
        "INVALID_ACTOR",
        `task ${key} started by a different executor`,
        key,
      );
    }
  } else if (event.type === "task.progress.updated") {
    nextThread = { ...nextThread, progress: event.payload.progress };
  }

  const withMetadata = replaceThread(state, key, nextThread);
  if (!hasDividerType(event.type)) return withMetadata;
  return appendItem(withMetadata, key, {
    kind: "divider",
    event: event as StoredEvent<DividerEventType>,
  });
}

function messageThread(event: StoredEvent<"message.sent">): ConversationThreadKey {
  return event.payload.task ?? PROJECT_THREAD_KEY;
}

function assertMessageActor(event: StoredEvent<"message.sent">): void {
  if (
    (event.actor.kind !== "agent" && event.actor.kind !== "human") ||
    event.actor.id !== event.payload.from
  ) {
    throw new ConversationProjectionError(
      "INVALID_ACTOR",
      "message sender must match its human or agent actor",
      event.id,
    );
  }
}

function reduceMessage(
  state: ConversationProjectState,
  event: StoredEvent<"message.sent">,
): ConversationProjectState {
  assertMessageActor(event);
  const key = messageThread(event);
  requireThread(state, key);
  if (event.payload.replyTo !== undefined) {
    const replyThread = state.messageThreads[event.payload.replyTo];
    if (replyThread === undefined || replyThread !== key) {
      throw new ConversationProjectionError(
        "INVALID_REPLY",
        `message reply ${event.payload.replyTo} is missing or belongs to another thread`,
        event.id,
      );
    }
  }
  return appendMessage(state, key, event);
}

function approvalStatus(
  type: "approval.granted" | "approval.rejected" | "approval.expired",
): ConversationApprovalIndex["status"] {
  if (type === "approval.granted") return "granted";
  if (type === "approval.rejected") return "rejected";
  return "expired";
}

function reduceApproval(
  state: ConversationProjectState,
  event: StoredEvent<
    "approval.requested" | "approval.granted" | "approval.rejected" | "approval.expired"
  >,
): ConversationProjectState {
  const approvalId = event.subject.id;
  if (event.type === "approval.requested") {
    if (state.approvals[approvalId] !== undefined) {
      throw new ConversationProjectionError(
        "DUPLICATE_APPROVAL",
        `approval ${approvalId} already has thread attribution`,
        approvalId,
      );
    }
    const key = event.payload.task ?? PROJECT_THREAD_KEY;
    requireThread(state, key);
    const indexed: ConversationProjectState = {
      ...state,
      approvals: {
        ...state.approvals,
        [approvalId]: { thread: key, status: "pending" },
      },
    };
    return appendItem(indexed, key, { kind: "divider", event });
  }

  const indexed = state.approvals[approvalId];
  if (indexed === undefined) {
    throw new ConversationProjectionError(
      "MISSING_APPROVAL",
      `approval ${approvalId} has no request attribution`,
      approvalId,
    );
  }
  if (indexed.status !== "pending") {
    throw new ConversationProjectionError(
      "TERMINAL_APPROVAL",
      `approval ${approvalId} is already ${indexed.status}`,
      approvalId,
    );
  }
  const next: ConversationProjectState = {
    ...state,
    approvals: {
      ...state.approvals,
      [approvalId]: { ...indexed, status: approvalStatus(event.type) },
    },
  };
  return appendItem(next, indexed.thread, { kind: "divider", event });
}

function reduceKnowledge(
  state: ConversationProjectState,
  event: StoredEvent<"knowledge.created">,
): ConversationProjectState {
  const keys: readonly ConversationThreadKey[] = event.payload.relatedTasks ?? [
    PROJECT_THREAD_KEY,
  ];
  let next = state;
  for (const key of keys) {
    next = appendItem(next, key, { kind: "divider", event });
  }
  return next;
}

export function reduceConversationProject(
  state: ConversationProjectState,
  event: StoredEvent,
): ConversationProjectState {
  if (isTaskEventType(event.type)) return reduceTaskEvent(state, event);
  if (event.type === "message.sent") return reduceMessage(state, event);
  if (event.type.startsWith("approval.")) {
    return reduceApproval(
      state,
      event as StoredEvent<
        | "approval.requested"
        | "approval.granted"
        | "approval.rejected"
        | "approval.expired"
      >,
    );
  }
  if (event.type === "knowledge.created") return reduceKnowledge(state, event);
  return state;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new ConversationProjectionError(
      "INVALID_STATE",
      `${label} must be a plain object`,
    );
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `${label} has unknown field ${key}`,
      );
    }
  }
}

function parseEvent(value: unknown, project: ProjectId, label: string): StoredEvent {
  let event: StoredEvent;
  try {
    event = parseStoredEvent(value);
  } catch (cause) {
    throw new ConversationProjectionError(
      "INVALID_STATE",
      `${label} contains an invalid event`,
      undefined,
      { cause },
    );
  }
  if (event.project !== project) {
    throw new ConversationProjectionError(
      "INVALID_STATE",
      `${label} event belongs to another project`,
    );
  }
  return event;
}

function eventThread(
  event: StoredEvent,
): ConversationThreadKey | readonly TaskId[] | null {
  if (event.type === "message.sent") return messageThread(event);
  if (isTaskEventType(event.type)) return event.subject.id as TaskId;
  if (event.type === "approval.requested")
    return event.payload.task ?? PROJECT_THREAD_KEY;
  if (event.type === "knowledge.created") {
    return event.payload.relatedTasks ?? PROJECT_THREAD_KEY;
  }
  return null;
}

function parseItem(
  value: unknown,
  project: ProjectId,
  key: ConversationThreadKey,
  label: string,
): ConversationItem {
  const item = plainObject(value, label);
  if (item.kind === "message") {
    exactKeys(item, new Set(["kind", "event"]), label);
    const event = parseEvent(item.event, project, `${label}.event`);
    if (event.type !== "message.sent" || eventThread(event) !== key) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `${label} message attribution is invalid`,
      );
    }
    assertMessageActor(event);
    return { kind: "message", event };
  }
  if (item.kind === "progress-run") {
    exactKeys(item, new Set(["kind", "events"]), label);
    if (!Array.isArray(item.events) || item.events.length < 2) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `${label}.events must contain at least two messages`,
      );
    }
    const events = item.events.map((candidate, index) => {
      const event = parseEvent(candidate, project, `${label}.events[${index}]`);
      if (
        event.type !== "message.sent" ||
        event.payload.type !== "progress" ||
        eventThread(event) !== key
      ) {
        throw new ConversationProjectionError(
          "INVALID_STATE",
          `${label}.events[${index}] is not attributed progress`,
        );
      }
      assertMessageActor(event);
      return event;
    }) as StoredEvent<"message.sent">[];
    for (let index = 1; index < events.length; index += 1) {
      const previous = events[index - 1];
      const current = events[index];
      if (
        previous === undefined ||
        current === undefined ||
        previous.seq >= current.seq ||
        !sameProgressParticipants(previous, current)
      ) {
        throw new ConversationProjectionError(
          "INVALID_STATE",
          `${label} progress events are not one ordered participant run`,
        );
      }
    }
    return { kind: "progress-run", events };
  }
  if (item.kind === "divider") {
    exactKeys(item, new Set(["kind", "event"]), label);
    const event = parseEvent(item.event, project, `${label}.event`);
    if (!hasDividerType(event.type)) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `${label} event is not a thread divider`,
      );
    }
    const attributed = eventThread(event);
    if (
      (typeof attributed === "string" && attributed !== key) ||
      (Array.isArray(attributed) && !attributed.includes(key as TaskId))
    ) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `${label} divider attribution is invalid`,
      );
    }
    return { kind: "divider", event: event as StoredEvent<DividerEventType> };
  }
  throw new ConversationProjectionError("INVALID_STATE", `${label}.kind is invalid`);
}

function itemEvents(item: ConversationItem): readonly StoredEvent[] {
  return item.kind === "progress-run" ? item.events : [item.event];
}

function progressEdge(item: ConversationItem, edge: "first" | "last") {
  if (item.kind === "divider") return undefined;
  if (item.kind === "message") {
    return item.event.payload.type === "progress" ? item.event : undefined;
  }
  return edge === "first" ? item.events[0] : item.events.at(-1);
}

function parseThread(
  value: unknown,
  project: ProjectId,
  key: ConversationThreadKey,
): ConversationThread {
  const label = `threads.${key}`;
  const thread = plainObject(value, label);
  exactKeys(
    thread,
    new Set(["task", "title", "status", "progress", "executor", "items"]),
    label,
  );
  if (!Array.isArray(thread.items)) {
    throw new ConversationProjectionError(
      "INVALID_STATE",
      `${label}.items must be an array`,
    );
  }
  if (key === PROJECT_THREAD_KEY) {
    for (const field of ["task", "title", "status", "progress", "executor"] as const) {
      if (thread[field] !== undefined) {
        throw new ConversationProjectionError(
          "INVALID_STATE",
          `${label}.${field} must be omitted`,
        );
      }
    }
  } else {
    if (taskIdSchema.safeParse(thread.task).success === false || thread.task !== key) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `${label}.task must match its key`,
      );
    }
    if (
      typeof thread.title !== "string" ||
      thread.title.length === 0 ||
      thread.title.trim() !== thread.title
    ) {
      throw new ConversationProjectionError("INVALID_STATE", `${label}.title is invalid`);
    }
    if (!(TASK_STATUSES as readonly unknown[]).includes(thread.status)) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `${label}.status is invalid`,
      );
    }
    if (
      typeof thread.progress !== "number" ||
      !Number.isFinite(thread.progress) ||
      thread.progress < 0 ||
      thread.progress > 100
    ) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `${label}.progress is invalid`,
      );
    }
    if (
      thread.executor !== undefined &&
      !entityIdSchema.safeParse(thread.executor).success
    ) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `${label}.executor is invalid`,
      );
    }
  }
  const items = thread.items.map((item, index) =>
    parseItem(item, project, key, `${label}.items[${index}]`),
  );
  let priorSeq = 0;
  for (const item of items) {
    for (const event of itemEvents(item)) {
      if (event.seq <= priorSeq) {
        throw new ConversationProjectionError(
          "INVALID_STATE",
          `${label}.items are not strictly ordered by seq`,
        );
      }
      priorSeq = event.seq;
    }
  }
  for (let index = 1; index < items.length; index += 1) {
    const previousItem = items[index - 1];
    const currentItem = items[index];
    if (previousItem === undefined || currentItem === undefined) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `${label}.items has an invalid sparse position`,
      );
    }
    const previous = progressEdge(previousItem, "last");
    const current = progressEdge(currentItem, "first");
    if (
      previous !== undefined &&
      current !== undefined &&
      sameProgressParticipants(previous, current)
    ) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `${label}.items contains an uncollapsed progress run`,
      );
    }
  }
  return key === PROJECT_THREAD_KEY
    ? { items }
    : {
        task: key,
        title: thread.title as string,
        status: thread.status as TaskStatus,
        progress: thread.progress as number,
        ...(thread.executor === undefined
          ? {}
          : { executor: thread.executor as EntityId }),
        items,
      };
}

function parseApprovalIndex(
  value: unknown,
  threads: Readonly<Record<string, ConversationThread>>,
  label: string,
): ConversationApprovalIndex {
  const indexed = plainObject(value, label);
  exactKeys(indexed, new Set(["thread", "status"]), label);
  if (
    typeof indexed.thread !== "string" ||
    threads[indexed.thread] === undefined ||
    !(["pending", "granted", "rejected", "expired"] as const).includes(
      indexed.status as never,
    )
  ) {
    throw new ConversationProjectionError("INVALID_STATE", `${label} is invalid`);
  }
  return {
    thread: indexed.thread as ConversationThreadKey,
    status: indexed.status as ConversationApprovalIndex["status"],
  };
}

function sameRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function approvalRecord(
  approvals: Readonly<Record<string, ConversationApprovalIndex>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(approvals).map(([id, value]) => [
      id,
      `${value.thread}\u0000${value.status}`,
    ]),
  );
}

export function parseConversationProjectState(
  value: unknown,
  project: ProjectId,
): ConversationProjectState {
  if (!projectIdSchema.safeParse(project).success) {
    throw new ConversationProjectionError("INVALID_STATE", "snapshot project is invalid");
  }
  const state = plainObject(value, "conversation state");
  exactKeys(
    state,
    new Set(["threads", "approvals", "messageThreads"]),
    "conversation state",
  );
  const rawThreads = plainObject(state.threads, "threads");
  if (rawThreads[PROJECT_THREAD_KEY] === undefined) {
    throw new ConversationProjectionError("INVALID_STATE", "project thread is missing");
  }
  const threads: Record<string, ConversationThread> = {};
  for (const [key, thread] of Object.entries(rawThreads)) {
    if (key !== PROJECT_THREAD_KEY && !taskIdSchema.safeParse(key).success) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `thread key ${key} is invalid`,
      );
    }
    threads[key] = parseThread(thread, project, key as ConversationThreadKey);
  }

  const rawApprovals = plainObject(state.approvals, "approvals");
  const approvals: Record<string, ConversationApprovalIndex> = {};
  for (const [id, indexed] of Object.entries(rawApprovals)) {
    if (!entityIdSchema.safeParse(id).success) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `approval key ${id} is invalid`,
      );
    }
    approvals[id] = parseApprovalIndex(indexed, threads, `approvals.${id}`);
  }

  const rawMessages = plainObject(state.messageThreads, "messageThreads");
  const messageThreads: Record<string, ConversationThreadKey> = {};
  for (const [id, key] of Object.entries(rawMessages)) {
    if (
      !eventIdSchema.safeParse(id).success ||
      typeof key !== "string" ||
      threads[key] === undefined
    ) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `messageThreads.${id} is invalid`,
      );
    }
    messageThreads[id] = key as ConversationThreadKey;
  }
  const derivedMessages: Record<string, string> = {};
  const messageSeqs: Record<string, number> = {};
  const approvalEvents: Array<
    readonly [ConversationThreadKey, StoredEvent<ApprovalEventType>]
  > = [];
  for (const [key, thread] of Object.entries(threads)) {
    for (const item of thread.items) {
      if (item.kind === "divider") {
        if (item.event.type.startsWith("approval.")) {
          approvalEvents.push([
            key as ConversationThreadKey,
            item.event as StoredEvent<ApprovalEventType>,
          ]);
        }
        continue;
      }
      for (const event of itemEvents(item)) {
        if (derivedMessages[event.id] !== undefined) {
          throw new ConversationProjectionError(
            "INVALID_STATE",
            `message ${event.id} appears more than once`,
          );
        }
        derivedMessages[event.id] = key;
        messageSeqs[event.id] = event.seq;
      }
    }
  }
  if (!sameRecord(messageThreads, derivedMessages)) {
    throw new ConversationProjectionError(
      "INVALID_STATE",
      "message thread index does not match thread items",
    );
  }
  for (const thread of Object.values(threads)) {
    for (const item of thread.items) {
      if (item.kind === "divider") continue;
      const events = item.kind === "progress-run" ? item.events : [item.event];
      for (const event of events) {
        const replyTo = event.payload.replyTo;
        if (
          replyTo !== undefined &&
          (messageThreads[replyTo] !== messageThreads[event.id] ||
            (messageSeqs[replyTo] ?? Number.POSITIVE_INFINITY) >= event.seq)
        ) {
          throw new ConversationProjectionError(
            "INVALID_STATE",
            `message ${event.id} has an invalid reply reference`,
          );
        }
      }
    }
  }

  const derivedApprovals: Record<string, ConversationApprovalIndex> = {};
  approvalEvents.sort((left, right) => left[1].seq - right[1].seq);
  for (const [thread, event] of approvalEvents) {
    const id = event.subject.id;
    if (event.type === "approval.requested") {
      if (derivedApprovals[id] !== undefined) {
        throw new ConversationProjectionError(
          "INVALID_STATE",
          `approval ${id} has duplicate request items`,
        );
      }
      const attributed = event.payload.task ?? PROJECT_THREAD_KEY;
      if (attributed !== thread) {
        throw new ConversationProjectionError(
          "INVALID_STATE",
          `approval ${id} request appears in the wrong thread`,
        );
      }
      derivedApprovals[id] = { thread, status: "pending" };
      continue;
    }
    const existing = derivedApprovals[id];
    if (
      existing === undefined ||
      existing.status !== "pending" ||
      existing.thread !== thread
    ) {
      throw new ConversationProjectionError(
        "INVALID_STATE",
        `approval ${id} decision attribution is invalid`,
      );
    }
    derivedApprovals[id] = {
      thread,
      status: approvalStatus(event.type),
    };
  }
  if (!sameRecord(approvalRecord(approvals), approvalRecord(derivedApprovals))) {
    throw new ConversationProjectionError(
      "INVALID_STATE",
      "approval thread index does not match divider items",
    );
  }
  return { threads, approvals, messageThreads };
}

export function registerConversationReducer(
  bus: EventBus,
): ReducerHandle<ConversationProjectState> {
  return bus.registerReducer(
    "conversations",
    emptyConversationProjectState,
    reduceConversationProject,
    { version: "1", parseState: parseConversationProjectState },
  );
}
