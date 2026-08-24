import { describe, expect, it, vi } from "vitest";
import { newEventId, parseStoredEvent } from "../packages/event-core/src/index.js";
import type { EventType, StoredEvent } from "../packages/event-core/src/index.js";
import {
  AUTONOMOUS_ROUTING_TRIGGERS,
  AutonomousRoutingError,
  agentPlacementKey,
  createAutonomousTaskRouter,
} from "../packages/task-engine/src/index.js";
import type {
  AgentCatalogState,
  AutonomousAssignmentCommand,
  AutonomousRoutingPort,
  AutonomousRoutingSnapshot,
  TaskProjectState,
  TaskState,
} from "../packages/task-engine/src/index.js";

const PROJECT = "proj_autonomous_routing";
const AT = "2026-08-24T14:00:00Z";

function trigger(
  type: "task.created" | "task.assigned" | "task.completed" = "task.created",
  project = PROJECT,
): StoredEvent {
  const payload =
    type === "task.created"
      ? {
          title: "Trigger routing",
          goal: "goal-route",
          requires: ["coding"],
          priority: "high",
          dependsOn: [],
          requiresApproval: false,
        }
      : type === "task.assigned"
        ? { executor: "alpha", matchedBy: "capability" }
        : { acceptedBy: "human-owner" };
  return parseStoredEvent({
    schemaVersion: 1,
    id: newEventId(),
    seq: 1,
    type,
    project,
    actor: { kind: "system", id: "runtime" },
    subject: { kind: "task", id: "TASK-999" },
    at: AT,
    payload,
  });
}

function task(
  id: string,
  priority: TaskState["priority"] = "high",
  createdAt = AT,
  overrides: Partial<TaskState> = {},
): TaskState {
  return {
    id: id as never,
    project: PROJECT as never,
    title: id,
    goal: "goal-route",
    status: "created",
    progress: 0,
    priority,
    requires: ["coding"],
    owner: "supervisor",
    dependsOn: [],
    outputs: [],
    requiresApproval: false,
    createdAt,
    ...overrides,
  } as TaskState;
}

function tasks(...items: TaskState[]): TaskProjectState {
  return { tasks: Object.fromEntries(items.map((item) => [item.id, item])) };
}

function catalog(): AgentCatalogState {
  const key = agentPlacementKey("alpha", "host-a");
  return {
    placements: {
      [key]: {
        agent: "alpha",
        host: "host-a",
        project: PROJECT,
        name: "Alpha",
        provider: "display-only",
        role: "developer",
        concurrency: 2,
        capabilities: ["coding", "testing"],
        integration: {
          participates: true,
          streaming: true,
          reasoning: false,
          session: true,
          usage: true,
        },
        status: "idle",
        registeredAt: AT,
        changedAt: AT,
      },
    },
  } as never;
}

function snapshot(taskState: TaskProjectState): AutonomousRoutingSnapshot {
  return {
    tasks: taskState,
    catalog: catalog(),
    livePlacements: [
      { agent: "alpha" as never, host: "host-a" as never, accepting: true, active: 0 },
    ],
  };
}

function harness(
  taskState = tasks(task("TASK-001")),
  overrides: Partial<AutonomousRoutingPort> = {},
) {
  const commands: AutonomousAssignmentCommand[] = [];
  const port: AutonomousRoutingPort = {
    snapshot: vi.fn(async () => snapshot(taskState)),
    assign: vi.fn(async (command) => {
      commands.push(command);
      return "assigned" as const;
    }),
    ...overrides,
  };
  return { commands, port, router: createAutonomousTaskRouter(port) };
}

