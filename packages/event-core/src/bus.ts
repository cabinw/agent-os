import { parseStoredEvent } from "./envelope.js";
import type { EventInput, StoredEvent } from "./envelope.js";
import type { EventId } from "./id.js";
import { deepFreeze } from "./immutable.js";
import type { DeepReadonly } from "./immutable.js";
import type { EventType } from "./payloads.js";
import { projectIdSchema } from "./primitives.js";
import type { ProjectId } from "./primitives.js";

export type EventAppendOptions = Readonly<{ token: string }>;
export type EventAppendGroupEntry = Readonly<{
  input: EventAppendInput<EventType>;
  options: EventAppendOptions;
}>;
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
  appendGroup?(entries: readonly EventAppendGroupEntry[]): readonly StoredEvent[];
  read(project: ProjectId, options?: EventReadOptions): readonly StoredEvent[];
}

export type EventReducer<State> = (
  state: DeepReadonly<State>,
  event: StoredEvent,
) => State;
export type EventSubscriber = (event: StoredEvent) => void | Promise<void>;
export type SubscriberErrorHandler = (cause: unknown, event: StoredEvent) => void;
export type SnapshotErrorHandler = (cause: unknown, project: ProjectId) => void;

export type ProjectionSnapshot = Readonly<{
  project: ProjectId;
  throughSeq: number;
  throughEventId: EventId;
  manifest: string;
  states: Readonly<Record<string, unknown>>;
}>;

export interface ProjectionSnapshotCache {
  load(project: ProjectId, manifest: string): ProjectionSnapshot | null;
  save(snapshot: ProjectionSnapshot): void;
  delete(project: ProjectId, manifest: string): void;
  clear(project?: ProjectId): number;
}

export type ReducerSnapshotOptions<State> = Readonly<{
  version: string;
  parseState: (value: unknown, project: ProjectId) => State;
}>;

export type EventBusOptions = Readonly<{
  store: EventBusStore;
  onSubscriberError?: SubscriberErrorHandler;
  snapshots?: ProjectionSnapshotCache;
  snapshotEvery?: number;
  onSnapshotError?: SnapshotErrorHandler;
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
  readonly snapshotVersion?: string;
  readonly parseState?: (value: unknown, project: ProjectId) => unknown;
};

