import { beforeEach, describe, expect, it } from "vitest";
import { newEventId, parseStoredEvent } from "../packages/event-core/src/index.js";
import type {
  EventPayload,
  EventType,
  StoredEvent,
  Subject,
} from "../packages/event-core/src/index.js";
import {
  type ProjectPulseError,
  buildProjectPulse,
} from "../packages/mcp-server/src/index.js";

const PROJECT = "proj_pulse";
const WINDOW = {
  startInclusive: "2026-08-24T00:00:00Z",
  endExclusive: "2026-08-25T00:00:00Z",
} as const;
const INTEGRATION = {
  participates: true,
  streaming: true,
  reasoning: true,
  session: true,
  usage: true,
} as const;

let sequence = 0;
let history: StoredEvent[] = [];

function subject(kind: Subject["kind"], id: string): Subject {
  return { kind, id } as Subject;
}

function add<Type extends EventType>(
  type: Type,
  target: Subject,
  payload: EventPayload<Type>,
  at = "2026-08-24T12:00:00Z",
  project = PROJECT,
): StoredEvent<Type> {
  sequence += 1;
  const event = parseStoredEvent({
    schemaVersion: 1,
    id: newEventId(),
    seq: sequence,
    type,
    project,
    actor: { kind: "system", id: "pulse-runtime" },
    subject: target,
    at,
    payload,
  }) as StoredEvent<Type>;
  history.push(event);
  return event;
}

function register(agent = "agent-pulse", host = "host-mac") {
  return add(
    "agent.registered",
    subject("agent", agent),
    {
      id: agent,
      name: "Pulse Agent",
      provider: "local",
      role: "developer",
      concurrency: 1,
      host,
      capabilities: ["architecture", "coding"],
      integration: INTEGRATION,
    },
    "2026-08-23T20:00:00Z",
  );
}

function createTask(
  id: string,
  requires: EventPayload<"task.created">["requires"] = ["coding"],
  at = "2026-08-23T20:10:00Z",
) {
  return add(
    "task.created",
    subject("task", id),
    {
      title: `Deliver ${id}`,
      goal: "goal-pulse",
      requires: [...requires],
      priority: "high",
      dependsOn: [],
      requiresApproval: false,
    },
    at,
  );
}

function startTask(id: string, agent = "agent-pulse") {
  add(
    "task.assigned",
    subject("task", id),
    { executor: agent, matchedBy: "capability" },
    "2026-08-23T20:20:00Z",
  );
  return add(
    "task.started",
    subject("task", id),
    { executor: agent },
    "2026-08-23T20:30:00Z",
  );
}

function pulse() {
  return buildProjectPulse({ project: PROJECT as never, window: WINDOW, history });
}

beforeEach(() => {
  sequence = 0;
  history = [];
});

