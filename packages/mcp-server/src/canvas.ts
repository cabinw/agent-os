import {
  type DeepReadonly,
  type EventId,
  type EventType,
  type ProjectId,
  type StoredEvent,
  parseStoredEvent,
  projectIdSchema,
} from "@agent-os/event-core";
import { buildMemoryGraph } from "@agent-os/memory-core";
import { reduceAgentCatalog, reduceTaskProject } from "@agent-os/task-engine";
import type {
  AgentCatalogState,
  AgentPlacementState,
  TaskProjectState,
} from "@agent-os/task-engine";

type Sourced = Readonly<{ sourceEvents: readonly EventId[] }>;
export type CanvasNodeKind =
  | "project"
  | "goal"
  | "task"
  | "agent"
  | "resource"
  | "knowledge";

export type CanvasNode = DeepReadonly<
  Sourced & {
    id: string;
    project: ProjectId;
    kind: CanvasNodeKind;
    label: string;
    status?: string;
    progress?: number;
    executor?: string;
    dependsOn?: readonly string[];
    completed: boolean;
  }
>;

export type CanvasEdge = DeepReadonly<
  Sourced & {
    from: string;
    to: string;
    relation: "causedBy";
    event: EventId;
    eventType: EventType;
  }
>;

export type CanvasProject = DeepReadonly<
  Sourced & {
    project: ProjectId;
    name: string;
    progress: number;
    health: "healthy" | "attention" | "blocked";
    nodes: readonly CanvasNode[];
    edges: readonly CanvasEdge[];
  }
>;

export type ProjectCanvas = DeepReadonly<{
  projects: readonly CanvasProject[];
}>;

export type ProjectCanvasSource = Readonly<{
  projects: readonly Readonly<{
    project: ProjectId;
    history: readonly unknown[];
  }>[];
}>;

export class ProjectCanvasError extends Error {
  readonly code:
    | "DUPLICATE_EVENT"
    | "DUPLICATE_PROJECT"
    | "INVALID_HISTORY"
    | "INVALID_SOURCE"
    | "MISSING_PROJECT";

