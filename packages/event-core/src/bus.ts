import { parseStoredEvent } from "./envelope.js";
import type { EventInput, StoredEvent } from "./envelope.js";
import { deepFreeze } from "./immutable.js";
import type { DeepReadonly } from "./immutable.js";
import type { EventType } from "./payloads.js";
import { projectIdSchema } from "./primitives.js";
import type { ProjectId } from "./primitives.js";

export type EventAppendOptions = Readonly<{ token: string }>;
export type EventReadOptions = Readonly<{ afterSeq?: number }>;
export type EventAppendInput<Type extends EventType> = EventInput<Type> &
  Readonly<{
    schemaVersion?: never;
    id?: never;
    seq?: never;
    at?: never;
  }>;

export interface EventBusStore {
  append<Type extends EventType>(
    input: EventAppendInput<Type>,
    options: EventAppendOptions,
  ): StoredEvent<Type>;
  read(project: ProjectId, options?: EventReadOptions): readonly StoredEvent[];
}

export type EventReducer<State> = (
  state: DeepReadonly<State>,
  event: StoredEvent,
) => State;
export type EventSubscriber = (event: StoredEvent) => void | Promise<void>;
export type SubscriberErrorHandler = (cause: unknown, event: StoredEvent) => void;

export type EventBusOptions = Readonly<{
  store: EventBusStore;
  onSubscriberError?: SubscriberErrorHandler;
}>;

export type SubscribeOptions = Readonly<{ project?: ProjectId }>;

export type ReplayEvidence = Readonly<{
  project: ProjectId;
  eventCount: number;
  throughSeq: number;
  reducerCount: number;
}>;

export type ReducerHandle<State> = Readonly<{
  name: string;
  get(project: ProjectId): DeepReadonly<State>;
}>;

type EventBusCode =
  | "ASYNC_REDUCER"
  | "DUPLICATE_REDUCER"
  | "INVALID_OPTIONS"
  | "REDUCER_FAILED"
  | "REPLAY_FAILED";

export class EventBusError extends Error {
  readonly code: EventBusCode;

  constructor(code: EventBusCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EventBusError";
    this.code = code;
  }
}

export class ReducerRegistrationError extends EventBusError {
  readonly reducer: string;

  constructor(code: "ASYNC_REDUCER" | "DUPLICATE_REDUCER", reducer: string) {
    super(
      code,
      `${code === "ASYNC_REDUCER" ? "asynchronous" : "duplicate"} reducer: ${reducer}`,
    );
    this.name = "ReducerRegistrationError";
    this.reducer = reducer;
  }
}

export class ReducerExecutionError extends EventBusError {
  readonly reducer: string;
  readonly project: ProjectId;
  readonly event: StoredEvent | null;

  constructor(
    reducer: string,
    project: ProjectId,
    event: StoredEvent | null,
    cause: unknown,
  ) {
    super(
      isThenable(cause) ? "ASYNC_REDUCER" : "REDUCER_FAILED",
      `reducer ${reducer} failed for ${project}${event ? ` at seq ${event.seq}` : " while initializing"}`,
      { cause },
    );
    this.name = "ReducerExecutionError";
    this.reducer = reducer;
    this.project = project;
    this.event = event;
  }
}

export class EventReplayError extends EventBusError {
  readonly project: ProjectId;

  constructor(project: ProjectId, message: string, options?: ErrorOptions) {
    super("REPLAY_FAILED", message, options);
    this.name = "EventReplayError";
    this.project = project;
  }
}

type ReducerRecord = {
  readonly name: string;
  readonly initialState: () => unknown;
  readonly reduce: (state: unknown, event: StoredEvent) => unknown;
};

type ProjectProjection = {
  throughSeq: number;
  eventCount: number;
  states: Map<string, unknown>;
};

type Subscription = {
  readonly handler: EventSubscriber;
  readonly project?: ProjectId;
};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function isDeclaredAsync(value: (...args: never[]) => unknown): boolean {
  return Object.prototype.toString.call(value) === "[object AsyncFunction]";
}

function parseProject(project: unknown): ProjectId {
  const result = projectIdSchema.safeParse(project);
  if (!result.success) {
    throw new EventBusError("INVALID_OPTIONS", "invalid project id", {
      cause: result.error,
    });
  }
  return result.data;
}

function parseReducerName(name: unknown): string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 128 ||
    name.trim() !== name
  ) {
    throw new EventBusError(
      "INVALID_OPTIONS",
      "reducer name must be 1-128 unpadded characters",
    );
  }
  return name;
}

