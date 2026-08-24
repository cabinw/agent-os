import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCoreDemo } from "../apps/core-demo/src/index.js";
import { openSqliteEventStore } from "../packages/event-store-sqlite/src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function databasePath(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-os-core-demo-test-")));
  roots.push(root);
  return join(root, "events.sqlite");
}

describe("RM-1.5c · formal Phase 1 core demo", () => {
  it("runs the complete headless loop and returns event-log evidence", async () => {
    const path = databasePath();
    const evidence = await runCoreDemo({ databasePath: path });

    expect(evidence).toEqual({
      project: "proj_phase1_demo",
      task: "TASK-001",
      executor: "worker",
      approval: "approval-001",
      eventTypes: [
        "message.sent",
        "agent.registered",
        "agent.registered",
        "task.created",
        "knowledge.created",
        "task.assigned",
        "task.started",
        "task.progress.updated",
        "approval.requested",
        "approval.granted",
        "task.progress.updated",
        "task.review.requested",
        "task.completed",
      ],
      eventCount: 13,
      taskStatus: "completed",
      taskProgress: 100,
      approvalStatus: "granted",
      liveEqualsReplay: true,
      runnerEvents: ["started", "completed"],
    });

    const store = openSqliteEventStore({ path });
    const events = store.read("proj_phase1_demo" as never);
    expect(events).toHaveLength(13);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 13 }, (_, index) => index + 1),
    );
    expect(events[4]).toMatchObject({
      type: "knowledge.created",
      causedBy: events[0]?.id,
      payload: {
        sourceEvents: [events[0]?.id],
        relatedTasks: ["TASK-001"],
      },
    });
    expect(events[5]).toMatchObject({
      type: "task.assigned",
      payload: { executor: "worker", matchedBy: "capability" },
    });
    expect(events[12]).toMatchObject({
      type: "task.completed",
      actor: { kind: "human", id: "owner" },
      causedBy: events[11]?.id,
    });
    store.close();
  });

  it("fails before opening storage when the composition options are invalid", async () => {
    await expect(runCoreDemo({ databasePath: "" })).rejects.toThrow(
      "absolute databasePath",
    );
    await expect(runCoreDemo(null as never)).rejects.toThrow("absolute databasePath");
  });
});