describe("RM-5.3 · event-driven autonomous task routing", () => {
  it("publishes a frozen trigger matrix that includes fresh assignment chaining", () => {
    expect(AUTONOMOUS_ROUTING_TRIGGERS).toEqual([
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
    ]);
    expect(Object.isFrozen(AUTONOMOUS_ROUTING_TRIGGERS)).toBe(true);
  });

  it("selects one ready task by priority, created time and Task id", async () => {
    const state = tasks(
      task("TASK-003", "high", "2026-08-24T14:00:02Z"),
      task("TASK-002", "critical", "2026-08-24T14:00:01Z"),
      task("TASK-001", "critical", "2026-08-24T14:00:01Z"),
    );
    const event = trigger();
    const { commands, router } = harness(state);
    await expect(router.route(event)).resolves.toEqual({
      kind: "assigned",
      trigger: "task.created",
      task: "TASK-001",
      executor: "alpha",
      host: "host-a",
    });
    expect(commands).toEqual([
      {
        project: PROJECT,
        task: "TASK-001",
        executor: "alpha",
        host: "host-a",
        matchedBy: "capability",
        expectedTaskStatus: "created",
        causedBy: event.id,
        operationToken: `auto-route:${event.id}:TASK-001`,
      },
    ]);
    expect(Object.isFrozen(commands[0])).toBe(true);
  });

  it("keeps unready work idle and returns exact no-match diagnoses", async () => {
    const waiting = task("TASK-002", "high", AT, {
      dependsOn: ["TASK-001" as never],
    });
    const completed = task("TASK-001", "high", AT, {
      status: "running",
      executor: "alpha",
      startedAt: AT,
    });
    const idle = harness(tasks(waiting, completed));
    await expect(idle.router.route(trigger())).resolves.toEqual({
      kind: "idle",
      trigger: "task.created",
    });
    expect(idle.port.assign).not.toHaveBeenCalled();

    const unmatched = harness(tasks(task("TASK-003", "high", AT, { requires: ["ops"] })));
    await expect(unmatched.router.route(trigger())).resolves.toEqual({
      kind: "unmatched",
      trigger: "task.created",
      task: "TASK-003",
      reason: "no-capability",
    });
    expect(unmatched.port.assign).not.toHaveBeenCalled();
  });

  it("returns reservation conflict without retrying a stale snapshot", async () => {
    const assign = vi.fn(async () => "conflict" as const);
    const { router } = harness(tasks(task("TASK-001")), { assign });
    await expect(router.route(trigger("task.assigned"))).resolves.toMatchObject({
      kind: "conflict",
      trigger: "task.assigned",
      task: "TASK-001",
    });
    expect(assign).toHaveBeenCalledOnce();
  });

  it("uses the same idempotency token when a durable trigger is redelivered", async () => {
    const event = trigger();
    const { commands, router } = harness();
    await router.route(event);
    await router.route(event);
    expect(commands).toHaveLength(2);
    expect(commands[0]?.operationToken).toBe(commands[1]?.operationToken);
    expect(commands[0]?.causedBy).toBe(event.id);
  });

  it("serializes one project while allowing another project to read", async () => {
    let release!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reads: string[] = [];
    const port: AutonomousRoutingPort = {
      snapshot: vi.fn(async (project) => {
        reads.push(project);
        if (reads.length === 1) await firstRead;
        return project === PROJECT
          ? snapshot(tasks(task("TASK-001")))
          : { tasks: { tasks: {} }, catalog: { placements: {} }, livePlacements: [] };
      }),
      assign: vi.fn(async () => "assigned"),
    };
    const router = createAutonomousTaskRouter(port);
    const first = router.route(trigger("task.created"));
    const second = router.route(trigger("task.completed"));
    const other = router.route(trigger("task.created", "proj_other"));
    await vi.waitFor(() => expect(reads).toEqual([PROJECT, "proj_other"]));
    release();
    await Promise.all([first, second, other]);
    expect(reads).toEqual([PROJECT, "proj_other", PROJECT]);
  });

  it("skips irrelevant events without reading runtime state", async () => {
    const { port, router } = harness();
    const irrelevant = parseStoredEvent({
      schemaVersion: 1,
      id: newEventId(),
      seq: 1,
      type: "message.sent",
      project: PROJECT,
      actor: { kind: "agent", id: "alpha" },
      subject: { kind: "project", id: PROJECT },
      at: AT,
      payload: {
        from: "alpha",
        to: "supervisor",
        type: "progress",
        content: "Still working.",
      },
    });
    await expect(router.route(irrelevant)).resolves.toEqual({
      kind: "skipped",
      trigger: "message.sent",
    });
    expect(port.snapshot).not.toHaveBeenCalled();
  });

  it("attaches the same serialized route handler to Event Bus delivery", async () => {
    let subscriber: ((event: StoredEvent) => Promise<void>) | undefined;
    const detach = vi.fn();
    const { port, router } = harness();
    const returned = router.attach({
      subscribe: (handler: (event: StoredEvent) => Promise<void>) => {
        subscriber = handler;
        return detach;
      },
    } as never);
    expect(returned).toBe(detach);
    await subscriber?.(trigger());
    expect(port.assign).toHaveBeenCalledOnce();
  });

  it("wraps malformed events, snapshot, routing and assignment failures", async () => {
    await expect(harness().router.route({ type: "task.created" })).rejects.toMatchObject({
      code: "INVALID_EVENT",
    });
    await expect(
      harness(undefined, {
        snapshot: async () => {
          throw new Error("projection offline");
        },
      }).router.route(trigger()),
    ).rejects.toMatchObject({ code: "READ_FAILURE" });
    await expect(
      harness(undefined, {
        snapshot: async () => ({
          ...snapshot(tasks(task("TASK-001"))),
          livePlacements: [
            {
              agent: "ghost" as never,
              host: "host-a" as never,
              accepting: true,
              active: 0,
            },
          ],
        }),
      }).router.route(trigger()),
    ).rejects.toMatchObject({ code: "ROUTING_FAILURE" });
    await expect(
      harness(undefined, {
        snapshot: async () =>
          ({ ...snapshot(tasks(task("TASK-001"))), livePlacements: null }) as never,
      }).router.route(trigger()),
    ).rejects.toMatchObject({ code: "READ_FAILURE" });
    await expect(
      harness(undefined, {
        snapshot: async () => ({
          ...snapshot(tasks(task("TASK-001"))),
          tasks: tasks(task("TASK-001", "high", AT, { project: "proj_other" as never })),
        }),
      }).router.route(trigger()),
    ).rejects.toMatchObject({ code: "READ_FAILURE" });
    await expect(
      harness(undefined, {
        assign: async () => {
          throw new Error("reservation offline");
        },
      }).router.route(trigger()),
    ).rejects.toMatchObject({ code: "ASSIGNMENT_FAILURE" });
    await expect(
      harness(undefined, { assign: async () => "unknown" as never }).router.route(
        trigger(),
      ),
    ).rejects.toBeInstanceOf(AutonomousRoutingError);
  });
});
