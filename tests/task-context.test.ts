import { describe, expect, it } from "vitest";
import { newEventId } from "../packages/event-core/src/index.js";
import type { KnowledgeId, ProjectId, TaskId } from "../packages/event-core/src/index.js";
import { TaskContextError, buildTaskContext } from "../packages/mcp-server/src/index.js";
import type {
  KnowledgeItem,
  KnowledgeProjectState,
} from "../packages/memory-core/src/index.js";
import type { TaskProjectState, TaskState } from "../packages/task-engine/src/index.js";

const PROJECT = "proj_context" as ProjectId;

function task(idValue: string, overrides: Partial<TaskState> = {}): TaskState {
  const id = idValue as TaskId;
  return {
    id,
    project: PROJECT,
    title: `Task ${id}`,
    goal: "GOAL-001",
    status: "created",
    progress: 0,
    priority: "medium",
    requires: [],
    owner: "supervisor",
    dependsOn: [],
    outputs: [],
    requiresApproval: false,
    createdAt: "2026-08-24T12:00:00.000Z",
    ...overrides,
  } as TaskState;
}

function completedTask(id: string, dependsOn: readonly TaskId[] = []): TaskState {
  return task(id, {
    status: "completed",
    progress: 100,
    executor: "worker",
    dependsOn,
    outputs: [`artifact:${id}`],
    startedAt: "2026-08-24T12:01:00.000Z",
    reviewSummary: `Accepted ${id}`,
    reviewedAt: "2026-08-24T12:02:00.000Z",
    acceptedBy: "owner",
    terminalAt: "2026-08-24T12:03:00.000Z",
  });
}

function knowledge(
  idValue: string,
  createdSeq: number,
  overrides: Partial<KnowledgeItem> = {},
): KnowledgeItem {
  const id = idValue as KnowledgeId;
  return {
    id,
    project: PROJECT,
    type: "decision",
    title: `Decision ${id}`,
    summary: `Summary ${id}`,
    rationale: `Rationale ${id}`,
    sourceEvents: [newEventId()],
    author: { kind: "agent", id: "architect" as never },
    at: "2026-08-24T12:00:00.000Z",
    createdEvent: newEventId(),
    createdSeq,
    ...overrides,
  } as KnowledgeItem;
}

function source(
  taskItems: readonly TaskState[],
  knowledgeItems: readonly KnowledgeItem[],
  include: readonly ("decisions" | "outputs")[] = ["decisions", "outputs"],
) {
  return {
    project: PROJECT,
    request: { task: "TASK-001" as TaskId, include },
    tasks: {
      tasks: Object.fromEntries(taskItems.map((item) => [item.id, item])),
    } as TaskProjectState,
    memory: {
      items: Object.fromEntries(knowledgeItems.map((item) => [item.id, item])),
    } as KnowledgeProjectState,
  };
}

