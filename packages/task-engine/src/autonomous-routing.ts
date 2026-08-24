import { parseStoredEvent } from "@agent-os/event-core";
import type {
  EntityId,
  EventBus,
  EventId,
  EventType,
  ProjectId,
  StoredEvent,
  TaskId,
} from "@agent-os/event-core";
import { parseAgentCatalogState } from "./catalog.js";
import type { AgentCatalogState } from "./catalog.js";
import { readyTaskIds } from "./graph.js";
import { parseTaskProjectState } from "./reducer.js";
import type { TaskProjectState, TaskState } from "./reducer.js";
import { selectAgentPlacement } from "./routing.js";
import type {
  AgentRouteResult,
  LivePlacement,
  NoEligiblePlacementReason,
} from "./routing.js";

type Awaitable<Value> = Value | Promise<Value>;

export const AUTONOMOUS_ROUTING_TRIGGERS = Object.freeze([
  "agent.registered",
  "agent.status.changed",
  "agent.disconnected",
  "task.created",
  "task.assigned",
  "task.blocked",
  "task.review.requested",
  "task.completed",
  "task.failed",
  "task.cancelled",
] as const satisfies readonly EventType[]);

export type AutonomousRoutingSnapshot = Readonly<{
  tasks: TaskProjectState;
  catalog: AgentCatalogState;
  livePlacements: readonly LivePlacement[];
}>;

export type AutonomousAssignmentCommand = Readonly<{
  project: ProjectId;
  task: TaskId;
  executor: EntityId;
  host: EntityId;
  matchedBy: "capability";
  expectedTaskStatus: "created";
  causedBy: EventId;
  operationToken: string;
}>;

export interface AutonomousRoutingPort {
  snapshot(project: ProjectId): Awaitable<AutonomousRoutingSnapshot>;
  /** Atomically reserve `(executor, host)` and append `task.assigned`. */
  assign(command: AutonomousAssignmentCommand): Awaitable<"assigned" | "conflict">;
}

export type AutonomousRoutingDecision =
  | Readonly<{ kind: "skipped"; trigger: EventType }>
  | Readonly<{ kind: "idle"; trigger: EventType }>
  | Readonly<{
      kind: "unmatched";
      trigger: EventType;
      task: TaskId;
      reason: NoEligiblePlacementReason;
    }>
  | Readonly<{
      kind: "conflict";
      trigger: EventType;
      task: TaskId;
      executor: EntityId;
      host: EntityId;
    }>
  | Readonly<{
      kind: "assigned";
      trigger: EventType;
      task: TaskId;
      executor: EntityId;
      host: EntityId;
    }>;

export class AutonomousRoutingError extends Error {
  readonly code:
    | "ASSIGNMENT_FAILURE"
    | "INVALID_EVENT"
    | "INVALID_OPTIONS"
    | "READ_FAILURE"
    | "ROUTING_FAILURE";

  constructor(
    code: AutonomousRoutingError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AutonomousRoutingError";
    this.code = code;
  }
}

const PRIORITY = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });

function compareTasks(left: TaskState, right: TaskState): number {
  const priority = PRIORITY[left.priority] - PRIORITY[right.priority];
  if (priority !== 0) return priority;
  const created = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return created === 0 ? left.id.localeCompare(right.id) : created;
}

function nextReadyTask(state: TaskProjectState): TaskState | undefined {
  return readyTaskIds(state)
    .map((id) => state.tasks[id] as TaskState)
    .sort(compareTasks)[0];
}

function freeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function assertPort(port: AutonomousRoutingPort): void {
  if (
    port === null ||
    typeof port !== "object" ||
    typeof port.snapshot !== "function" ||
    typeof port.assign !== "function"
  ) {
    throw new AutonomousRoutingError(
      "INVALID_OPTIONS",
      "AutonomousRoutingPort is invalid",
    );
  }
}

export class AutonomousTaskRouter {
  readonly #port: AutonomousRoutingPort;
  readonly #tails = new Map<ProjectId, Promise<void>>();

  constructor(port: AutonomousRoutingPort) {
    assertPort(port);
    this.#port = port;
  }

