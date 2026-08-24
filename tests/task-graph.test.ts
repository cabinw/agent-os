import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEventInput } from "../packages/event-core/src/index.js";
import { openSqliteEventStore } from "../packages/event-store-sqlite/src/index.js";
import {
  TaskGraphError,
  TaskNotReadyError,
  assertTaskReady,
  readyTaskIds,
  reduceTaskProject,
  unmetDependencies,
  validateTaskPlan,
} from "../packages/task-engine/src/index.js";
import type {
  TaskProjectState,
  TaskState,
  TaskStatus,
} from "../packages/task-engine/src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function task(
  id: string,
  status: TaskStatus = "created",
  dependsOn: string[] = [],
): TaskState {
  return {
    id: id as never,
    project: "proj_graph" as never,
    title: id,
    goal: "GOAL-001",
    status,
    progress: 0,
    priority: "medium",
    requires: [],
    owner: "supervisor",
    dependsOn: dependsOn as never,
    outputs: [],
    requiresApproval: false,
    createdAt: "2026-08-24T04:00:00Z",
    ...(["assigned", "running", "blocked", "review", "completed", "failed"].includes(
      status,
    )
      ? { executor: "codex" }
      : {}),
  } as TaskState;
}

function state(...tasks: TaskState[]): TaskProjectState {
  return { tasks: Object.fromEntries(tasks.map((item) => [item.id, item])) };
}

describe("RM-1.2b · dependency graph admission", () => {
  it("orders a forward-referencing batch deterministically", () => {
    const existing = state(task("TASK-001", "completed"));
    const proposed = [
      { id: "TASK-004", dependsOn: ["TASK-003"] },
      { id: "TASK-002", dependsOn: ["TASK-001"] },
      { id: "TASK-003", dependsOn: ["TASK-002"] },
      { id: "TASK-005", dependsOn: ["TASK-001"] },
    ] as never;
    expect(validateTaskPlan(existing, proposed)).toEqual([
      "TASK-002",
      "TASK-003",
      "TASK-004",
      "TASK-005",
    ]);
  });

  it.each([
    {
      label: "missing dependency",
      plan: [{ id: "TASK-002", dependsOn: ["TASK-999"] }],
      code: "MISSING_DEPENDENCY",
    },
    {
      label: "duplicate proposed id",
      plan: [
        { id: "TASK-002", dependsOn: [] },
        { id: "TASK-002", dependsOn: [] },
      ],
      code: "DUPLICATE_TASK",
    },
    {
      label: "existing id",
      plan: [{ id: "TASK-001", dependsOn: [] }],
      code: "DUPLICATE_TASK",
    },
    {
      label: "two-node cycle",
      plan: [
        { id: "TASK-002", dependsOn: ["TASK-003"] },
        { id: "TASK-003", dependsOn: ["TASK-002"] },
      ],
      code: "CYCLIC_DEPENDENCY",
    },
    {
      label: "self cycle",
      plan: [{ id: "TASK-002", dependsOn: ["TASK-002"] }],
      code: "CYCLIC_DEPENDENCY",
    },
  ])("rejects $label before append", ({ plan, code }) => {
    try {
      validateTaskPlan(state(task("TASK-001")), plan as never);
      throw new Error("expected graph rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskGraphError);
      expect((error as TaskGraphError).code).toBe(code);
    }
  });

  it("derives ready and unmet sets after dependency completion", () => {
    const before = state(
      task("TASK-001", "running"),
      task("TASK-002", "created", ["TASK-001"]),
      task("TASK-003", "created"),
    );
    expect(readyTaskIds(before)).toEqual(["TASK-003"]);
    expect(unmetDependencies(before, "TASK-002" as never)).toEqual(["TASK-001"]);
    expect(() => assertTaskReady(before, "TASK-002" as never)).toThrow(TaskNotReadyError);

    const after = state(
      task("TASK-001", "completed"),
      task("TASK-002", "created", ["TASK-001"]),
      task("TASK-003", "created"),
    );
    expect(readyTaskIds(after)).toEqual(["TASK-002", "TASK-003"]);
    expect(unmetDependencies(after, "TASK-002" as never)).toEqual([]);
    expect(() => assertTaskReady(after, "TASK-002" as never)).not.toThrow();
  });

  it.each(["failed", "cancelled"] as const)("%s dependencies remain unmet", (status) => {
    const projection = state(
      task("TASK-001", status),
      task("TASK-002", "created", ["TASK-001"]),
    );
    expect(readyTaskIds(projection)).toEqual([]);
    expect(unmetDependencies(projection, "TASK-002" as never)).toEqual(["TASK-001"]);
  });

  it("replay rejects task.assigned while a dependency is incomplete", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-os-graph-replay-")));
    roots.push(root);
    const store = openSqliteEventStore({ path: join(root, "events.sqlite") });
    const assigned = store.append(
      parseEventInput({
        type: "task.assigned",
        project: "proj_graph",
        actor: { kind: "system", id: "supervisor" },
        subject: { kind: "task", id: "TASK-002" },
        payload: { executor: "codex", matchedBy: "explicit" },
      }),
      { token: "assign" },
    );
    const projection = state(
      task("TASK-001", "running"),
      task("TASK-002", "created", ["TASK-001"]),
    );
    expect(() => reduceTaskProject(projection, assigned)).toThrow(TaskNotReadyError);
    store.close();
  });
});
