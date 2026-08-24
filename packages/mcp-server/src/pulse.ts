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

const ACTIVE_TASK_STATUSES = new Set(["assigned", "running", "blocked", "review"]);
const BLOCKER_HOURS = Object.freeze({ critical: 0, high: 24, medium: 72, low: 168 });
const SEVERITY_RANK = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 });

export type PulseWindow = Readonly<{ startInclusive: string; endExclusive: string }>;
export type PulseMetric = DeepReadonly<{
  value: number;
  sourceEvents: readonly EventId[];
}>;
export type PulseKpis = DeepReadonly<{
  activeAgents: PulseMetric;
  activeTasks: PulseMetric;
  doneToday: PulseMetric;
  blockers: PulseMetric;
}>;
export type PulseProgress = DeepReadonly<{
  task: string;
  title: string;
  progress: number;
  delta: number;
  sourceEvents: readonly EventId[];
}>;
export type PulseActivity = DeepReadonly<{
  event: EventId;
  type: StoredEvent["type"];
  actor: string;
  subject: string;
  at: string;
  sourceEvents: readonly EventId[];
}>;
export type PulseRisk = DeepReadonly<{
  task: string;
  title: string;
  reason: string;
  severity: "low" | "medium" | "high" | "critical";
  needs: "human" | "agent" | "resource";
  since: string;
  ageHours: number;
  overdue: boolean;
  sourceEvents: readonly EventId[];
}>;
export type PulseKnowledge = DeepReadonly<{
  knowledge: string;
  title: string;
  summary: string;
  type:
    | "decision"
    | "research"
    | "technical-note"
    | "task-summary"
    | "milestone"
    | "discussion";
  at: string;
  sourceEvents: readonly EventId[];
}>;
export type PulseMoment = DeepReadonly<{
  metric: string;
  value: number;
  unit: string;
  source: string;
  at: string;
  sourceEvents: readonly EventId[];
}>;
export type PulseConsequence = DeepReadonly<{
  kind: "overdue-blocker" | "milestone" | "architecture-decision" | "progress";
  title: string;
  detail: string;
  score: number;
  actionable: boolean;
  sourceEvents: readonly EventId[];
}>;
export type PulseStory = DeepReadonly<{
  headline: string;
  body: string;
  at: string;
  sourceEvents: readonly EventId[];
}>;
export type ProjectPulse = DeepReadonly<{
  project: ProjectId;
  window: PulseWindow;
  kpis: PulseKpis;
  topConsequence: PulseConsequence | null;
  story: PulseStory | null;
  progress: readonly PulseProgress[];
  activity: readonly PulseActivity[];
  risks: readonly PulseRisk[];
  knowledge: readonly PulseKnowledge[];
  research: readonly PulseKnowledge[];
  moments: readonly PulseMoment[];
}>;
export type ProjectPulseSource = Readonly<{
  project: ProjectId;
  window: PulseWindow;
  history: readonly unknown[];
}>;

export class ProjectPulseError extends Error {
  readonly code:
    | "INVALID_WINDOW"
    | "INVALID_HISTORY"
    | "MIXED_PROJECT"
    | "SEQUENCE_GAP"
    | "DUPLICATE_EVENT"
    | "INVALID_STORY_SOURCE";

