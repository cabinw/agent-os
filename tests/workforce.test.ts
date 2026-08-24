import { beforeEach, describe, expect, it } from "vitest";
import { newEventId, parseStoredEvent } from "../packages/event-core/src/index.js";
import type {
  EventPayload,
  EventType,
  StoredEvent,
  Subject,
} from "../packages/event-core/src/index.js";
import {
  type ProjectWorkforceError,
  buildProjectWorkforce,
} from "../packages/mcp-server/src/index.js";
import type { LivePlacement } from "../packages/task-engine/src/index.js";

const PROJECT = "proj_workforce";
const OBSERVED_AT = "2026-08-24T12:00:00Z";
const INTEGRATION = {
  participates: true,
  streaming: true,
  reasoning: false,
  session: true,
  usage: true,
} as const;

let history: StoredEvent[];

function subject(kind: Subject["kind"], id: string): Subject {
  return { kind, id } as Subject;
}

function add<Type extends EventType>(
  type: Type,
  target: Subject,
  payload: EventPayload<Type>,
  at = "2026-08-24T10:00:00Z",
  project = PROJECT,
): StoredEvent<Type> {
  const event = parseStoredEvent({
    schemaVersion: 1,
    id: newEventId(),
    seq: history.length + 1,
    type,
    project,
    actor: { kind: "system", id: "workforce-runtime" },
    subject: target,
    at,
    payload,
  }) as StoredEvent<Type>;
  history.push(event);
  return event;
}

function projectCreated() {
  return add(
    "project.created",
    subject("project", PROJECT),
    { name: "Workforce", stack: ["TypeScript"] },
    "2026-08-24T08:00:00Z",
  );
}

function register(
  agent: string,
  host: string,
  capabilities: EventPayload<"agent.registered">["capabilities"],
  concurrency = 2,
) {
  return add(
    "agent.registered",
    subject("agent", agent),
    {
      id: agent,
      name: agent === "agent-codex" ? "Codex" : "Reviewer",
      provider: agent === "agent-codex" ? "openai" : "local",
      role: agent === "agent-codex" ? "developer" : "reviewer",
      concurrency,
      host,
      capabilities: [...capabilities],
      integration: INTEGRATION,
    },
    "2026-08-24T08:10:00Z",
  );
}

function createTask(
  id: string,
  requires: EventPayload<"task.created">["requires"],
  dependsOn: string[] = [],
  priority: "high" | "critical" = "high",
) {
  return add("task.created", subject("task", id), {
    title: `Deliver ${id}`,
    goal: "Ship the workforce views",
    requires: [...requires],
    priority,
    dependsOn: dependsOn as never,
    requiresApproval: false,
  });
}

function assignAndStart(id: string, executor = "agent-codex") {
  add("task.assigned", subject("task", id), {
    executor,
    matchedBy: "capability",
  });
  return add("task.started", subject("task", id), { executor });
}

function view(livePlacements: readonly LivePlacement[] = []) {
  return buildProjectWorkforce({
    project: PROJECT as never,
    observedAt: OBSERVED_AT,
    history,
    livePlacements,
  });
}

function live(
  agent = "agent-codex",
  host = "host-mac",
  accepting = true,
  active = 0,
): LivePlacement {
  return { agent: agent as never, host: host as never, accepting, active };
}

