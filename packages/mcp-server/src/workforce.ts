import {
  CAPABILITIES,
  type Capability,
  type DeepReadonly,
  type EventId,
  type ProjectId,
  type StoredEvent,
  parseStoredEvent,
  rfc3339Schema,
} from "@agent-os/event-core";
import {
  type AgentCatalogState,
  type LivePlacement,
  type TaskProjectState,
  type TaskState,
  agentPlacementKey,
  rankAgentPlacements,
  reduceAgentCatalog,
  reduceTaskProject,
  selectAgentPlacement,
  unmetDependencies,
} from "@agent-os/task-engine";

const STATUS_RANK = Object.freeze({
  blocked: 8,
  review: 7,
  running: 6,
  assigned: 5,
  created: 4,
  failed: 3,
  cancelled: 2,
  completed: 1,
});
const PRIORITY_RANK = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 });
const ACTIVE_TASKS = new Set(["assigned", "running", "blocked", "review"]);

type Sourced = Readonly<{ sourceEvents: readonly EventId[] }>;

export type WorkforceTaskAssignment = DeepReadonly<
  | { kind: "assigned"; executor: string }
  | { kind: "waiting-dependency"; tasks: readonly string[] }
  | { kind: "awaiting-assignment"; candidate: { agent: string; host: string } }
  | {
      kind: "no-capability" | "unreachable" | "unavailable" | "saturated";
      requiredCapabilities: readonly Capability[];
    }
  | { kind: "not-applicable" }
>;
export type WorkforceTask = DeepReadonly<
  Sourced & {
    task: string;
    title: string;
    goal: string;
    status:
      | "created"
      | "assigned"
      | "running"
      | "blocked"
      | "review"
      | "completed"
      | "failed"
      | "cancelled";
    progress: number;
    priority: "low" | "medium" | "high" | "critical";
    owner: string;
    executor?: string;
    requires: readonly Capability[];
    dependsOn: readonly string[];
    outputs: readonly string[];
    assignment: WorkforceTaskAssignment;
    awaitingHumanReview: boolean;
    blocker?: Readonly<{
      reason: string;
      severity: "low" | "medium" | "high" | "critical";
      needs: "human" | "agent" | "resource";
    }>;
    createdAt: string;
    changedAt: string;
  }
>;
export type WorkforcePlacement = DeepReadonly<
  Sourced & {
    host: string;
    capabilities: readonly Capability[];
    declaredStatus: "idle" | "working" | "waiting" | "blocked";
    integration: Readonly<{
      participates: boolean;
      streaming: boolean;
      reasoning: boolean;
      session: boolean;
      usage: boolean;
    }>;
    connected: boolean;
    accepting: boolean;
    active: number;
  }
>;
export type WorkforceAgent = DeepReadonly<
  Sourced & {
    agent: string;
    name: string;
    provider: string;
    role:
      | "supervisor"
      | "architect"
      | "developer"
      | "researcher"
      | "reviewer"
      | "designer";
    parentAgent?: string;
    concurrency: number;
    availability: "available" | "offline" | "unavailable" | "saturated";
    active: number;
    completed: number;
    failed: number;
    capabilities: readonly Capability[];
    currentTasks: readonly string[];
    placements: readonly WorkforcePlacement[];
  }
>;
export type CapabilityCoverage = DeepReadonly<
  Sourced & {
    capability: Capability;
    covered: boolean;
    agents: readonly string[];
    placements: number;
  }
>;
export type ProjectWorkforce = DeepReadonly<{
  project: ProjectId;
  observedAt: string;
  taskCounts: Readonly<Record<WorkforceTask["status"] | "all", number>>;
  agentCounts: Readonly<{
    logical: number;
    connected: number;
    available: number;
    activeDispatches: number;
  }>;
  tasks: readonly WorkforceTask[];
  agents: readonly WorkforceAgent[];
  coverage: readonly CapabilityCoverage[];
  threads: Readonly<{ available: false }>;
}>;
export type ProjectWorkforceSource = Readonly<{
  project: ProjectId;
  observedAt: string;
  history: readonly unknown[];
  livePlacements: readonly LivePlacement[];
}>;

export class ProjectWorkforceError extends Error {
  readonly code:
    | "INVALID_OBSERVATION"
    | "INVALID_HISTORY"
    | "MIXED_PROJECT"
    | "SEQUENCE_GAP"
    | "DUPLICATE_EVENT"
    | "MISSING_PROJECT"
    | "INVALID_LIVE_STATE";