describe("RM-2.4 · relevance-bounded task context", () => {
  it("composes transitive dependency outputs and active structurally related decisions", () => {
    const fourth = completedTask("TASK-004");
    const second = completedTask("TASK-002", [fourth.id]);
    const third = completedTask("TASK-003", [fourth.id]);
    const target = task("TASK-001", { dependsOn: [third.id, second.id] });
    const unrelated = task("TASK-005");
    const projectWide = knowledge("KN-001", 1);
    const upstream = knowledge("KN-002", 2, { relatedTasks: [second.id] });
    const unrelatedDecision = knowledge("KN-003", 3, {
      relatedTasks: [unrelated.id],
    });
    const old = knowledge("KN-004", 4, {
      relatedTasks: [target.id],
      supersededBy: "KN-005" as KnowledgeId,
    });
    const active = knowledge("KN-005", 5, {
      relatedTasks: [target.id],
      supersedes: old.id,
    });
    const researchDecision = knowledge("KN-006", 6);
    const { rationale: _rationale, ...researchBase } = researchDecision;
    const research = {
      ...researchBase,
      type: "research",
      relatedTasks: [target.id],
    } as KnowledgeItem;

    const result = buildTaskContext(
      source(
        [target, second, third, fourth, unrelated],
        [active, research, unrelatedDecision, old, upstream, projectWide],
      ),
    );

    expect(result.included).toEqual(["decisions", "outputs"]);
    expect(result.scopeTasks).toEqual(["TASK-001", "TASK-004", "TASK-002", "TASK-003"]);
    expect(result.decisions.map((item) => item.id)).toEqual([
      "KN-001",
      "KN-002",
      "KN-005",
    ]);
    expect(result.outputs.map((item) => item.task)).toEqual([
      "TASK-004",
      "TASK-002",
      "TASK-003",
    ]);
    expect(result.outputs[0]).toEqual({
      task: "TASK-004",
      title: "Task TASK-004",
      summary: "Accepted TASK-004",
      outputs: ["artifact:TASK-004"],
    });
  });

  it("canonicalizes include order and returns stable empty unrequested sections", () => {
    const result = buildTaskContext(
      source([task("TASK-001")], [knowledge("KN-001", 1)], ["outputs"]),
    );
    expect(result.included).toEqual(["outputs"]);
    expect(result.decisions).toEqual([]);
    expect(result.outputs).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.task)).toBe(true);
    expect(Object.isFrozen(result.scopeTasks)).toBe(true);
  });

  it("does not truncate an old relevant decision behind large unrelated knowledge", () => {
    const target = task("TASK-001");
    const unrelated = task("TASK-999");
    const planted = knowledge("KN-001", 1, {
      title: "青铜麋鹿",
      summary: "Port 7734 belongs to Vera",
      relatedTasks: [target.id],
    });
    const haystack = Array.from({ length: 200 }, (_, index) =>
      knowledge(`KN-${String(index + 2).padStart(3, "0")}`, index + 2, {
        relatedTasks: [unrelated.id],
      }),
    );
    const result = buildTaskContext(source([target, unrelated], [planted, ...haystack]));
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      title: "青铜麋鹿",
      summary: "Port 7734 belongs to Vera",
    });
  });

  it("includes only completed upstream outputs", () => {
    const completed = completedTask("TASK-002");
    const review = task("TASK-003", {
      status: "review",
      progress: 100,
      executor: "worker",
      startedAt: "2026-08-24T12:01:00.000Z",
      reviewSummary: "Not accepted yet",
      reviewedAt: "2026-08-24T12:02:00.000Z",
      outputs: ["candidate"],
    });
    const target = task("TASK-001", { dependsOn: [completed.id, review.id] });
    const result = buildTaskContext(source([target, completed, review], []));
    expect(result.outputs.map((item) => item.task)).toEqual(["TASK-002"]);
  });

  it.each([
    ["missing target", source([], []), "MISSING_TASK"],
    [
      "missing dependency",
      source([task("TASK-001", { dependsOn: ["TASK-002" as TaskId] })], []),
      "INVALID_TASK_GRAPH",
    ],
    [
      "cyclic dependency",
      source(
        [
          task("TASK-001", { dependsOn: ["TASK-002" as TaskId] }),
          task("TASK-002", { dependsOn: ["TASK-001" as TaskId] }),
        ],
        [],
      ),
      "INVALID_TASK_GRAPH",
    ],
    [
      "dangling knowledge relation",
      source(
        [task("TASK-001")],
        [knowledge("KN-001", 1, { relatedTasks: ["TASK-999" as TaskId] })],
      ),
      "INVALID_MEMORY_RELATION",
    ],
  ] as const)("fails closed for %s", (_label, value, code) => {
    expect(() => buildTaskContext(value)).toThrowError(
      expect.objectContaining({ name: "TaskContextError", code }),
    );
  });

  it("rejects a completed dependency without an accepted result summary", () => {
    const malformed = completedTask("TASK-002");
    const { reviewSummary: _summary, ...withoutSummary } = malformed;
    const target = task("TASK-001", { dependsOn: [malformed.id] });
    expect(() =>
      buildTaskContext(source([target, withoutSummary as TaskState], [])),
    ).toThrowError(expect.objectContaining({ code: "INVALID_OUTPUT" }));
  });

  it("maps malformed domain snapshots without leaking parser errors", () => {
    const valid = source([task("TASK-001")], []);
    expect(() =>
      buildTaskContext({
        ...valid,
        tasks: { tasks: { "TASK-001": { injected: true } } } as never,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TASK_STATE" }));
    expect(() =>
      buildTaskContext({
        ...valid,
        memory: { items: { "KN-001": { injected: true } } } as never,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_MEMORY_STATE" }));
  });

  it("rejects non-canonical include values and unknown source fields", () => {
    const valid = source([task("TASK-001")], []);
    expect(() =>
      buildTaskContext({
        ...valid,
        request: { task: "TASK-001", include: ["messages"] },
      } as never),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => buildTaskContext({ ...valid, limit: 10 } as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("exposes stable error identity", () => {
    expect(new TaskContextError("MISSING_TASK", "missing", "TASK-001")).toMatchObject({
      name: "TaskContextError",
      code: "MISSING_TASK",
      entityId: "TASK-001",
    });
  });
});
