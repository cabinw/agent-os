import { beforeEach, describe, expect, it } from "vitest";
import { newEventId, parseStoredEvent } from "../packages/event-core/src/index.js";
import type {
  EventPayload,
  EventType,
  StoredEvent,
  Subject,
} from "../packages/event-core/src/index.js";
import {
  type ProjectLibraryError,
  buildProjectLibrary,
} from "../packages/mcp-server/src/index.js";

const NOW = "2026-08-24T12:00:00Z";
const INTEGRATION = {
  participates: true,
  streaming: true,
  reasoning: true,
  session: true,
  usage: true,
} as const;

type Stream = { project: string; history: StoredEvent[] };
let streams: Stream[];

function subject(kind: Subject["kind"], id: string): Subject {
  return { kind, id } as Subject;
}

function stream(project: string, name: string, at = "2026-07-01T08:00:00Z"): Stream {
  const result: Stream = { project, history: [] };
  streams.push(result);
  add(
    result,
    "project.created",
    subject("project", project),
    { name, stack: ["TypeScript", "SQLite"] },
    at,
  );
  return result;
}

function add<Type extends EventType>(
  target: Stream,
  type: Type,
  entity: Subject,
  payload: EventPayload<Type>,
  at = "2026-07-01T09:00:00Z",
): StoredEvent<Type> {
  const event = parseStoredEvent({
    schemaVersion: 1,
    id: newEventId(),
    seq: target.history.length + 1,
    type,
    project: target.project,
    actor: { kind: "system", id: "library-runtime" },
    subject: entity,
    at,
    payload,
  }) as StoredEvent<Type>;
  target.history.push(event);
  return event;
}

function library(now = NOW) {
  return buildProjectLibrary({
    now,
    projects: streams.map(({ project, history }) => ({
      project: project as never,
      history,
    })),
  });
}

function createTask(target: Stream, id: string, priority: "high" | "critical" = "high") {
  return add(target, "task.created", subject("task", id), {
    title: `Deliver ${id}`,
    goal: "Ship the project",
    requires: ["coding"],
    priority,
    dependsOn: [],
    requiresApproval: false,
  });
}

function register(target: Stream, id = "agent-library", host = "host-local") {
  return add(target, "agent.registered", subject("agent", id), {
    id,
    name: "Library Agent",
    provider: "local",
    role: "developer",
    concurrency: 1,
    host,
    capabilities: ["coding"],
    integration: INTEGRATION,
  });
}

function start(target: Stream, task: string, agent = "agent-library") {
  add(target, "task.assigned", subject("task", task), {
    executor: agent,
    matchedBy: "capability",
  });
  return add(target, "task.started", subject("task", task), { executor: agent });
}

