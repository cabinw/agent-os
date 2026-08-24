import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReducerExecutionError,
  createEventBus,
  parseEventInput,
} from "../packages/event-core/src/index.js";
import type { EventInput, EventType } from "../packages/event-core/src/index.js";
import {
  openSqliteEventStore,
  openSqliteSnapshotStore,
} from "../packages/event-store-sqlite/src/index.js";
import {
  IllegalTaskTransitionError,
  TASK_EVENT_TYPES,
  TASK_STATUSES,
  TaskProjectionError,
  parseTaskProjectState,
  registerTaskReducer,
  transitionTaskStatus,
} from "../packages/task-engine/src/index.js";
import type {
  TaskEventType,
  TaskProjectState,
  TaskStatus,
} from "../packages/task-engine/src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-os-task-engine-")));
  roots.push(root);
  return {
    events: join(root, "events.sqlite"),
    snapshots: join(root, "snapshots.sqlite"),
  };
}

const LEGAL: Readonly<
  Partial<Record<TaskStatus, Readonly<Partial<Record<TaskEventType, TaskStatus>>>>>
> = {
  created: { "task.assigned": "assigned", "task.cancelled": "cancelled" },
  assigned: { "task.started": "running", "task.cancelled": "cancelled" },
  running: {
    "task.progress.updated": "running",
    "task.blocked": "blocked",
    "task.review.requested": "review",
    "task.failed": "failed",
    "task.cancelled": "cancelled",
  },
  blocked: { "task.unblocked": "running", "task.cancelled": "cancelled" },
  review: {
    "task.started": "running",
    "task.completed": "completed",
    "task.failed": "failed",
    "task.cancelled": "cancelled",
  },
};

describe.each(TASK_STATUSES)("ADR-002 exhaustive matrix · %s", (status) => {
  it.each(TASK_EVENT_TYPES)("covers %s", (eventType) => {
    const expected = LEGAL[status]?.[eventType];
    if (expected === undefined) {
      expect(() => transitionTaskStatus(status, eventType)).toThrow(
        IllegalTaskTransitionError,
      );
    } else {
      expect(transitionTaskStatus(status, eventType)).toBe(expected);
    }
  });
});

function taskInput<Type extends EventType>(
  type: Type,
  payload: unknown,
): EventInput<Type> {
  return parseEventInput({
    type,
    project: "proj_tasks",
    actor: { kind: "system", id: "supervisor" },
    subject: { kind: "task", id: "TASK-001" },
    payload,
  }) as EventInput<Type>;
}