describe("RM-3.3 · sourced Project Pulse", () => {
  it("returns an honest deeply frozen empty read model", () => {
    const result = pulse();

    expect(result.kpis).toEqual({
      activeAgents: { value: 0, sourceEvents: [] },
      activeTasks: { value: 0, sourceEvents: [] },
      doneToday: { value: 0, sourceEvents: [] },
      blockers: { value: 0, sourceEvents: [] },
    });
    expect(result.topConsequence).toBeNull();
    expect(result.story).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.kpis.activeAgents.sourceEvents)).toBe(true);
  });

  it("derives all KPIs and six cards with event evidence", () => {
    const registration = register();
    createTask("TASK-001", ["architecture"]);
    startTask("TASK-001");
    const progress = add(
      "task.progress.updated",
      subject("task", "TASK-001"),
      { progress: 40, note: "Architecture drafted" },
      "2026-08-24T08:00:00Z",
    );
    createTask("TASK-002");
    startTask("TASK-002");
    const blocker = add(
      "task.blocked",
      subject("task", "TASK-002"),
      { reason: "Owner must choose", severity: "critical", needs: "human" },
      "2026-08-24T09:00:00Z",
    );
    const milestone = add(
      "knowledge.created",
      subject("knowledge", "KN-MILESTONE"),
      {
        type: "milestone",
        title: "Runtime boots",
        summary: "The local runtime reached its first boot.",
        sourceEvents: [progress.id],
      },
      "2026-08-24T10:00:00Z",
    );
    add(
      "knowledge.created",
      subject("knowledge", "KN-RESEARCH"),
      {
        type: "research",
        title: "Latency study",
        summary: "Local dispatch stays under budget.",
        sourceEvents: [progress.id],
      },
      "2026-08-24T10:10:00Z",
    );
    add(
      "measurement.recorded",
      subject("measurement", "MEASURE-LATENCY"),
      {
        metric: "dispatch-latency",
        value: 18,
        unit: "ms",
        source: "benchmark",
        at: "2026-08-24T10:20:00Z",
      },
      "2026-08-24T10:20:00Z",
    );
    const story = add(
      "pulse.story.generated",
      subject("pulse", "PULSE-STORY"),
      {
        headline: "Owner decision is blocking delivery",
        body: "Resolve the choice before the critical path can continue.",
        sourceEvents: [blocker.id],
      },
      "2026-08-24T11:00:00Z",
    );

    const result = pulse();

    expect(result.kpis.activeAgents).toEqual({
      value: 1,
      sourceEvents: [registration.id],
    });
    expect(result.kpis.activeTasks.value).toBe(2);
    expect(result.kpis.blockers).toEqual({ value: 1, sourceEvents: [blocker.id] });
    expect(result.topConsequence).toMatchObject({
      kind: "overdue-blocker",
      actionable: true,
      sourceEvents: [blocker.id],
    });
    expect(result.story?.sourceEvents).toEqual([blocker.id, story.id]);
    expect(result.progress[0]?.sourceEvents).toEqual([progress.id]);
    expect(result.activity.length).toBeGreaterThan(0);
    expect(result.risks[0]?.sourceEvents).toEqual([blocker.id]);
    expect(result.knowledge[0]?.sourceEvents).toEqual([milestone.id]);
    expect(result.research).toHaveLength(1);
    expect(result.moments).toHaveLength(1);
  });

  it("ranks overdue blocker, milestone, architecture decision, then progress", () => {
    createTask("TASK-001", ["architecture"]);
    startTask("TASK-001");
    const progress = add(
      "task.progress.updated",
      subject("task", "TASK-001"),
      { progress: 90 },
      "2026-08-24T08:00:00Z",
    );
    add(
      "knowledge.created",
      subject("knowledge", "KN-DECISION"),
      {
        type: "decision",
        title: "Use one event ingress",
        summary: "MCP remains the only external ingress.",
        sourceEvents: [progress.id],
        rationale: "One protocol prevents drift.",
        relatedTasks: ["TASK-001"],
      },
      "2026-08-24T09:00:00Z",
    );
    const milestone = add(
      "knowledge.created",
      subject("knowledge", "KN-MILESTONE"),
      {
        type: "milestone",
        title: "Shell accepted",
        summary: "The desktop shell passed review.",
        sourceEvents: [progress.id],
      },
      "2026-08-24T10:00:00Z",
    );

    expect(pulse().topConsequence).toMatchObject({
      kind: "milestone",
      sourceEvents: [milestone.id],
    });
  });

  it("does not infer architecture decisions from prose", () => {
    createTask("TASK-003", ["coding"]);
    startTask("TASK-003");
    const progress = add(
      "task.progress.updated",
      subject("task", "TASK-003"),
      { progress: 20 },
      "2026-08-24T08:00:00Z",
    );
    add(
      "knowledge.created",
      subject("knowledge", "KN-DECISION"),
      {
        type: "decision",
        title: "Architecture choice",
        summary: "Architecture wording alone is not a capability link.",
        sourceEvents: [progress.id],
        rationale: "Avoid text inference.",
        relatedTasks: ["TASK-003"],
      },
      "2026-08-24T09:00:00Z",
    );

    expect(pulse().topConsequence?.kind).toBe("progress");
  });

  it.each([
    ["critical", "2026-08-24T23:59:59Z", true],
    ["high", "2026-08-24T00:00:01Z", false],
    ["high", "2026-08-24T00:00:00Z", true],
  ] as const)(
    "applies the %s blocker threshold at the exact boundary",
    (severity, blockedAt, overdue) => {
      createTask("TASK-002");
      startTask("TASK-002");
      add(
        "task.blocked",
        subject("task", "TASK-002"),
        { reason: "Waiting", severity, needs: "resource" },
        blockedAt,
      );

      expect(pulse().risks[0]?.overdue).toBe(overdue);
    },
  );

  it("uses a half-open day window while retaining current blockers from before it", () => {
    createTask("TASK-002", ["coding"], "2026-08-22T00:00:00Z");
    startTask("TASK-002");
    const oldBlocker = add(
      "task.blocked",
      subject("task", "TASK-002"),
      { reason: "Still blocked", severity: "high", needs: "agent" },
      "2026-08-23T00:00:00Z",
    );
    createTask("TASK-004", ["coding"], "2026-08-24T00:00:00Z");
    startTask("TASK-004");
    const atStart = add(
      "task.progress.updated",
      subject("task", "TASK-004"),
      { progress: 10 },
      WINDOW.startInclusive,
    );
    add(
      "task.progress.updated",
      subject("task", "TASK-004"),
      { progress: 20 },
      WINDOW.endExclusive,
    );

    const result = pulse();
    expect(result.risks[0]?.sourceEvents).toEqual([oldBlocker.id]);
    expect(result.progress).toEqual([
      expect.objectContaining({ delta: 10, sourceEvents: [atStart.id] }),
    ]);
  });

  it("counts accepted completions only inside the day window", () => {
    createTask("TASK-005");
    startTask("TASK-005");
    add(
      "task.review.requested",
      subject("task", "TASK-005"),
      { summary: "Ready", outputs: [] },
      "2026-08-24T08:00:00Z",
    );
    const completed = add(
      "task.completed",
      subject("task", "TASK-005"),
      { acceptedBy: "human-owner" },
      "2026-08-24T09:00:00Z",
    );

    expect(pulse().kpis.doneToday).toEqual({
      value: 1,
      sourceEvents: [completed.id],
    });
  });

  it("excludes disconnected placements from active agents", () => {
    register();
    add(
      "agent.disconnected",
      subject("agent", "agent-pulse"),
      { id: "agent-pulse", host: "host-mac", graceful: true },
      "2026-08-24T08:00:00Z",
    );

    expect(pulse().kpis.activeAgents).toEqual({ value: 0, sourceEvents: [] });
  });

  it("keeps a sourced consequence but no story when no stored story supports it", () => {
    createTask("TASK-006");
    startTask("TASK-006");
    add(
      "task.progress.updated",
      subject("task", "TASK-006"),
      { progress: 25 },
      "2026-08-24T08:00:00Z",
    );

    expect(pulse()).toMatchObject({
      topConsequence: { kind: "progress" },
      story: null,
    });
  });

  it("rejects malformed, mixed, gapped, and duplicated histories", () => {
    createTask("TASK-007");
    const valid = history[0] as StoredEvent;
    const cases: Array<[unknown[], ProjectPulseError["code"]]> = [
      [[{ bad: true }], "INVALID_HISTORY"],
      [[{ ...valid, project: "proj_other" }], "MIXED_PROJECT"],
      [[{ ...valid, seq: 2 }], "SEQUENCE_GAP"],
      [[valid, { ...valid, seq: 2 }], "DUPLICATE_EVENT"],
    ];

    for (const [candidate, code] of cases) {
      expect(() =>
        buildProjectPulse({
          project: PROJECT as never,
          window: WINDOW,
          history: candidate,
        }),
      ).toThrowError(expect.objectContaining({ code }));
    }
  });

  it.each([
    { startInclusive: "not-a-date", endExclusive: WINDOW.endExclusive },
    { startInclusive: WINDOW.endExclusive, endExclusive: WINDOW.startInclusive },
    { startInclusive: WINDOW.startInclusive, endExclusive: WINDOW.startInclusive },
  ])("rejects invalid or non-increasing windows", (window) => {
    expect(() =>
      buildProjectPulse({ project: PROJECT as never, window, history: [] }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WINDOW" }));
  });

  it("rejects story sources that are missing or not earlier than the story", () => {
    const missing = newEventId();
    add("pulse.story.generated", subject("pulse", "PULSE-STORY"), {
      headline: "Unsupported",
      body: "No prior event supports this.",
      sourceEvents: [missing],
    });

    expect(() => pulse()).toThrowError(
      expect.objectContaining({ code: "INVALID_STORY_SOURCE" }),
    );
  });
});