  constructor(
    code: ProjectWorkforceError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectWorkforceError";
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

function parseHistory(source: ProjectWorkforceSource): readonly StoredEvent[] {
  const seen = new Set<string>();
  const history = source.history.map((value, index) => {
    let event: StoredEvent;
    try {
      event = parseStoredEvent(value);
    } catch (cause) {
      throw new ProjectWorkforceError("INVALID_HISTORY", `history[${index}] is invalid`, {
        cause,
      });
    }
    if (event.project !== source.project) {
      throw new ProjectWorkforceError(
        "MIXED_PROJECT",
        `history[${index}] belongs to ${event.project}`,
      );
    }
    if (Number(event.seq) !== index + 1) {
      throw new ProjectWorkforceError(
        "SEQUENCE_GAP",
        `history[${index}] must have seq ${index + 1}`,
      );
    }
    if (seen.has(event.id)) {
      throw new ProjectWorkforceError(
        "DUPLICATE_EVENT",
        `event ${event.id} appears more than once`,
      );
    }
    seen.add(event.id);
    return event;
  });
  if (history[0]?.type !== "project.created") {
    throw new ProjectWorkforceError(
      "MISSING_PROJECT",
      "workforce history must start with project.created",
    );
  }
  return history;
}

function assignmentOf(
  task: TaskState,
  tasks: TaskProjectState,
  catalog: AgentCatalogState,
  live: readonly LivePlacement[],
): WorkforceTaskAssignment {
  if (task.executor !== undefined) {
    return { kind: "assigned", executor: task.executor };
  }
  if (task.status !== "created") return { kind: "not-applicable" };
  const unmet = unmetDependencies(tasks, task.id);
  if (unmet.length > 0) return { kind: "waiting-dependency", tasks: [...unmet] };
  const route = selectAgentPlacement(catalog, tasks, live, task.requires);
  if (route.matched) {
    return {
      kind: "awaiting-assignment",
      candidate: { agent: route.candidate.agent, host: route.candidate.host },
    };
  }
  return {
    kind: route.reason,
    requiredCapabilities: [...route.requiredCapabilities],
  };
}

export function buildProjectWorkforce(source: ProjectWorkforceSource): ProjectWorkforce {
  const observation = rfc3339Schema.safeParse(source.observedAt);
  if (!observation.success) {
    throw new ProjectWorkforceError("INVALID_OBSERVATION", "observedAt must be RFC3339");
  }
  const history = parseHistory(source);
  const lastEvent = history.at(-1);
  if (
    lastEvent !== undefined &&
    Date.parse(lastEvent.at) > Date.parse(observation.data)
  ) {
    throw new ProjectWorkforceError(
      "INVALID_OBSERVATION",
      "observedAt cannot precede the latest event",
    );
  }
  let tasks: TaskProjectState = { tasks: {} };
  let catalog: AgentCatalogState = { placements: {} };
  let projectState: "active" | "paused" | "archived" | "completed" = "active";
  const latestTaskEvent = new Map<string, StoredEvent>();
  const latestPlacementEvent = new Map<string, StoredEvent>();
  try {
    for (const [index, event] of history.entries()) {
      if (index > 0 && event.type === "project.created") {
        throw new ProjectWorkforceError(
          "INVALID_HISTORY",
          "workforce history contains duplicate project.created",
        );
      }
      if (event.type === "project.state.changed") {
        if (event.payload.from !== projectState) {
          throw new ProjectWorkforceError(
            "INVALID_HISTORY",
            `project state expected ${projectState}, received ${event.payload.from}`,
          );
        }
        projectState = event.payload.to;
      }
      tasks = reduceTaskProject(tasks, event);
      catalog = reduceAgentCatalog(catalog, event);
      if (event.type.startsWith("task.")) latestTaskEvent.set(event.subject.id, event);
      if (
        event.type === "agent.registered" ||
        event.type === "agent.status.changed" ||
        event.type === "agent.disconnected"
      ) {
        latestPlacementEvent.set(
          agentPlacementKey(event.subject.id, event.payload.host),
          event,
        );
      }
    }
    rankAgentPlacements(catalog, tasks, source.livePlacements, []);
  } catch (cause) {
    throw new ProjectWorkforceError(
      cause instanceof Error && cause.name === "AgentRoutingInputError"
        ? "INVALID_LIVE_STATE"
        : "INVALID_HISTORY",
      "workforce input failed projection or live-state validation",
      { cause },
    );
  }

  const taskViews: WorkforceTask[] = Object.values(tasks.tasks).map((task) => {
    const event = latestTaskEvent.get(task.id);
    return {
      task: task.id,
      title: task.title,
      goal: task.goal,
      status: task.status,
      progress: task.progress,
      priority: task.priority,
      owner: task.owner,
      ...(task.executor === undefined ? {} : { executor: task.executor }),
      requires: [...task.requires],
      dependsOn: [...task.dependsOn],
      outputs: [...task.outputs],
      assignment: assignmentOf(task, tasks, catalog, source.livePlacements),
      awaitingHumanReview: task.status === "review",
      ...(task.blocker === undefined ? {} : { blocker: { ...task.blocker } }),
      createdAt: task.createdAt,
      changedAt: event?.at ?? task.createdAt,
      sourceEvents: event === undefined ? [] : [event.id],
    };
  });
  taskViews.sort(
    (left, right) =>
      STATUS_RANK[right.status] - STATUS_RANK[left.status] ||
      PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority] ||
      right.changedAt.localeCompare(left.changedAt) ||
      left.task.localeCompare(right.task),
  );

  const liveByKey = new Map(
    source.livePlacements.map((item) => [agentPlacementKey(item.agent, item.host), item]),
  );
  const placementsByAgent = new Map<
    string,
    Array<[string, AgentCatalogState["placements"][string]]>
  >();
  for (const entry of Object.entries(catalog.placements)) {
    const list = placementsByAgent.get(entry[1].agent) ?? [];
    list.push(entry);
    placementsByAgent.set(entry[1].agent, list);
  }
  const agentViews: WorkforceAgent[] = [];
  for (const [agent, entries] of placementsByAgent) {
    const first = entries[0]?.[1];
    if (first === undefined) continue;
    const placementViews: WorkforcePlacement[] = entries
      .sort(([, left], [, right]) => left.host.localeCompare(right.host))
      .map(([key, placement]) => {
        const live = liveByKey.get(key);
        const event = latestPlacementEvent.get(key);
        return {
          host: placement.host,
          capabilities: [...placement.capabilities],
          declaredStatus: placement.status,
          integration: { ...placement.integration },
          connected: live !== undefined,
          accepting: live?.accepting ?? false,
          active: live?.active ?? 0,
          sourceEvents: event === undefined ? [] : [event.id],
        };
      });
    const active = placementViews.reduce(
      (total, placement) => total + placement.active,
      0,
    );
    const connected = placementViews.filter((placement) => placement.connected);
    const accepting = connected.filter((placement) => placement.accepting);
    const availability =
      connected.length === 0
        ? "offline"
        : accepting.length === 0
          ? "unavailable"
          : active >= first.concurrency
            ? "saturated"
            : "available";
    const outcomes = Object.values(tasks.tasks).filter(
      (task) =>
        task.executor === agent &&
        (task.status === "completed" || task.status === "failed"),
    );
    const currentTasks = Object.values(tasks.tasks)
      .filter((task) => task.executor === agent && ACTIVE_TASKS.has(task.status))
      .map((task) => task.id)
      .sort();
    const capabilities = [
      ...new Set(entries.flatMap(([, item]) => item.capabilities)),
    ].sort((left, right) => CAPABILITIES.indexOf(left) - CAPABILITIES.indexOf(right));
    agentViews.push({
      agent,
      name: first.name,
      provider: first.provider,
      role: first.role,
      ...(first.parentAgent === undefined ? {} : { parentAgent: first.parentAgent }),
      concurrency: first.concurrency,
      availability,
      active,
      completed: outcomes.filter((task) => task.status === "completed").length,
      failed: outcomes.filter((task) => task.status === "failed").length,
      capabilities,
      currentTasks,
      placements: placementViews,
      sourceEvents: placementViews.flatMap((placement) => placement.sourceEvents),
    });
  }
  agentViews.sort(
    (left, right) =>
      Number(right.availability === "available") -
        Number(left.availability === "available") ||
      right.active - left.active ||
      left.name.localeCompare(right.name) ||
      left.agent.localeCompare(right.agent),
  );

  const coverage: CapabilityCoverage[] = CAPABILITIES.map((capability) => {
    const matching = agentViews.filter((agent) =>
      agent.placements.some(
        (placement) =>
          placement.connected &&
          placement.accepting &&
          placement.capabilities.includes(capability),
      ),
    );
    const placements = matching.flatMap((agent) =>
      agent.placements.filter(
        (placement) =>
          placement.connected &&
          placement.accepting &&
          placement.capabilities.includes(capability),
      ),
    );
    return {
      capability,
      covered: matching.length > 0,
      agents: matching.map((agent) => agent.agent),
      placements: placements.length,
      sourceEvents: placements.flatMap((placement) => placement.sourceEvents),
    };
  });
  const statuses = [
    "created",
    "assigned",
    "running",
    "blocked",
    "review",
    "completed",
    "failed",
    "cancelled",
  ] as const;
  const taskCounts = Object.fromEntries([
    ["all", taskViews.length],
    ...statuses.map((status) => [
      status,
      taskViews.filter((task) => task.status === status).length,
    ]),
  ]) as ProjectWorkforce["taskCounts"];
  return freeze({
    project: source.project,
    observedAt: observation.data,
    taskCounts,
    agentCounts: {
      logical: agentViews.length,
      connected: agentViews.filter((agent) =>
        agent.placements.some((placement) => placement.connected),
      ).length,
      available: agentViews.filter((agent) => agent.availability === "available").length,
      activeDispatches: source.livePlacements.reduce(
        (total, placement) => total + placement.active,
        0,
      ),
    },
    tasks: taskViews,
    agents: agentViews,
    coverage,
    threads: { available: false },
  });
}
