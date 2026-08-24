import {
  type DeepReadonly,
  type EventId,
  type ProjectId,
  type StoredEvent,
  parseStoredEvent,
  rfc3339Schema,
} from "@agent-os/event-core";
import {
  type AgentCatalogState,
  type TaskProjectState,
  reduceAgentCatalog,
  reduceTaskProject,
} from "@agent-os/task-engine";

const PROJECT_STATES = ["active", "paused", "archived", "completed"] as const;
const WORK_STATUS_RANK = Object.freeze({
  blocked: 5,
  review: 4,
  running: 3,
  assigned: 2,
  created: 1,
});
const PRIORITY_RANK = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 });
const TERMINAL_TASKS = new Set(["completed", "failed", "cancelled"]);

type ProjectState = (typeof PROJECT_STATES)[number];
type Sourced = Readonly<{ sourceEvents: readonly EventId[] }>;

export type LibraryAgent = DeepReadonly<
  Sourced & {
    id: string;
    name: string;
    status: "idle" | "working" | "waiting" | "blocked";
  }
>;
export type LibrarySnapshot = DeepReadonly<
  Sourced & { label: string; image: string; at: string }
>;
export type LibraryNextStep = DeepReadonly<
  Sourced & { title: string; estimateMinutes: number; detail: string }
>;
export type LibraryKnowledge = DeepReadonly<
  Sourced & {
    knowledge: string;
    type:
      | "decision"
      | "research"
      | "technical-note"
      | "task-summary"
      | "milestone"
      | "discussion";
    title: string;
    summary: string;
    rationale?: string;
    at: string;
  }
>;
export type LibraryFile = DeepReadonly<
  Sourced & { path: string; kind: string; task?: string; at: string }
>;
export type LibraryTimelineItem = DeepReadonly<
  Sourced & {
    event: EventId;
    type: StoredEvent["type"];
    actor: string;
    subject: string;
    at: string;
  }
>;
export type ProjectLibraryItem = DeepReadonly<{
  project: ProjectId;
  name: string;
  state: ProjectState;
  stack: readonly string[];
  progress: number;
  currentWork:
    | (Sourced & {
        task: string;
        title: string;
        status: string;
        priority: "low" | "medium" | "high" | "critical";
      })
    | null;
  health: Sourced & { status: "healthy" | "attention" | "blocked" };
  summary: (Sourced & { text: string }) | null;
  agents: readonly LibraryAgent[];
  lastActivity: Sourced & {
    at: string;
    actor: string;
    type: StoredEvent["type"];
  };
  dormantDays: number;
  snapshots: readonly LibrarySnapshot[];
  nextSteps: readonly LibraryNextStep[];
  timeline: readonly LibraryTimelineItem[];
  knowledge: readonly LibraryKnowledge[];
  files: readonly LibraryFile[];
}>;
export type ProjectLibrary = DeepReadonly<{
  now: string;
  counts: Readonly<{
    all: number;
    active: number;
    paused: number;
    archived: number;
    completed: number;
  }>;
  projects: readonly ProjectLibraryItem[];
  insights: null;
}>;
export type ProjectLibrarySource = Readonly<{
  now: string;
  projects: readonly Readonly<{
    project: ProjectId;
    history: readonly unknown[];
  }>[];
}>;

export class ProjectLibraryError extends Error {
  readonly code:
    | "INVALID_NOW"
    | "DUPLICATE_PROJECT"
    | "INVALID_HISTORY"
    | "MIXED_PROJECT"
    | "SEQUENCE_GAP"
    | "DUPLICATE_EVENT"
    | "MISSING_PROJECT"
    | "STALE_PROJECT_STATE";