function expectCode(action: () => unknown, code: ProjectLibraryError["code"]) {
  expect(action).toThrowError();
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

beforeEach(() => {
  streams = [];
});

describe("RM-3.5 sourced Project Library", () => {
  it("returns a deeply frozen honest empty portfolio", () => {
    const result = library();
    expect(result).toEqual({
      now: NOW,
      counts: { all: 0, active: 0, paused: 0, archived: 0, completed: 0 },
      projects: [],
      insights: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.projects)).toBe(true);
  });

  it("sorts projects by last activity and derives state counts", () => {
    const old = stream("proj_old", "Alpha", "2026-07-01T08:00:00Z");
    add(old, "project.state.changed", subject("project", old.project), {
      from: "active",
      to: "paused",
    });
    stream("proj_new", "Beta", "2026-08-20T08:00:00Z");

    expect(library().counts).toEqual({
      all: 2,
      active: 1,
      paused: 1,
      archived: 0,
      completed: 0,
    });
    expect(library().projects.map((item) => item.project)).toEqual([
      "proj_new",
      "proj_old",
    ]);
  });

  it("derives the five-column row and detail data only from sourced events", () => {
    const target = stream("proj_rich", "Rich Project");
    const registration = register(target);
    createTask(target, "TASK-001", "critical");
    start(target, "TASK-001");
    add(target, "task.progress.updated", subject("task", "TASK-001"), {
      progress: 60,
      note: "Core slice complete",
    });
    const blocker = add(target, "task.blocked", subject("task", "TASK-001"), {
      reason: "Owner decision required",
      severity: "high",
      needs: "human",
    });
    const snapshot = add(
      target,
      "project.snapshot.captured",
      subject("project", target.project),
      { label: "MVP", image: "snapshots/mvp.png", at: "2026-07-01T09:00:00Z" },
    );
    const story = add(target, "pulse.story.generated", subject("pulse", "pulse-1"), {
      headline: "Owner decision is blocking the MVP",
      body: "Choose the deployment target.",
      sourceEvents: [blocker.id],
    });
    const decision = add(
      target,
      "knowledge.created",
      subject("knowledge", "knowledge-1"),
      {
        type: "decision",
        title: "Use SQLite",
        summary: "Keep the local event store simple.",
        rationale: "One native boundary is easier to audit.",
        sourceEvents: [blocker.id],
      },
    );
    const file = add(target, "artifact.produced", subject("artifact", "artifact-1"), {
      path: "docs/architecture.md",
      kind: "document",
      task: "TASK-001",
    });
    const revival = add(target, "project.revived", subject("project", target.project), {
      dormantDays: 30,
      plan: [{ title: "Check environment", estimateMinutes: 30, detail: "Run build." }],
    });
    add(target, "project.state.changed", subject("project", target.project), {
      from: "active",
      to: "paused",
    });

    const item = library().projects[0];
    expect(item).toMatchObject({
      name: "Rich Project",
      state: "paused",
      progress: 60,
      currentWork: {
        task: "TASK-001",
        status: "blocked",
        priority: "critical",
      },
      health: { status: "blocked", sourceEvents: [blocker.id] },
      summary: { text: "Owner decision is blocking the MVP" },
      agents: [{ id: "agent-library", name: "Library Agent", status: "idle" }],
    });
    expect(item?.agents[0]?.sourceEvents).toEqual([registration.id]);
    expect(item?.summary?.sourceEvents).toEqual([story.id, blocker.id]);
    expect(item?.snapshots[0]?.sourceEvents).toEqual([snapshot.id]);
    expect(item?.nextSteps[0]).toMatchObject({
      title: "Check environment",
      sourceEvents: [revival.id],
    });
    expect(item?.revival).toMatchObject({
      built: [],
      current: { state: "paused", progress: 60, health: "blocked" },
      decisions: [{ title: "Use SQLite" }],
      unfinished: [{ task: "TASK-001", status: "blocked" }],
      issues: [
        {
          task: "TASK-001",
          kind: "blocked",
          reason: "Owner decision required",
          sourceEvents: [blocker.id],
        },
      ],
      staleness: [
        { area: "dependencies", state: "likely-stale", detail: null },
        { area: "apis", state: "likely-stale", detail: null },
        { area: "credentials", state: "likely-stale", detail: null },
      ],
      plan: [{ title: "Check environment", sourceEvents: [revival.id] }],
    });
    expect(item?.knowledge[0]?.sourceEvents).toEqual([decision.id, blocker.id]);
    expect(item?.files[0]?.sourceEvents).toEqual([file.id]);
    expect(item?.timeline[0]?.type).toBe("project.state.changed");
  });

  it("does not let the derived revival event erase measured dormancy", () => {
    const target = stream("proj_revival_now", "Dormant Project");
    add(target, "project.state.changed", subject("project", target.project), {
      from: "active",
      to: "paused",
    });
    add(
      target,
      "project.revived",
      subject("project", target.project),
      {
        dormantDays: 54,
        plan: [
          {
            title: "Check environment",
            estimateMinutes: 30,
            detail: "Verify the existing toolchain.",
          },
        ],
      },
      NOW,
    );
    const checked = add(
      target,
      "project.environment.checked",
      subject("project", target.project),
      {
        checks: [
          {
            area: "dependencies",
            status: "stale",
            detail: "The existing lockfile no longer resolves.",
          },
          {
            area: "credentials",
            status: "current",
            detail: "Credential validation succeeded without exposing secrets.",
          },
        ],
      },
      NOW,
    );
    const item = library().projects[0];
    expect(item?.dormantDays).toBe(54);
    expect(item?.revival?.plan).toHaveLength(1);
    expect(item?.lastActivity.type).toBe("project.environment.checked");
    expect(item?.revival?.staleness).toEqual([
      {
        area: "dependencies",
        state: "stale",
        detail: "The existing lockfile no longer resolves.",
        sourceEvents: [checked.id],
      },
      {
        area: "apis",
        state: "likely-stale",
        detail: null,
        sourceEvents: [target.history[1]?.id],
      },
      {
        area: "credentials",
        state: "current",
        detail: "Credential validation succeeded without exposing secrets.",
        sourceEvents: [checked.id],
      },
    ]);
  });

  it("ranks blocked work before review, running and created work", () => {
    const target = stream("proj_rank", "Ranked");
    register(target);
    createTask(target, "TASK-001");
    start(target, "TASK-001");
    createTask(target, "TASK-002", "critical");
    start(target, "TASK-002");
    add(target, "task.blocked", subject("task", "TASK-002"), {
      reason: "Blocked",
      severity: "high",
      needs: "human",
    });
    expect(library().projects[0]?.currentWork?.task).toBe("TASK-002");
  });

  it("keeps missing AI copy and recommendations honestly empty", () => {
    stream("proj_sparse", "Sparse");
    const item = library().projects[0];
    expect(item?.summary).toBeNull();
    expect(item?.nextSteps).toEqual([]);
    expect(item?.progress).toBe(0);
  });

  it("rejects invalid now and duplicate project sources", () => {
    const target = stream("proj_one", "One");
    expectCode(() => library("today"), "INVALID_NOW");
    expectCode(
      () =>
        buildProjectLibrary({
          now: NOW,
          projects: [
            { project: target.project as never, history: target.history },
            { project: target.project as never, history: target.history },
          ],
        }),
      "DUPLICATE_PROJECT",
    );
  });

  it("rejects mixed histories and per-project sequence gaps", () => {
    const target = stream("proj_strict", "Strict");
    const other = stream("proj_other", "Other");
    expectCode(
      () =>
        buildProjectLibrary({
          now: NOW,
          projects: [{ project: target.project as never, history: other.history }],
        }),
      "MIXED_PROJECT",
    );
    const gap = structuredClone(target.history) as unknown as Record<string, unknown>[];
    if (gap[0]) gap[0].seq = 2;
    expectCode(
      () =>
        buildProjectLibrary({
          now: NOW,
          projects: [{ project: target.project as never, history: gap }],
        }),
      "SEQUENCE_GAP",
    );
  });

  it("rejects missing, duplicate and stale project lifecycle events", () => {
    const target = stream("proj_lifecycle", "Lifecycle");
    const missing = target.history.slice(1);
    expectCode(
      () =>
        buildProjectLibrary({
          now: NOW,
          projects: [{ project: target.project as never, history: missing }],
        }),
      "MISSING_PROJECT",
    );
    add(target, "project.created", subject("project", target.project), {
      name: "Again",
      stack: ["TypeScript"],
    });
    expectCode(() => library(), "INVALID_HISTORY");

    streams = [];
    const stale = stream("proj_stale", "Stale");
    add(stale, "project.state.changed", subject("project", stale.project), {
      from: "paused",
      to: "archived",
    });
    expectCode(() => library(), "STALE_PROJECT_STATE");
  });

  it("rejects duplicate event ids even across project histories", () => {
    const first = stream("proj_first", "First");
    const second = stream("proj_second", "Second");
    const duplicate = structuredClone(second.history[0]) as unknown as Record<
      string,
      unknown
    >;
    duplicate.id = first.history[0]?.id;
    second.history[0] = parseStoredEvent(duplicate);
    expectCode(() => library(), "DUPLICATE_EVENT");
  });

  it("wraps invalid Task and Agent histories as invalid portfolio input", () => {
    const target = stream("proj_invalid", "Invalid");
    add(target, "task.started", subject("task", "TASK-999"), {
      executor: "agent-missing",
    });
    expectCode(() => library(), "INVALID_HISTORY");
  });
});