export class EventBus {
  readonly #store: EventBusStore;
  readonly #onSubscriberError: SubscriberErrorHandler;
  readonly #reducers = new Map<string, ReducerRecord>();
  readonly #projects = new Map<ProjectId, ProjectProjection>();
  readonly #subscriptions = new Set<Subscription>();
  readonly #notificationQueue: StoredEvent[] = [];
  #notifying = false;

  constructor(options: EventBusOptions) {
    if (options === null || typeof options !== "object") {
      throw new EventBusError("INVALID_OPTIONS", "event bus options are required");
    }
    if (
      options.store === null ||
      typeof options.store !== "object" ||
      typeof options.store.append !== "function" ||
      typeof options.store.read !== "function"
    ) {
      throw new EventBusError("INVALID_OPTIONS", "event bus store is invalid");
    }
    if (
      options.onSubscriberError !== undefined &&
      typeof options.onSubscriberError !== "function"
    ) {
      throw new EventBusError("INVALID_OPTIONS", "onSubscriberError must be a function");
    }
    this.#store = options.store;
    this.#onSubscriberError = options.onSubscriberError ?? (() => {});
  }

  append<Type extends EventType>(
    input: EventAppendInput<Type>,
    options: EventAppendOptions,
  ): StoredEvent<Type> {
    const project = parseProject(input?.project);
    this.#ensureProject(project);
    let event: StoredEvent<Type>;
    try {
      event = parseStoredEvent(this.#store.append(input, options)) as StoredEvent<Type>;
    } catch (cause) {
      throw new EventReplayError(
        project,
        "event store append returned an invalid event",
        {
          cause,
        },
      );
    }
    if (event.project !== project) {
      throw new EventReplayError(
        project,
        `event store append returned an event for ${event.project}`,
      );
    }
    const delivered = this.#catchUp(project);
    const projection = this.#projects.get(project);
    if (projection === undefined || projection.throughSeq < event.seq) {
      throw new EventReplayError(
        project,
        `store did not return durable event seq ${event.seq} during tail catch-up`,
      );
    }
    this.#enqueue(delivered);
    return event;
  }

  subscribe(handler: EventSubscriber, options: SubscribeOptions = {}): () => void {
    if (typeof handler !== "function") {
      throw new EventBusError("INVALID_OPTIONS", "subscriber must be a function");
    }
    const subscription: Subscription = {
      handler,
      ...(options.project === undefined
        ? {}
        : { project: parseProject(options.project) }),
    };
    this.#subscriptions.add(subscription);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#subscriptions.delete(subscription);
    };
  }

  replay(project: ProjectId): ReplayEvidence {
    const admittedProject = parseProject(project);
    const rebuilt = this.#buildProject(admittedProject);
    this.#projects.set(admittedProject, rebuilt);
    return Object.freeze({
      project: admittedProject,
      eventCount: rebuilt.eventCount,
      throughSeq: rebuilt.throughSeq,
      reducerCount: this.#reducers.size,
    });
  }

  registerReducer<State>(
    name: string,
    initialState: () => State,
    reducer: EventReducer<State>,
  ): ReducerHandle<State> {
    const admittedName = parseReducerName(name);
    if (typeof initialState !== "function" || typeof reducer !== "function") {
      throw new EventBusError(
        "INVALID_OPTIONS",
        "initialState and reducer must be functions",
      );
    }
    if (this.#reducers.has(admittedName)) {
      throw new ReducerRegistrationError("DUPLICATE_REDUCER", admittedName);
    }
    if (
      isDeclaredAsync(initialState as (...args: never[]) => unknown) ||
      isDeclaredAsync(reducer as (...args: never[]) => unknown)
    ) {
      throw new ReducerRegistrationError("ASYNC_REDUCER", admittedName);
    }

    const record: ReducerRecord = {
      name: admittedName,
      initialState,
      reduce: reducer as (state: unknown, event: StoredEvent) => unknown,
    };
    const states = new Map<ProjectId, unknown>();
    for (const [project, projection] of this.#projects) {
      let state = this.#initialState(record, project);
      for (const event of this.#readValidated(project, 0)) {
        if (event.seq > projection.throughSeq) break;
        state = this.#runReducer(record, state, event);
      }
      states.set(project, state);
    }

    this.#reducers.set(admittedName, record);
    for (const [project, state] of states) {
      this.#projects.get(project)?.states.set(admittedName, state);
    }

    return Object.freeze({
      name: admittedName,
      get: (project: ProjectId) => {
        const admittedProject = parseProject(project);
        this.#ensureProject(admittedProject);
        const states = this.#projects.get(admittedProject)?.states;
        if (states === undefined || !states.has(admittedName)) {
          throw new EventReplayError(
            admittedProject,
            `reducer ${admittedName} has no published state`,
          );
        }
        return states.get(admittedName) as DeepReadonly<State>;
      },
    });
  }

