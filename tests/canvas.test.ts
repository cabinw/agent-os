import { beforeEach, describe, expect, it } from "vitest";
import { newEventId, parseStoredEvent } from "../packages/event-core/src/index.js";
import type {
  EventPayload,
  EventType,
  StoredEvent,
  Subject,
} from "../packages/event-core/src/index.js";
import {
  type ProjectCanvasError,
  buildProjectCanvas,
} from "../packages/mcp-server/src/index.js";

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

function add<Type extends EventType>(
  target: Stream,
  type: Type,
  entity: Subject,
  payload: EventPayload<Type>,
  causedBy?: string,
): StoredEvent<Type> {
  const event = parseStoredEvent({
    schemaVersion: 1,
    id: newEventId(),
    seq: target.history.length + 1,
    type,
    project: target.project,
    actor: { kind: "system", id: "canvas-runtime" },
    subject: entity,
    at: `2026-08-24T12:${String(target.history.length).padStart(2, "0")}:00Z`,
    ...(causedBy === undefined ? {} : { causedBy }),
    payload,
  }) as StoredEvent<Type>;
  target.history.push(event);
  return event;
}

function stream(project: string, name: string): Stream {
  const target: Stream = { project, history: [] };
  streams.push(target);
  add(target, "project.created", subject("project", project), {
    name,
    stack: ["TypeScript"],
  });
  return target;
}

function richStream(project = "proj_canvas", name = "Canvas Project") {
  const target = stream(project, name);
  const registered = add(target, "agent.registered", subject("agent", "agent-canvas"), {
    id: "agent-canvas",
    name: "Canvas Agent",
    provider: "local",
    role: "developer",
    concurrency: 1,
    host: "host-local",
    capabilities: ["coding"],
    integration: INTEGRATION,
  });
  const created = add(
    target,
    "task.created",
    subject("task", "TASK-001"),
    {
      title: "Build sourced Canvas",
      goal: "GOAL-CANVAS",
      requires: ["coding"],
      priority: "high",
      dependsOn: [],
      requiresApproval: false,
    },
    registered.id,
  );
  const assigned = add(
    target,
    "task.assigned",
    subject("task", "TASK-001"),
    {
      executor: "agent-canvas",
      matchedBy: "capability",
    },
    created.id,
  );
  const started = add(
    target,
    "task.started",
    subject("task", "TASK-001"),
    {
      executor: "agent-canvas",
    },
    assigned.id,
  );
  const progressed = add(
    target,
    "task.progress.updated",
    subject("task", "TASK-001"),
    {
      progress: 70,
      note: "Projection complete",
    },
    started.id,
  );
  const knowledge = add(
    target,
    "knowledge.created",
    subject("knowledge", "KN-001"),
    {
      type: "decision",
      title: "Use semantic zoom",
      summary: "Aggregate one sourced graph at each level.",
      rationale: "Preserve provenance.",
      sourceEvents: [progressed.id],
    },
    progressed.id,
  );
  add(
    target,
    "artifact.produced",
    subject("artifact", "artifact-canvas"),
    {
      path: "ui/canvas.png",
      kind: "image",
      task: "TASK-001",
    },
    knowledge.id,
  );
  return target;
}

function canvas() {
  return buildProjectCanvas({
    projects: streams.map(({ project, history }) => ({
      project: project as never,
      history,
    })),
  });
}

function expectCode(action: () => unknown, code: ProjectCanvasError["code"]) {
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

describe("RM-4.4 sourced semantic Canvas", () => {
  it("projects semantic nodes and only event-level causedBy edges", () => {
    richStream();
    const project = canvas().projects[0];
    expect(project).toMatchObject({
      project: "proj_canvas",
      name: "Canvas Project",
      progress: 70,
      health: "healthy",
    });
    expect(project?.nodes.map((node) => node.kind)).toEqual([
      "project",
      "goal",
      "task",
      "agent",
      "knowledge",
      "resource",
    ]);
    expect(project?.nodes.find((node) => node.kind === "task")).toMatchObject({
      label: "Build sourced Canvas",
      status: "running",
      progress: 70,
      executor: "agent-canvas",
      completed: false,
      dependsOn: [],
    });
    expect(project?.edges).toHaveLength(6);
    expect(project?.edges.every((edge) => edge.relation === "causedBy")).toBe(true);
    expect(project?.edges.every((edge) => edge.sourceEvents.length === 2)).toBe(true);
  });

  it("sorts projects by sourced name and marks completed tasks", () => {
    richStream("proj_zulu", "Zulu");
    const alpha = richStream("proj_alpha", "Alpha");
    const review = add(alpha, "task.review.requested", subject("task", "TASK-001"), {
      summary: "Ready",
      outputs: ["ui/canvas.png"],
    });
    add(
      alpha,
      "task.completed",
      subject("task", "TASK-001"),
      {
        acceptedBy: "human-owner",
      },
      review.id,
    );

    const result = canvas();
    expect(result.projects.map((project) => project.name)).toEqual(["Alpha", "Zulu"]);
    expect(result.projects[0]?.progress).toBe(70);
    expect(result.projects[0]?.nodes.find((node) => node.kind === "task")).toMatchObject({
      status: "completed",
      progress: 70,
      completed: true,
    });
  });

  it("is deeply frozen", () => {
    richStream();
    const result = canvas();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.projects)).toBe(true);
    expect(Object.isFrozen(result.projects[0]?.nodes)).toBe(true);
    expect(Object.isFrozen(result.projects[0]?.edges[0]?.sourceEvents)).toBe(true);
  });

  it("rejects duplicate projects and duplicate events across streams", () => {
    const first = richStream();
    expectCode(
      () =>
        buildProjectCanvas({
          projects: [
            { project: first.project as never, history: first.history },
            { project: first.project as never, history: first.history },
          ],
        }),
      "DUPLICATE_PROJECT",
    );

    const second = richStream("proj_second", "Second");
    second.history[1] = {
      ...first.history[1],
      project: second.project,
    } as StoredEvent;
    second.history[2] = {
      ...second.history[2],
      causedBy: first.history[1]?.id,
    } as StoredEvent;
    expectCode(() => canvas(), "DUPLICATE_EVENT");
  });

  it("rejects broken sequence, missing cause, and duplicate project creation", () => {
    const broken = richStream();
    broken.history[2] = { ...broken.history[2], seq: 99 } as StoredEvent;
    expectCode(() => canvas(), "INVALID_HISTORY");

    streams = [];
    const missing = richStream();
    missing.history[2] = {
      ...missing.history[2],
      causedBy: newEventId(),
    } as StoredEvent;
    expectCode(() => canvas(), "INVALID_HISTORY");

    streams = [];
    const duplicate = richStream();
    add(duplicate, "project.created", subject("project", duplicate.project), {
      name: "Duplicate",
      stack: [],
    });
    expectCode(() => canvas(), "INVALID_HISTORY");
  });

  it("rejects malformed sources", () => {
    expectCode(() => buildProjectCanvas(null as never), "INVALID_SOURCE");
    expectCode(
      () =>
        buildProjectCanvas({ projects: [{ project: " bad id" as never, history: [] }] }),
      "INVALID_SOURCE",
    );
    expectCode(
      () =>
        buildProjectCanvas({
          projects: [{ project: "proj_empty" as never, history: [] }],
        }),
      "MISSING_PROJECT",
    );
  });
});