function expectCode(action: () => unknown, code: ProjectWorkforceError["code"]) {
  expect(action).toThrowError();
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

beforeEach(() => {
  history = [];
  projectCreated();
});

describe("RM-3.6 sourced ProjectWorkforce", () => {
  it("returns a deeply frozen empty workforce with controlled coverage", () => {
    const result = view();
    expect(result.taskCounts).toEqual({
      all: 0,
      created: 0,
      assigned: 0,
      running: 0,
      blocked: 0,
      review: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });
    expect(result.agentCounts).toEqual({
      logical: 0,
      connected: 0,
      available: 0,
      activeDispatches: 0,
    });
    expect(result.coverage).toHaveLength(10);
    expect(result.coverage.every((item) => !item.covered)).toBe(true);
    expect(result.threads).toEqual({ available: false });
    expect(Object.isFrozen(result.coverage[0])).toBe(true);
  });

  it("keeps progress 100 and review lifecycle visibly separate", () => {
    register("agent-codex", "host-mac", ["coding", "testing"]);
    createTask("TASK-001", ["coding"]);
    assignAndStart("TASK-001");
    add("task.progress.updated", subject("task", "TASK-001"), { progress: 100 });
    const review = add("task.review.requested", subject("task", "TASK-001"), {
      summary: "Implementation finished",
      outputs: ["src/workforce.ts"],
    });

    expect(view([live()]).tasks[0]).toMatchObject({
      task: "TASK-001",
      status: "review",
      progress: 100,
      awaitingHumanReview: true,
      assignment: { kind: "assigned", executor: "agent-codex" },
      sourceEvents: [review.id],
    });
  });

  it("diagnoses dependency, awaiting assignment and no-capability separately", () => {
    register("agent-codex", "host-mac", ["coding"]);
    createTask("TASK-001", ["coding"]);
    createTask("TASK-002", ["coding"], ["TASK-001"]);
    createTask("TASK-003", ["data"]);

    const byId = Object.fromEntries(
      view([live()]).tasks.map((task) => [task.task, task]),
    );
    expect(byId["TASK-001"]?.assignment).toMatchObject({
      kind: "awaiting-assignment",
      candidate: { agent: "agent-codex", host: "host-mac" },
    });
    expect(byId["TASK-002"]?.assignment).toEqual({
      kind: "waiting-dependency",
      tasks: ["TASK-001"],
    });
    expect(byId["TASK-003"]?.assignment).toEqual({
      kind: "no-capability",
      requiredCapabilities: ["data"],
    });
  });

  it.each([
    [[], "unreachable"],
    [[live("agent-codex", "host-mac", false, 0)], "unavailable"],
    [[live("agent-codex", "host-mac", true, 1)], "saturated"],
  ] as const)("preserves runtime routing diagnosis %s", (placements, reason) => {
    register("agent-codex", "host-mac", ["coding"], 1);
    createTask("TASK-001", ["coding"]);
    expect(view(placements).tasks[0]?.assignment.kind).toBe(reason);
  });

  it("merges logical agents across hosts and derives only live accepting coverage", () => {
    const first = register("agent-codex", "host-mac", ["coding", "testing"]);
    const second = register("agent-codex", "host-win", ["coding", "ops"]);
    createTask("TASK-001", ["coding"]);
    assignAndStart("TASK-001");

    const result = view([
      live("agent-codex", "host-mac", true, 1),
      live("agent-codex", "host-win", false, 0),
    ]);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      agent: "agent-codex",
      provider: "openai",
      availability: "available",
      active: 1,
      capabilities: ["coding", "testing", "ops"],
      currentTasks: ["TASK-001"],
      sourceEvents: [first.id, second.id],
    });
    expect(result.agents[0]?.placements).toHaveLength(2);
    expect(result.coverage.find((item) => item.capability === "testing")).toMatchObject({
      covered: true,
      agents: ["agent-codex"],
      placements: 1,
    });
    expect(result.coverage.find((item) => item.capability === "ops")).toMatchObject({
      covered: false,
      agents: [],
      placements: 0,
    });
  });

  it("derives outcome counts without inventing heartbeat or throughput fields", () => {
    register("agent-codex", "host-mac", ["coding"]);
    createTask("TASK-001", ["coding"]);
    assignAndStart("TASK-001");
    add("task.review.requested", subject("task", "TASK-001"), {
      summary: "Done",
      outputs: [],
    });
    add("task.completed", subject("task", "TASK-001"), { acceptedBy: "human-1" });

    const agent = view([live()]).agents[0];
    expect(agent).toMatchObject({ completed: 1, failed: 0 });
    expect(agent).not.toHaveProperty("heartbeat");
    expect(agent).not.toHaveProperty("throughput");
  });

  it("rejects invalid or pre-history observation timestamps", () => {
    expectCode(
      () =>
        buildProjectWorkforce({
          project: PROJECT as never,
          observedAt: "now",
          history,
          livePlacements: [],
        }),
      "INVALID_OBSERVATION",
    );
    expectCode(
      () =>
        buildProjectWorkforce({
          project: PROJECT as never,
          observedAt: "2026-08-24T07:00:00Z",
          history,
          livePlacements: [],
        }),
      "INVALID_OBSERVATION",
    );
  });

  it("rejects mixed projects, sequence gaps and duplicate events", () => {
    const mixed = structuredClone(history) as unknown as Record<string, unknown>[];
    if (mixed[0]) {
      mixed[0].project = "proj_other";
      mixed[0].subject = { kind: "project", id: "proj_other" };
    }
    expectCode(
      () =>
        buildProjectWorkforce({
          project: PROJECT as never,
          observedAt: OBSERVED_AT,
          history: mixed,
          livePlacements: [],
        }),
      "MIXED_PROJECT",
    );
    const gap = structuredClone(history) as unknown as Record<string, unknown>[];
    if (gap[0]) gap[0].seq = 2;
    expectCode(
      () =>
        buildProjectWorkforce({
          project: PROJECT as never,
          observedAt: OBSERVED_AT,
          history: gap,
          livePlacements: [],
        }),
      "SEQUENCE_GAP",
    );
    history.push(history[0] as StoredEvent);
    expectCode(() => view(), "SEQUENCE_GAP");
  });

  it("rejects missing or duplicate project creation and stale project state", () => {
    const created = history[0] as StoredEvent;
    history = [];
    expectCode(() => view(), "MISSING_PROJECT");
    history = [created];
    add("project.created", subject("project", PROJECT), {
      name: "Duplicate",
      stack: ["TypeScript"],
    });
    expectCode(() => view(), "INVALID_HISTORY");

    history = [created];
    add("project.state.changed", subject("project", PROJECT), {
      from: "paused",
      to: "archived",
    });
    expectCode(() => view(), "INVALID_HISTORY");
  });

  it("rejects duplicate and unregistered live placements even with no tasks", () => {
    register("agent-codex", "host-mac", ["coding"]);
    expectCode(() => view([live(), live()]), "INVALID_LIVE_STATE");
    expectCode(() => view([live("agent-codex", "host-unknown")]), "INVALID_LIVE_STATE");
  });
});