  constructor(code: ProjectPulseError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectPulseError";
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

function parseWindow(window: PulseWindow): Readonly<{ start: number; end: number }> {
  const startResult = rfc3339Schema.safeParse(window.startInclusive);
  const endResult = rfc3339Schema.safeParse(window.endExclusive);
  if (!startResult.success || !endResult.success) {
    throw new ProjectPulseError(
      "INVALID_WINDOW",
      "Pulse window must use exact RFC3339 timestamps",
    );
  }
  const start = Date.parse(startResult.data);
  const end = Date.parse(endResult.data);
  if (start >= end) {
    throw new ProjectPulseError(
      "INVALID_WINDOW",
      "Pulse window must be non-empty and increasing",
    );
  }
  return { start, end };
}

function parseHistory(source: ProjectPulseSource): readonly StoredEvent[] {
  const seen = new Set<string>();
  return source.history.map((value, index) => {
    let event: StoredEvent;
    try {
      event = parseStoredEvent(value);
    } catch (cause) {
      throw new ProjectPulseError("INVALID_HISTORY", `history[${index}] is invalid`, {
        cause,
      });
    }
    if (event.project !== source.project) {
      throw new ProjectPulseError(
        "MIXED_PROJECT",
        `history[${index}] belongs to another project`,
      );
    }
    if (Number(event.seq) !== index + 1) {
      throw new ProjectPulseError(
        "SEQUENCE_GAP",
        `history[${index}] must have seq ${index + 1}`,
      );
    }
    if (seen.has(event.id)) {
      throw new ProjectPulseError(
        "DUPLICATE_EVENT",
        `event ${event.id} appears more than once`,
      );
    }
    seen.add(event.id);
    return event;
  });
}

function inWindow(event: StoredEvent, start: number, end: number): boolean {
  const at = Date.parse(event.at);
  return at >= start && at < end;
}

function eventEvidence(events: readonly StoredEvent[]): readonly EventId[] {
  return events.map((event) => event.id);
}

function firstEvidenceSeq(
  byId: ReadonlyMap<EventId, StoredEvent>,
  sourceEvents: readonly EventId[],
): number {
  const id = sourceEvents[0];
  if (id === undefined) {
    throw new ProjectPulseError("INVALID_HISTORY", "sourced Pulse item has no evidence");
  }
  return Number(byId.get(id)?.seq ?? 0);
}

export function buildProjectPulse(source: ProjectPulseSource): ProjectPulse {
  const { start, end } = parseWindow(source.window);
  const history = parseHistory(source);
  const byId = new Map(history.map((event) => [event.id, event]));
  let tasks: TaskProjectState = { tasks: {} };
  let agents: AgentCatalogState = { placements: {} };
  const latestTaskEvent = new Map<string, StoredEvent>();
  const latestAgentEvent = new Map<string, StoredEvent>();
  const blockerEvent = new Map<string, StoredEvent<"task.blocked">>();
  const priorProgress = new Map<string, number>();
  const progress: PulseProgress[] = [];
  const windowEvents = history.filter((event) => inWindow(event, start, end));

  for (const event of history) {
    tasks = reduceTaskProject(tasks, event);
    agents = reduceAgentCatalog(agents, event);
    if (event.type.startsWith("task.")) latestTaskEvent.set(event.subject.id, event);
    if (event.type === "task.blocked") blockerEvent.set(event.subject.id, event);
    if (
      ["task.unblocked", "task.completed", "task.failed", "task.cancelled"].includes(
        event.type,
      )
    ) {
      blockerEvent.delete(event.subject.id);
    }
    if (event.type === "task.progress.updated") {
      const previous = priorProgress.get(event.subject.id) ?? 0;
      const delta = event.payload.progress - previous;
      priorProgress.set(event.subject.id, event.payload.progress);
      if (inWindow(event, start, end) && delta > 0) {
        progress.push({
          task: event.subject.id,
          title: tasks.tasks[event.subject.id]?.title ?? event.subject.id,
          progress: event.payload.progress,
          delta,
          sourceEvents: [event.id],
        });
      }
    }
    if (
      event.type === "agent.registered" ||
      event.type === "agent.status.changed" ||
      event.type === "agent.disconnected"
    ) {
      const host = event.payload.host;
      latestAgentEvent.set(JSON.stringify([event.subject.id, host]), event);
    }
  }

  const activePlacements = Object.entries(agents.placements).filter(
    ([, placement]) => placement.disconnectedAt === undefined,
  );
  const activeTaskStates = Object.values(tasks.tasks).filter((task) =>
    ACTIVE_TASK_STATUSES.has(task.status),
  );
  const completedToday = windowEvents.filter((event) => event.type === "task.completed");
  const risks: PulseRisk[] = [];
  for (const task of Object.values(tasks.tasks)) {
    if (task.status !== "blocked" || task.blocker === undefined) continue;
    const event = blockerEvent.get(task.id);
    if (!event)
      throw new ProjectPulseError(
        "INVALID_HISTORY",
        `blocked task ${task.id} lacks task.blocked evidence`,
      );
    const ageHours = Math.max(0, (end - Date.parse(event.at)) / 3_600_000);
    risks.push({
      task: task.id,
      title: task.title,
      ...task.blocker,
      since: event.at,
      ageHours,
      overdue: ageHours >= BLOCKER_HOURS[task.blocker.severity],
      sourceEvents: [event.id],
    });
  }
  risks.sort(
    (left, right) =>
      Number(right.needs === "human") - Number(left.needs === "human") ||
      SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
      right.ageHours - left.ageHours ||
      left.task.localeCompare(right.task),
  );

  const knowledgeEvents = windowEvents.filter(
    (event): event is StoredEvent<"knowledge.created"> =>
      event.type === "knowledge.created",
  );
  const knowledge = knowledgeEvents.map((event) => ({
    knowledge: event.subject.id,
    title: event.payload.title,
    summary: event.payload.summary,
    type: event.payload.type,
    at: event.at,
    sourceEvents: [event.id],
  }));
  const taskRequiresArchitecture = (taskId: string) =>
    tasks.tasks[taskId]?.requires.includes("architecture") === true;
  const consequences: Array<PulseConsequence & { seq: number }> = [];
  for (const risk of risks.filter((item) => item.overdue)) {
    const seq = firstEvidenceSeq(byId, risk.sourceEvents);
    consequences.push({
      kind: "overdue-blocker",
      title: risk.title,
      detail: risk.reason,
      score: risk.ageHours,
      actionable: risk.needs === "human",
      sourceEvents: risk.sourceEvents,
      seq,
    });
  }
  for (const event of knowledgeEvents) {
    if (event.payload.type === "milestone") {
      consequences.push({
        kind: "milestone",
        title: event.payload.title,
        detail: event.payload.summary,
        score: 0,
        actionable: false,
        sourceEvents: [event.id],
        seq: Number(event.seq),
      });
    } else if (
      event.payload.type === "decision" &&
      event.payload.relatedTasks?.some(taskRequiresArchitecture)
    ) {
      consequences.push({
        kind: "architecture-decision",
        title: event.payload.title,
        detail: event.payload.summary,
        score: 0,
        actionable: false,
        sourceEvents: [event.id],
        seq: Number(event.seq),
      });
    }
  }
  for (const item of progress) {
    const seq = firstEvidenceSeq(byId, item.sourceEvents);
    consequences.push({
      kind: "progress",
      title: item.title,
      detail: `+${item.delta}`,
      score: item.delta,
      actionable: false,
      sourceEvents: item.sourceEvents,
      seq,
    });
  }
  const kindRank = {
    "overdue-blocker": 4,
    milestone: 3,
    "architecture-decision": 2,
    progress: 1,
  } as const;
  consequences.sort(
    (left, right) =>
      kindRank[right.kind] - kindRank[left.kind] ||
      Number(right.actionable) - Number(left.actionable) ||
      right.score - left.score ||
      left.seq - right.seq,
  );
  const top = consequences[0] ?? null;

  const storyEvents = windowEvents.filter(
    (event): event is StoredEvent<"pulse.story.generated"> =>
      event.type === "pulse.story.generated",
  );
  for (const storyEvent of storyEvents) {
    for (const sourceId of storyEvent.payload.sourceEvents) {
      const sourceEvent = byId.get(sourceId);
      if (!sourceEvent || Number(sourceEvent.seq) >= Number(storyEvent.seq)) {
        throw new ProjectPulseError(
          "INVALID_STORY_SOURCE",
          `story ${storyEvent.id} has invalid source ${sourceId}`,
        );
      }
    }
  }
  const storyEvent =
    top === null
      ? undefined
      : [...storyEvents]
          .reverse()
          .find((event) =>
            event.payload.sourceEvents.some((id) => top.sourceEvents.includes(id)),
          );

  const activity = windowEvents
    .filter((event) => event.type.startsWith("agent.") || event.type.startsWith("task."))
    .slice(-6)
    .reverse()
    .map((event) => ({
      event: event.id,
      type: event.type,
      actor: event.actor.id,
      subject: event.subject.id,
      at: event.at,
      sourceEvents: [event.id],
    }));
  const moments = windowEvents
    .filter(
      (event): event is StoredEvent<"measurement.recorded"> =>
        event.type === "measurement.recorded",
    )
    .map((event) => ({ ...event.payload, sourceEvents: [event.id] }));

  return freeze({
    project: source.project,
    window: { ...source.window },
    kpis: {
      activeAgents: {
        value: activePlacements.length,
        sourceEvents: activePlacements
          .map(([key]) => latestAgentEvent.get(key)?.id)
          .filter((id): id is EventId => id !== undefined),
      },
      activeTasks: {
        value: activeTaskStates.length,
        sourceEvents: activeTaskStates
          .map((task) => latestTaskEvent.get(task.id)?.id)
          .filter((id): id is EventId => id !== undefined),
      },
      doneToday: {
        value: completedToday.length,
        sourceEvents: eventEvidence(completedToday),
      },
      blockers: {
        value: risks.length,
        sourceEvents: risks.flatMap((risk) => risk.sourceEvents),
      },
    },
    topConsequence:
      top === null
        ? null
        : {
            kind: top.kind,
            title: top.title,
            detail: top.detail,
            score: top.score,
            actionable: top.actionable,
            sourceEvents: top.sourceEvents,
          },
    story: storyEvent
      ? {
          headline: storyEvent.payload.headline,
          body: storyEvent.payload.body,
          at: storyEvent.at,
          sourceEvents: [...storyEvent.payload.sourceEvents, storyEvent.id],
        }
      : null,
    progress: progress
      .sort((a, b) => b.delta - a.delta || a.task.localeCompare(b.task))
      .slice(0, 6),
    activity,
    risks: risks.slice(0, 6),
    knowledge: knowledge
      .filter((item) => item.type !== "research")
      .slice(-6)
      .reverse(),
    research: knowledge
      .filter((item) => item.type === "research")
      .slice(-6)
      .reverse(),
    moments: moments.slice(-6).reverse(),
  });
}