  constructor(code: ProjectCanvasError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectCanvasError";
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

function nodeId(kind: CanvasNodeKind, id: string): string {
  return `${kind}:${id}`;
}

function sourceIds(
  history: readonly StoredEvent[],
  predicate: (event: StoredEvent) => boolean,
) {
  return history.filter(predicate).map((event) => event.id);
}

function eventNode(event: StoredEvent, approvals: ReadonlyMap<string, string>): string {
  if (event.type.startsWith("task.")) return nodeId("task", event.subject.id);
  if (event.type.startsWith("agent.")) return nodeId("agent", event.subject.id);
  if (event.type.startsWith("knowledge.")) return nodeId("knowledge", event.subject.id);
  if (event.type.startsWith("artifact.")) return nodeId("resource", event.subject.id);
  if (event.type === "message.sent") {
    return event.payload.task === undefined
      ? nodeId("project", event.project)
      : nodeId("task", event.payload.task);
  }
  if (event.type.startsWith("approval.")) {
    return approvals.get(event.subject.id) ?? nodeId("project", event.project);
  }
  return nodeId("project", event.project);
}

function buildCanvasProject(
  project: ProjectId,
  rawHistory: readonly unknown[],
  globalEvents: Set<string>,
): CanvasProject {
  let history: readonly StoredEvent[];
  try {
    history = rawHistory.map((raw) => parseStoredEvent(raw));
    buildMemoryGraph({ project, history });
  } catch (cause) {
    throw new ProjectCanvasError(
      "INVALID_HISTORY",
      `canvas history for ${project} is invalid`,
      { cause },
    );
  }
  const created = history[0];
  if (created?.type !== "project.created") {
    throw new ProjectCanvasError(
      "MISSING_PROJECT",
      `${project} canvas history must start with project.created`,
    );
  }
  if (history.slice(1).some((event) => event.type === "project.created")) {
    throw new ProjectCanvasError(
      "INVALID_HISTORY",
      `${project} canvas history contains more than one project.created event`,
    );
  }
  for (const event of history) {
    if (globalEvents.has(event.id)) {
      throw new ProjectCanvasError(
        "DUPLICATE_EVENT",
        `canvas event ${event.id} appears in multiple histories`,
      );
    }
    globalEvents.add(event.id);
  }

  let tasks: TaskProjectState = { tasks: {} };
  let agents: AgentCatalogState = { placements: {} };
  try {
    for (const event of history) {
      tasks = reduceTaskProject(tasks, event);
      agents = reduceAgentCatalog(agents, event);
    }
  } catch (cause) {
    throw new ProjectCanvasError(
      "INVALID_HISTORY",
      `canvas domain projection for ${project} is invalid`,
      { cause },
    );
  }

  const nodes: CanvasNode[] = [
    {
      id: nodeId("project", project),
      project,
      kind: "project",
      label: created.payload.name,
      completed: false,
      sourceEvents: [created.id],
    },
  ];
  const goalIds = new Set<string>();
  for (const task of Object.values(tasks.tasks).sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (!goalIds.has(task.goal)) {
      goalIds.add(task.goal);
      nodes.push({
        id: nodeId("goal", task.goal),
        project,
        kind: "goal",
        label: task.goal,
        completed: false,
        sourceEvents: sourceIds(
          history,
          (event) => event.type === "task.created" && event.payload.goal === task.goal,
        ),
      });
    }
    nodes.push({
      id: nodeId("task", task.id),
      project,
      kind: "task",
      label: task.title,
      status: task.status,
      progress: task.progress,
      ...(task.executor === undefined ? {} : { executor: task.executor }),
      dependsOn: task.dependsOn.map((dependency) => nodeId("task", dependency)),
      completed: task.status === "completed",
      sourceEvents: sourceIds(
        history,
        (event) => event.type.startsWith("task.") && event.subject.id === task.id,
      ),
    });
  }
  const latestPlacements = new Map<string, AgentPlacementState>();
  for (const placement of Object.values(agents.placements)) {
    const current = latestPlacements.get(placement.agent);
    if (current === undefined || placement.changedAt > current.changedAt) {
      latestPlacements.set(placement.agent, placement);
    }
  }
  for (const placement of [...latestPlacements.values()].sort((a, b) =>
    a.agent.localeCompare(b.agent),
  )) {
    nodes.push({
      id: nodeId("agent", placement.agent),
      project,
      kind: "agent",
      label: placement.name,
      status: placement.disconnectedAt === undefined ? placement.status : "disconnected",
      completed: false,
      sourceEvents: sourceIds(
        history,
        (event) =>
          event.type.startsWith("agent.") && event.subject.id === placement.agent,
      ),
    });
  }
  for (const event of history) {
    if (event.type === "artifact.produced" || event.type === "artifact.derived") {
      nodes.push({
        id: nodeId("resource", event.subject.id),
        project,
        kind: "resource",
        label: event.payload.path,
        completed: false,
        sourceEvents: [event.id],
      });
    } else if (event.type === "knowledge.created") {
      nodes.push({
        id: nodeId("knowledge", event.subject.id),
        project,
        kind: "knowledge",
        label: event.payload.title,
        status: event.payload.type,
        completed: false,
        sourceEvents: [event.id, ...event.payload.sourceEvents],
      });
    }
  }

  const approvals = new Map<string, string>();
  const eventNodes = new Map<EventId, string>();
  for (const event of history) {
    if (event.type === "approval.requested") {
      approvals.set(
        event.subject.id,
        event.payload.task === undefined
          ? nodeId("project", project)
          : nodeId("task", event.payload.task),
      );
    }
    eventNodes.set(event.id, eventNode(event, approvals));
  }
  const edges: CanvasEdge[] = [];
  for (const event of history) {
    if (event.causedBy === undefined) continue;
    const from = eventNodes.get(event.id);
    const to = eventNodes.get(event.causedBy);
    if (from === undefined || to === undefined) continue;
    edges.push({
      from,
      to,
      relation: "causedBy",
      event: event.id,
      eventType: event.type,
      sourceEvents: [event.id, event.causedBy],
    });
  }
  const taskValues = Object.values(tasks.tasks);
  const progress =
    taskValues.length === 0
      ? 0
      : Math.round(
          taskValues.reduce((sum, task) => sum + task.progress, 0) / taskValues.length,
        );
  const health = taskValues.some((task) => task.status === "blocked")
    ? "blocked"
    : taskValues.some((task) => task.status === "failed" || task.status === "review")
      ? "attention"
      : "healthy";
  return freeze({
    project,
    name: created.payload.name,
    progress,
    health,
    nodes,
    edges,
    sourceEvents: history.map((event) => event.id),
  });
}

export function buildProjectCanvas(source: ProjectCanvasSource): ProjectCanvas {
  if (source === null || typeof source !== "object" || !Array.isArray(source.projects)) {
    throw new ProjectCanvasError("INVALID_SOURCE", "canvas projects are required");
  }
  const projects = new Set<string>();
  const globalEvents = new Set<string>();
  const built = source.projects.map((entry) => {
    const project = projectIdSchema.safeParse(entry?.project);
    if (!project.success || !Array.isArray(entry?.history)) {
      throw new ProjectCanvasError("INVALID_SOURCE", "canvas project source is invalid");
    }
    if (projects.has(project.data)) {
      throw new ProjectCanvasError(
        "DUPLICATE_PROJECT",
        `canvas project ${project.data} appears more than once`,
      );
    }
    projects.add(project.data);
    return buildCanvasProject(project.data, entry.history, globalEvents);
  });
  built.sort((left, right) => left.name.localeCompare(right.name));
  return freeze({ projects: built });
}