type ProjectProjection = {
  throughSeq: number;
  throughEventId: EventId | null;
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
  readonly #snapshots: ProjectionSnapshotCache | null;
  readonly #snapshotEvery: number;
  readonly #onSnapshotError: SnapshotErrorHandler;
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
    if (options.snapshots !== undefined) {
      const cache = options.snapshots;
      if (
        cache === null ||
        typeof cache !== "object" ||
        typeof cache.load !== "function" ||
        typeof cache.save !== "function" ||
        typeof cache.delete !== "function" ||
        typeof cache.clear !== "function"
      ) {
        throw new EventBusError("INVALID_OPTIONS", "snapshot cache is invalid");
      }
    } else if (options.snapshotEvery !== undefined) {
      throw new EventBusError(
        "INVALID_OPTIONS",
        "snapshotEvery requires a snapshot cache",
      );
    }
    const snapshotEvery = options.snapshotEvery ?? 100;
    if (!Number.isSafeInteger(snapshotEvery) || snapshotEvery <= 0) {
      throw new EventBusError(
        "INVALID_OPTIONS",
        "snapshotEvery must be a positive safe integer",
      );
    }
    if (
      options.onSnapshotError !== undefined &&
      typeof options.onSnapshotError !== "function"
    ) {
      throw new EventBusError("INVALID_OPTIONS", "onSnapshotError must be a function");
    }
    this.#store = options.store;
    this.#onSubscriberError = options.onSubscriberError ?? (() => {});
    this.#snapshots = options.snapshots ?? null;
    this.#snapshotEvery = snapshotEvery;
    this.#onSnapshotError = options.onSnapshotError ?? (() => {});
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

  appendGroup(entries: readonly EventAppendGroupEntry[]): readonly StoredEvent[] {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new EventBusError("INVALID_OPTIONS", "event group must be a non-empty array");
    }
    if (typeof this.#store.appendGroup !== "function") {
      throw new EventBusError(
        "INVALID_OPTIONS",
        "event bus store has no atomic group support",
      );
    }
    const project = parseProject(entries[0]?.input?.project);
    for (const entry of entries) {
      if (parseProject(entry?.input?.project) !== project) {
        throw new EventBusError(
          "INVALID_OPTIONS",
          "an event group cannot cross project boundaries",
        );
      }
    }
    this.#ensureProject(project);
    let rows: readonly StoredEvent[];
    try {
      rows = this.#store.appendGroup(entries);
    } catch (cause) {
      throw new EventReplayError(project, "event store group append failed", { cause });
    }
    if (!Array.isArray(rows) || rows.length !== entries.length) {
      throw new EventReplayError(
        project,
        "event store group append returned the wrong event count",
      );
    }
    const events = rows.map((row) => {
      try {
        return parseStoredEvent(row);
      } catch (cause) {
        throw new EventReplayError(
          project,
          "event store group append returned an invalid event",
          { cause },
        );
      }
    });
    if (events.some((event) => event.project !== project)) {
      throw new EventReplayError(
        project,
        "event store group append returned an event for another project",
      );
    }
    const delivered = this.#catchUp(project);
    const projection = this.#projects.get(project);
    const last = events.at(-1);
    if (
      projection === undefined ||
      last === undefined ||
      projection.throughSeq < last.seq
    ) {
      throw new EventReplayError(
        project,
        "store did not return the durable event group during tail catch-up",
      );
    }
    this.#enqueue(delivered);
    return Object.freeze(events);
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
    const rebuilt = this.#buildProject(admittedProject, false);
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
    snapshot?: ReducerSnapshotOptions<State>,
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
    if (this.#snapshots !== null) {
      if (
        snapshot === undefined ||
        typeof snapshot.version !== "string" ||
        snapshot.version.length === 0 ||
        snapshot.version.length > 128 ||
        snapshot.version.trim() !== snapshot.version ||
        typeof snapshot.parseState !== "function"
      ) {
        throw new EventBusError(
          "INVALID_OPTIONS",
          `reducer ${admittedName} requires snapshot version and parser`,
        );
      }
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
      ...(snapshot === undefined
        ? {}
        : {
            snapshotVersion: snapshot.version,
            parseState: snapshot.parseState as (
              value: unknown,
              project: ProjectId,
            ) => unknown,
          }),
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
    for (const [project, projection] of this.#projects) {
      this.#captureSnapshot(project, projection);
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
      this.#projects.set(project, this.#buildProject(project, true));
  }

  #buildProject(project: ProjectId, useSnapshot: boolean): ProjectProjection {
    if (useSnapshot) {
      const restored = this.#restoreSnapshot(project);
      if (restored !== null) return restored;
    }
    const states = new Map<string, unknown>();
    for (const reducer of this.#reducers.values()) {
      states.set(reducer.name, this.#initialState(reducer, project));
    }
    const projection: ProjectProjection = {
      throughSeq: 0,
      throughEventId: null,
      eventCount: 0,
      states,
    };
    for (const event of this.#readValidated(project, 0)) {
      this.#reduceAll(states, event);
      projection.throughSeq = event.seq;
      projection.throughEventId = event.id;
      projection.eventCount += 1;
      this.#captureSnapshot(project, projection);
    }
    return projection;
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
      projection.throughEventId = event.id;
      projection.eventCount += 1;
      this.#captureSnapshot(project, projection);
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

  #manifest(): string {
    return JSON.stringify(
      [...this.#reducers.values()]
        .map((reducer) => [reducer.name, reducer.snapshotVersion] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  #captureSnapshot(project: ProjectId, projection: ProjectProjection): void {
    if (
      this.#snapshots === null ||
      projection.throughSeq === 0 ||
      projection.throughSeq % this.#snapshotEvery !== 0 ||
      projection.throughEventId === null
    ) {
      return;
    }
    const states: Record<string, unknown> = {};
    for (const name of [...this.#reducers.keys()].sort()) {
      states[name] = projection.states.get(name);
    }
    try {
      this.#snapshots.save(
        Object.freeze({
          project,
          throughSeq: projection.throughSeq,
          throughEventId: projection.throughEventId,
          manifest: this.#manifest(),
          states: Object.freeze(states),
        }),
      );
    } catch (cause) {
      this.#reportSnapshotError(cause, project);
    }
  }

  #restoreSnapshot(project: ProjectId): ProjectProjection | null {
    if (this.#snapshots === null || this.#reducers.size === 0) return null;
    const manifest = this.#manifest();
    try {
      const snapshot = this.#snapshots.load(project, manifest);
      if (snapshot === null) return null;
      if (
        snapshot.project !== project ||
        snapshot.manifest !== manifest ||
        !Number.isSafeInteger(snapshot.throughSeq) ||
        snapshot.throughSeq <= 0 ||
        snapshot.states === null ||
        typeof snapshot.states !== "object" ||
        Array.isArray(snapshot.states)
      ) {
        throw new Error("snapshot envelope is invalid");
      }
      const expectedNames = [...this.#reducers.keys()].sort();
      if (
        JSON.stringify(Object.keys(snapshot.states).sort()) !==
        JSON.stringify(expectedNames)
      ) {
        throw new Error("snapshot state keys do not match installed reducers");
      }
      const states = new Map<string, unknown>();
      for (const name of expectedNames) {
        const reducer = this.#reducers.get(name);
        if (reducer?.parseState === undefined) {
          throw new Error(`reducer ${name} has no snapshot parser`);
        }
        const parsed = reducer.parseState(snapshot.states[name], project);
        if (isThenable(parsed)) throw new Error(`reducer ${name} parser is asynchronous`);
        states.set(name, deepFreeze(parsed));
      }
      const anchorAndTail = this.#readValidated(project, snapshot.throughSeq - 1);
      const anchor = anchorAndTail[0];
      if (
        anchor === undefined ||
        anchor.seq !== snapshot.throughSeq ||
        anchor.id !== snapshot.throughEventId
      ) {
        throw new Error("snapshot event anchor does not match the durable log");
      }
      const projection: ProjectProjection = {
        throughSeq: snapshot.throughSeq,
        throughEventId: snapshot.throughEventId,
        eventCount: snapshot.throughSeq,
        states,
      };
      for (const event of anchorAndTail.slice(1)) {
        this.#reduceAll(states, event);
        projection.throughSeq = event.seq;
        projection.throughEventId = event.id;
        projection.eventCount += 1;
        this.#captureSnapshot(project, projection);
      }
      return projection;
    } catch (cause) {
      this.#reportSnapshotError(cause, project);
      try {
        this.#snapshots.delete(project, manifest);
      } catch (discardCause) {
        this.#reportSnapshotError(discardCause, project);
      }
      return null;
    }
  }

  #reportSnapshotError(cause: unknown, project: ProjectId): void {
    try {
      this.#onSnapshotError(cause, project);
    } catch {}
  }
}

export function createEventBus(options: EventBusOptions): EventBus {
  return new EventBus(options);
}