  #ensureProject(project: ProjectId): void {
    if (!this.#projects.has(project))
      this.#projects.set(project, this.#buildProject(project));
  }

  #buildProject(project: ProjectId): ProjectProjection {
    const states = new Map<string, unknown>();
    for (const reducer of this.#reducers.values()) {
      states.set(reducer.name, this.#initialState(reducer, project));
    }
    let throughSeq = 0;
    let eventCount = 0;
    for (const event of this.#readValidated(project, 0)) {
      this.#reduceAll(states, event);
      throughSeq = event.seq;
      eventCount += 1;
    }
    return { throughSeq, eventCount, states };
  }

  #catchUp(project: ProjectId): StoredEvent[] {
    const projection = this.#projects.get(project);
    if (projection === undefined) {
      throw new EventReplayError(project, "project projection was not initialized");
    }
    const events = this.#readValidated(project, projection.throughSeq);
    for (const event of events) {
      this.#reduceAll(projection.states, event);
      projection.throughSeq = event.seq;
      projection.eventCount += 1;
    }
    return events;
  }

  #readValidated(project: ProjectId, afterSeq: number): StoredEvent[] {
    let rows: readonly StoredEvent[];
    try {
      rows = this.#store.read(project, { afterSeq });
    } catch (cause) {
      throw new EventReplayError(project, "event store read failed", { cause });
    }
    if (!Array.isArray(rows)) {
      throw new EventReplayError(project, "event store read returned a non-array");
    }
    const events: StoredEvent[] = [];
    let expectedSeq = afterSeq + 1;
    for (const row of rows) {
      let event: StoredEvent;
      try {
        event = parseStoredEvent(row);
      } catch (cause) {
        throw new EventReplayError(project, "event store returned an invalid event", {
          cause,
        });
      }
      if (event.project !== project || event.seq !== expectedSeq) {
        throw new EventReplayError(
          project,
          `expected ${project} seq ${expectedSeq}, found ${event.project} seq ${event.seq}`,
        );
      }
      events.push(event);
      expectedSeq += 1;
    }
    return events;
  }

  #initialState(reducer: ReducerRecord, project: ProjectId): unknown {
    let state: unknown;
    try {
      state = reducer.initialState();
    } catch (cause) {
      throw new ReducerExecutionError(reducer.name, project, null, cause);
    }
    if (isThenable(state)) {
      throw new ReducerExecutionError(reducer.name, project, null, state);
    }
    return deepFreeze(state);
  }

  #runReducer(reducer: ReducerRecord, state: unknown, event: StoredEvent): unknown {
    let candidate: unknown;
    try {
      candidate = reducer.reduce(state, event);
    } catch (cause) {
      throw new ReducerExecutionError(reducer.name, event.project, event, cause);
    }
    if (isThenable(candidate)) {
      throw new ReducerExecutionError(reducer.name, event.project, event, candidate);
    }
    return deepFreeze(candidate);
  }

  #reduceAll(states: Map<string, unknown>, event: StoredEvent): void {
    const candidates = new Map<string, unknown>();
    for (const reducer of this.#reducers.values()) {
      candidates.set(
        reducer.name,
        this.#runReducer(reducer, states.get(reducer.name), event),
      );
    }
    for (const [name, state] of candidates) states.set(name, state);
  }

  #enqueue(events: readonly StoredEvent[]): void {
    this.#notificationQueue.push(...events);
    if (this.#notifying) return;
    this.#notifying = true;
    try {
      while (this.#notificationQueue.length > 0) {
        const event = this.#notificationQueue.shift();
        if (event === undefined) continue;
        for (const subscription of [...this.#subscriptions]) {
          if (
            subscription.project !== undefined &&
            subscription.project !== event.project
          ) {
            continue;
          }
          try {
            const result = subscription.handler(event);
            if (isThenable(result)) {
              Promise.resolve(result).catch((cause) =>
                this.#reportSubscriberError(cause, event),
              );
            }
          } catch (cause) {
            this.#reportSubscriberError(cause, event);
          }
        }
      }
    } finally {
      this.#notifying = false;
    }
  }

  #reportSubscriberError(cause: unknown, event: StoredEvent): void {
    try {
      this.#onSubscriberError(cause, event);
    } catch {}
  }
}

export function createEventBus(options: EventBusOptions): EventBus {
  return new EventBus(options);
}