  route(eventValue: unknown): Promise<AutonomousRoutingDecision> {
    let event: StoredEvent;
    try {
      event = parseStoredEvent(eventValue);
    } catch (cause) {
      return Promise.reject(
        new AutonomousRoutingError(
          "INVALID_EVENT",
          "autonomous routing requires a durable event",
          { cause },
        ),
      );
    }
    if (!(AUTONOMOUS_ROUTING_TRIGGERS as readonly EventType[]).includes(event.type)) {
      return Promise.resolve(freeze({ kind: "skipped", trigger: event.type }));
    }

    const prior = this.#tails.get(event.project) ?? Promise.resolve();
    const work = prior.then(() => this.#routeOne(event));
    const tail = work.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(event.project, tail);
    return work.finally(() => {
      if (this.#tails.get(event.project) === tail) this.#tails.delete(event.project);
    });
  }

  attach(bus: EventBus): () => void {
    if (bus === null || typeof bus !== "object" || typeof bus.subscribe !== "function") {
      throw new AutonomousRoutingError("INVALID_OPTIONS", "EventBus is invalid");
    }
    return bus.subscribe((event) => this.route(event).then(() => undefined));
  }

  async #routeOne(event: StoredEvent): Promise<AutonomousRoutingDecision> {
    let snapshot: AutonomousRoutingSnapshot;
    try {
      snapshot = await this.#port.snapshot(event.project);
    } catch (cause) {
      throw new AutonomousRoutingError(
        "READ_FAILURE",
        "autonomous routing snapshot is unavailable",
        { cause },
      );
    }
    if (
      snapshot === null ||
      typeof snapshot !== "object" ||
      !Array.isArray(snapshot.livePlacements)
    ) {
      throw new AutonomousRoutingError(
        "READ_FAILURE",
        "autonomous routing snapshot is invalid",
      );
    }
    let tasks: TaskProjectState;
    let catalog: AgentCatalogState;
    try {
      tasks = parseTaskProjectState(snapshot.tasks, event.project);
      catalog = parseAgentCatalogState(snapshot.catalog, event.project);
    } catch (cause) {
      throw new AutonomousRoutingError(
        "READ_FAILURE",
        "autonomous routing projections are invalid",
        { cause },
      );
    }
    const task = nextReadyTask(tasks);
    if (task === undefined) return freeze({ kind: "idle", trigger: event.type });

    let route: AgentRouteResult;
    try {
      route = selectAgentPlacement(
        catalog,
        tasks,
        snapshot.livePlacements,
        task.requires,
      );
    } catch (cause) {
      throw new AutonomousRoutingError(
        "ROUTING_FAILURE",
        `autonomous routing failed for ${task.id}`,
        { cause },
      );
    }
    if (!route.matched) {
      return freeze({
        kind: "unmatched",
        trigger: event.type,
        task: task.id,
        reason: route.reason,
      });
    }
    const command = freeze({
      project: event.project,
      task: task.id,
      executor: route.candidate.agent,
      host: route.candidate.host,
      matchedBy: "capability" as const,
      expectedTaskStatus: "created" as const,
      causedBy: event.id,
      operationToken: `auto-route:${event.id}:${task.id}`,
    });
    let result: "assigned" | "conflict";
    try {
      result = await this.#port.assign(command);
    } catch (cause) {
      throw new AutonomousRoutingError(
        "ASSIGNMENT_FAILURE",
        `autonomous assignment failed for ${task.id}`,
        { cause },
      );
    }
    if (result !== "assigned" && result !== "conflict") {
      throw new AutonomousRoutingError(
        "ASSIGNMENT_FAILURE",
        `autonomous assignment returned invalid result for ${task.id}`,
      );
    }
    return freeze({
      kind: result,
      trigger: event.type,
      task: task.id,
      executor: route.candidate.agent,
      host: route.candidate.host,
    });
  }
}

export function createAutonomousTaskRouter(
  port: AutonomousRoutingPort,
): AutonomousTaskRouter {
  return new AutonomousTaskRouter(port);
}