  constructor(
    code: ProjectLibraryError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectLibraryError";
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

function parseHistory(
  project: ProjectId,
  history: readonly unknown[],
  globalEvents: Set<string>,
): readonly StoredEvent[] {
  return history.map((value, index) => {
    let event: StoredEvent;
    try {
      event = parseStoredEvent(value);
    } catch (cause) {
      throw new ProjectLibraryError(
        "INVALID_HISTORY",
        `${project} history[${index}] is invalid`,
        { cause },
      );
    }
    if (event.project !== project) {
      throw new ProjectLibraryError(
        "MIXED_PROJECT",
        `${project} history[${index}] belongs to ${event.project}`,
      );
    }
    if (Number(event.seq) !== index + 1) {
      throw new ProjectLibraryError(
        "SEQUENCE_GAP",
        `${project} history[${index}] must have seq ${index + 1}`,
      );
    }
    if (globalEvents.has(event.id)) {
      throw new ProjectLibraryError(
        "DUPLICATE_EVENT",
        `event ${event.id} appears more than once`,
      );
    }
    globalEvents.add(event.id);
    return event;
  });
}

function eventIds(...events: Array<StoredEvent | undefined>): readonly EventId[] {
  return events.flatMap((event) => (event === undefined ? [] : [event.id]));
}

function buildProject(
  project: ProjectId,
  history: readonly StoredEvent[],
  now: number,
): ProjectLibraryItem {
  const created = history[0];
  if (created?.type !== "project.created") {
    throw new ProjectLibraryError(
      "MISSING_PROJECT",
      `${project} history must start with project.created`,
    );
  }

  let state: ProjectState = "active";
  let stateEvent: StoredEvent = created;
  let tasks: TaskProjectState = { tasks: {} };
  let agents: AgentCatalogState = { placements: {} };
  let summaryEvent: StoredEvent<"pulse.story.generated"> | undefined;
  let revivalEvent: StoredEvent<"project.revived"> | undefined;
  const latestTaskEvent = new Map<string, StoredEvent>();
  const latestAgentEvent = new Map<string, StoredEvent>();
  const snapshots: LibrarySnapshot[] = [];
  const knowledge: LibraryKnowledge[] = [];
  const files: LibraryFile[] = [];

  try {
    for (const event of history) {
      if (event !== created && event.type === "project.created") {
        throw new ProjectLibraryError(
          "INVALID_HISTORY",
          `${project} has more than one project.created event`,
        );
      }
      if (event.type === "project.state.changed") {
        if (event.payload.from !== state) {
          throw new ProjectLibraryError(
            "STALE_PROJECT_STATE",
            `${project} expected state ${state}, received ${event.payload.from}`,
          );
        }
        state = event.payload.to;
        stateEvent = event;
      }
      tasks = reduceTaskProject(tasks, event);
      agents = reduceAgentCatalog(agents, event);
      if (event.type.startsWith("task.")) latestTaskEvent.set(event.subject.id, event);
      if (
        event.type === "agent.registered" ||
        event.type === "agent.status.changed" ||
        event.type === "agent.disconnected"
      ) {
        latestAgentEvent.set(
          JSON.stringify([event.subject.id, event.payload.host]),
          event,
        );
      }
      if (event.type === "project.snapshot.captured") {
        snapshots.push({ ...event.payload, sourceEvents: [event.id] });
      } else if (event.type === "pulse.story.generated") {
        summaryEvent = event;
      } else if (event.type === "project.revived") {
        revivalEvent = event;
      } else if (event.type === "knowledge.created") {
        knowledge.push({
          knowledge: event.subject.id,
          type: event.payload.type,
          title: event.payload.title,
          summary: event.payload.summary,
          ...(event.payload.rationale === undefined
            ? {}
            : { rationale: event.payload.rationale }),
          at: event.at,
          sourceEvents: [event.id, ...event.payload.sourceEvents],
        });
      } else if (event.type === "artifact.produced") {
        files.push({
          path: event.payload.path,
          kind: event.payload.kind,
          task: event.payload.task,
          at: event.at,
          sourceEvents: [event.id],
        });
      } else if (event.type === "artifact.derived") {
        files.push({
          path: event.payload.path,
          kind: event.payload.lens,
          at: event.at,
          sourceEvents: [event.id],
        });
      }
    }
  } catch (error) {
    if (error instanceof ProjectLibraryError) throw error;
    throw new ProjectLibraryError(
      "INVALID_HISTORY",
      `${project} projection rejected its history`,
      { cause: error },
    );
  }

  const taskStates = Object.values(tasks.tasks);
  const progress =
    taskStates.length === 0
      ? 0
      : Math.round(
          taskStates.reduce((total, task) => total + task.progress, 0) /
            taskStates.length,
        );
  const currentTask = taskStates
    .filter((task) => !TERMINAL_TASKS.has(task.status))
    .sort(
      (left, right) =>
        (WORK_STATUS_RANK[right.status as keyof typeof WORK_STATUS_RANK] ?? 0) -
          (WORK_STATUS_RANK[left.status as keyof typeof WORK_STATUS_RANK] ?? 0) ||
        PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority] ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )[0];
  const blockedEvents = taskStates
    .filter((task) => task.status === "blocked")
    .map((task) => latestTaskEvent.get(task.id));
  const attentionEvents = taskStates
    .filter((task) => task.status === "failed" || task.status === "review")
    .map((task) => latestTaskEvent.get(task.id));
  const health =
    blockedEvents.length > 0
      ? { status: "blocked" as const, sourceEvents: eventIds(...blockedEvents) }
      : attentionEvents.length > 0
        ? { status: "attention" as const, sourceEvents: eventIds(...attentionEvents) }
        : { status: "healthy" as const, sourceEvents: eventIds(stateEvent) };

  const connected = Object.entries(agents.placements)
    .filter(([, placement]) => placement.disconnectedAt === undefined)
    .sort(([, left], [, right]) => right.changedAt.localeCompare(left.changedAt));
  const seenAgents = new Set<string>();
  const libraryAgents: LibraryAgent[] = [];
  for (const [key, placement] of connected) {
    if (seenAgents.has(placement.agent)) continue;
    seenAgents.add(placement.agent);
    libraryAgents.push({
      id: placement.agent,
      name: placement.name,
      status: placement.status,
      sourceEvents: eventIds(latestAgentEvent.get(key)),
    });
  }

  const last = history.at(-1) ?? created;
  const inactivity = Math.max(0, now - Date.parse(last.at));
  return freeze({
    project,
    name: created.payload.name,
    state,
    stack: [...created.payload.stack],
    progress,
    currentWork:
      currentTask === undefined
        ? null
        : {
            task: currentTask.id,
            title: currentTask.title,
            status: currentTask.status,
            priority: currentTask.priority,
            sourceEvents: eventIds(latestTaskEvent.get(currentTask.id)),
          },
    health,
    summary:
      summaryEvent === undefined
        ? null
        : {
            text: summaryEvent.payload.headline,
            sourceEvents: [summaryEvent.id, ...summaryEvent.payload.sourceEvents],
          },
    agents: libraryAgents,
    lastActivity: {
      at: last.at,
      actor: last.actor.id,
      type: last.type,
      sourceEvents: [last.id],
    },
    dormantDays: Math.floor(inactivity / 86_400_000),
    snapshots: snapshots.reverse(),
    nextSteps:
      revivalEvent?.payload.plan.map((step) => ({
        ...step,
        sourceEvents: [revivalEvent.id],
      })) ?? [],
    timeline: history
      .slice(-50)
      .reverse()
      .map((event) => ({
        event: event.id,
        type: event.type,
        actor: event.actor.id,
        subject: event.subject.id,
        at: event.at,
        sourceEvents: [event.id],
      })),
    knowledge: knowledge.reverse(),
    files: files.reverse(),
  });
}

export function buildProjectLibrary(source: ProjectLibrarySource): ProjectLibrary {
  const parsedNow = rfc3339Schema.safeParse(source.now);
  if (!parsedNow.success) {
    throw new ProjectLibraryError("INVALID_NOW", "Library now must be RFC3339");
  }
  const now = Date.parse(parsedNow.data);
  const projectIds = new Set<string>();
  const globalEvents = new Set<string>();
  const projects = source.projects.map((entry) => {
    if (projectIds.has(entry.project)) {
      throw new ProjectLibraryError(
        "DUPLICATE_PROJECT",
        `project ${entry.project} appears more than once`,
      );
    }
    projectIds.add(entry.project);
    return buildProject(
      entry.project,
      parseHistory(entry.project, entry.history, globalEvents),
      now,
    );
  });
  projects.sort(
    (left, right) =>
      right.lastActivity.at.localeCompare(left.lastActivity.at) ||
      left.name.localeCompare(right.name) ||
      left.project.localeCompare(right.project),
  );
  const counts = {
    all: projects.length,
    active: projects.filter((item) => item.state === "active").length,
    paused: projects.filter((item) => item.state === "paused").length,
    archived: projects.filter((item) => item.state === "archived").length,
    completed: projects.filter((item) => item.state === "completed").length,
  };
  return freeze({ now: parsedNow.data, counts, projects, insights: null });
}