describe("RM-1.2a · task project reducer", () => {
  it("reduces a complete lifecycle and full replay yields identical state", () => {
    const paths = scratch();
    const store = openSqliteEventStore({ path: paths.events });
    const snapshots = openSqliteSnapshotStore({ path: paths.snapshots });
    const bus = createEventBus({ store, snapshots, snapshotEvery: 3 });
    const tasks = registerTaskReducer(bus);
    const append = (type: EventType, payload: unknown) =>
      bus.append(taskInput(type, payload), {
        token: `${type}-${store.read("proj_tasks").length}`,
      });

    append("task.created", {
      title: "Implement lifecycle",
      goal: "GOAL-001",
      requires: ["coding", "testing"],
      priority: "high",
      dependsOn: [],
      requiresApproval: true,
    });
    append("task.assigned", { executor: "codex", matchedBy: "capability" });
    append("task.started", { executor: "codex" });
    append("task.progress.updated", { progress: 100, note: "code complete" });
    expect(tasks.get("proj_tasks").tasks["TASK-001"]?.status).toBe("running");
    append("task.blocked", {
      reason: "reviewer unavailable",
      severity: "medium",
      needs: "human",
    });
    expect(tasks.get("proj_tasks").tasks["TASK-001"]?.progress).toBe(100);
    append("task.unblocked", { resolution: "reviewer assigned" });
    append("task.review.requested", { summary: "first result", outputs: ["v1"] });
    append("task.started", { executor: "codex" });
    expect(tasks.get("proj_tasks").tasks["TASK-001"]?.outputs).toEqual([]);
    append("task.review.requested", { summary: "reworked", outputs: ["v2"] });
    append("task.completed", { acceptedBy: "human-reviewer" });

    const incremental = tasks.get("proj_tasks");
    expect(incremental.tasks["TASK-001"]).toMatchObject({
      status: "completed",
      progress: 100,
      executor: "codex",
      outputs: ["v2"],
      acceptedBy: "human-reviewer",
    });
    const restarted = createEventBus({ store, snapshots, snapshotEvery: 3 });
    const replayed = registerTaskReducer(restarted);
    expect(replayed.get("proj_tasks")).toEqual(incremental);
    snapshots.clear();
    const withoutCache = createEventBus({ store, snapshots, snapshotEvery: 3 });
    expect(registerTaskReducer(withoutCache).get("proj_tasks")).toEqual(incremental);
    snapshots.close();
    store.close();
  });

  it("fails replay on duplicate creation, missing tasks and executor drift", () => {
    const paths = scratch();
    const store = openSqliteEventStore({ path: paths.events });
    const bus = createEventBus({ store });
    registerTaskReducer(bus);
    bus.append(
      taskInput("task.created", {
        title: "One",
        goal: "GOAL-001",
        requires: [],
        priority: "medium",
        dependsOn: [],
        requiresApproval: false,
      }),
      { token: "create" },
    );
    const duplicate = () =>
      bus.append(
        taskInput("task.created", {
          title: "Duplicate",
          goal: "GOAL-001",
          requires: [],
          priority: "medium",
          dependsOn: [],
          requiresApproval: false,
        }),
        { token: "duplicate" },
      );
    expect(duplicate).toThrow(ReducerExecutionError);
    try {
      duplicate();
    } catch (error) {
      expect((error as Error).cause).toBeInstanceOf(TaskProjectionError);
    }

    const missingStore = openSqliteEventStore({ path: scratch().events });
    const missingBus = createEventBus({ store: missingStore });
    registerTaskReducer(missingBus);
    expect(() =>
      missingBus.append(
        taskInput("task.assigned", { executor: "codex", matchedBy: "explicit" }),
        {
          token: "missing",
        },
      ),
    ).toThrow(ReducerExecutionError);

    const assignedStore = openSqliteEventStore({ path: scratch().events });
    const assigned = createEventBus({ store: assignedStore });
    registerTaskReducer(assigned);
    assigned.append(
      taskInput("task.created", {
        title: "Executor",
        goal: "GOAL-001",
        requires: [],
        priority: "medium",
        dependsOn: [],
        requiresApproval: false,
      }),
      { token: "create" },
    );
    assigned.append(
      taskInput("task.assigned", { executor: "codex", matchedBy: "explicit" }),
      { token: "assign" },
    );
    expect(() =>
      assigned.append(taskInput("task.started", { executor: "other" }), {
        token: "wrong-executor",
      }),
    ).toThrow(ReducerExecutionError);
    assignedStore.close();
    missingStore.close();
    store.close();
  });

  it("snapshot parser rejects unknown fields and cross-project task state", () => {
    const valid: TaskProjectState = {
      tasks: {
        "TASK-001": {
          id: "TASK-001" as never,
          project: "proj_tasks" as never,
          title: "Task",
          goal: "GOAL-001",
          status: "created",
          progress: 0,
          priority: "medium",
          requires: [],
          owner: "supervisor",
          dependsOn: [],
          outputs: [],
          requiresApproval: false,
          createdAt: "2026-08-24T04:00:00Z",
        },
      },
    };
    expect(parseTaskProjectState(valid, "proj_tasks" as never)).toEqual(valid);
    expect(() =>
      parseTaskProjectState(
        {
          tasks: {
            "TASK-001": { ...valid.tasks["TASK-001"], invented: true },
          },
        },
        "proj_tasks" as never,
      ),
    ).toThrow("unknown field");
    expect(() => parseTaskProjectState(valid, "proj_other" as never)).toThrow(
      "wrong project",
    );
    expect(() =>
      parseTaskProjectState(
        {
          tasks: {
            "TASK-001": {
              ...valid.tasks["TASK-001"],
              status: "cancelled",
              terminalAt: "2026-08-24T04:01:00Z",
              cancellation: { by: "supervisor", reason: "withdrawn", extra: true },
            },
          },
        },
        "proj_tasks" as never,
      ),
    ).toThrow("unknown field");
  });
});
