import { describe, expect, it } from "vitest";
import type { Capability } from "../packages/event-core/src/index.js";
import {
  type AgentPerformanceError,
  deriveAgentPerformance,
  performanceForCapabilities,
} from "../packages/task-engine/src/index.js";
import type {
  TaskProjectState,
  TaskState,
  TaskStatus,
} from "../packages/task-engine/src/index.js";

const PROJECT = "proj_performance";

function task(
  id: string,
  executor: string,
  status: TaskStatus,
  requires: readonly Capability[],
  startedAt = "2026-08-24T04:00:00Z",
  terminalAt = "2026-08-24T04:00:01Z",
): TaskState {
  const terminal = status === "completed" || status === "failed";
  return {
    id,
    project: PROJECT,
    title: id,
    goal: id,
    status,
    progress: status === "completed" ? 100 : 50,
    priority: "medium",
    requires,
    owner: "supervisor",
    executor,
    dependsOn: [],
    outputs: [],
    requiresApproval: false,
    createdAt: "2026-08-24T03:59:00Z",
    startedAt,
    ...(status === "completed" ? { acceptedBy: "supervisor" } : {}),
    ...(status === "failed" ? { failure: { reason: "failed", attempts: 1 } } : {}),
    ...(status === "cancelled"
      ? { cancellation: { by: "supervisor", reason: "cancelled" } }
      : {}),
    ...(terminal || status === "cancelled" ? { terminalAt } : {}),
  } as TaskState;
}

function project(...items: TaskState[]): TaskProjectState {
  return { tasks: Object.fromEntries(items.map((item) => [item.id, item])) };
}

describe("RM-5.4 · derived agent performance", () => {
  it("attributes terminal results and durations to every required capability", () => {
    const report = deriveAgentPerformance(
      project(
        task("TASK-001", "beta", "completed", ["coding", "testing"]),
        task(
          "TASK-002",
          "beta",
          "failed",
          ["testing"],
          "2026-08-24T04:00:00Z",
          "2026-08-24T04:00:03Z",
        ),
        task("TASK-003", "beta", "running", ["research"]),
        task("TASK-004", "beta", "cancelled", ["analysis"]),
      ),
    );

    expect(report.agents.beta?.overall).toMatchObject({
      completed: 1,
      failed: 1,
      samples: 2,
      successScore: 0.5,
      averageDurationMs: 2000,
    });
    expect(report.agents.beta?.capabilities.coding).toMatchObject({
      completed: 1,
      failed: 0,
      successScore: 2 / 3,
      averageDurationMs: 1000,
    });
    expect(report.agents.beta?.capabilities.testing).toMatchObject({
      completed: 1,
      failed: 1,
      averageDurationMs: 2000,
    });
    expect(report.agents.beta?.capabilities).not.toHaveProperty("research");
    expect(report.agents.beta?.capabilities).not.toHaveProperty("analysis");
  });

  it("returns stable agent and controlled capability order with frozen output", () => {
    const report = deriveAgentPerformance(
      project(
        task("TASK-002", "beta", "completed", ["testing", "coding"]),
        task("TASK-001", "alpha", "completed", ["research"]),
      ),
    );
    expect(Object.keys(report.agents)).toEqual(["alpha", "beta"]);
    expect(Object.keys(report.agents.beta?.capabilities ?? {})).toEqual([
      "coding",
      "testing",
    ]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.agents.beta?.overall)).toBe(true);
  });

  it("uses neutral smoothing for unseen capabilities and overall zero samples", () => {
    const report = deriveAgentPerformance(
      project(task("TASK-001", "alpha", "running", ["coding"])),
    );
    expect(report.agents.alpha?.overall.successScore).toBe(0.5);
    expect(performanceForCapabilities(report, "alpha", ["testing"])).toEqual({
      capabilities: [
        {
          capability: "testing",
          completed: 0,
          failed: 0,
          samples: 0,
          successScore: 0.5,
          durationSamples: 0,
          averageDurationMs: null,
        },
      ],
      successScore: 0.5,
    });
    expect(performanceForCapabilities(report, "alpha", []).successScore).toBe(0.5);
  });

  it("rejects impossible terminal duration evidence", () => {
    const invalid = task(
      "TASK-001",
      "alpha",
      "completed",
      ["coding"],
      "2026-08-24T04:00:02Z",
      "2026-08-24T04:00:01Z",
    );
    expect(() => deriveAgentPerformance(project(invalid))).toThrowError(
      expect.objectContaining<Partial<AgentPerformanceError>>({
        code: "INVALID_DURATION",
        task: "TASK-001",
      }),
    );
  });
});
