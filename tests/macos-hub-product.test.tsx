import { describe, expect, it } from "vitest";
import { conversationFromHub, workforceFromHub } from "../apps/macos/src/HubProduct.js";

const SNAPSHOT: Parameters<typeof workforceFromHub>[0] = {
  agents: [
    {
      id: "codex",
      label: "Codex",
      role: "worker",
      capabilities: ["coding", "testing"],
      busy: true,
      hasSession: true,
      integration: {
        participates: true,
        streaming: true,
        reasoning: false,
        session: true,
        usage: true,
      },
    },
  ],
  thread: {
    tasks: {
      "TASK-001": {
        id: "TASK-001",
        title: "Ship the product entry",
        status: "review",
        requires: ["coding"],
        executor: "codex",
      },
    },
    items: [
      {
        kind: "lifecycle",
        id: "evt-started",
        seq: 1,
        at: "2026-08-26T07:00:00Z",
        task: "TASK-001",
        status: "running",
        actorKind: "system",
      },
      {
        kind: "message",
        id: "evt-review",
        seq: 2,
        at: "2026-08-26T07:01:00Z",
        task: "TASK-001",
        actorKind: "agent",
        from: "codex",
        to: "you",
        messageType: "review",
        text: "The product entry is ready.",
        causedBy: "evt-started",
      },
      {
        kind: "lifecycle",
        id: "evt-requested",
        seq: 3,
        at: "2026-08-26T07:02:00Z",
        task: "TASK-001",
        status: "review",
        actorKind: "agent",
      },
    ],
  },
};

describe("macOS live Hub product adapter", () => {
  it("maps real Hub tasks and agents without inserting sample records", () => {
    const workforce = workforceFromHub(SNAPSHOT);
    expect(workforce.project).toBe("proj_hub");
    expect(workforce.taskCounts.review).toBe(1);
    expect(workforce.tasks[0]).toMatchObject({
      task: "TASK-001",
      progress: 100,
      awaitingHumanReview: true,
      executor: "codex",
    });
    expect(workforce.tasks[0]?.sourceEvents).toEqual([
      "evt-started",
      "evt-review",
      "evt-requested",
    ]);
    expect(workforce.agents[0]).toMatchObject({
      agent: "codex",
      availability: "saturated",
      currentTasks: ["TASK-001"],
    });
  });

  it("weaves the Hub projection into the shared task conversation reader shape", () => {
    const conversation = conversationFromHub(SNAPSHOT);
    const thread = conversation.threads["TASK-001"];
    expect(thread).toMatchObject({
      task: "TASK-001",
      status: "review",
      progress: 100,
      executor: "codex",
    });
    expect(thread?.items.map((item) => item.kind)).toEqual([
      "divider",
      "message",
      "divider",
    ]);
    expect(thread?.items[1]).toMatchObject({
      kind: "message",
      event: {
        id: "evt-review",
        type: "message.sent",
        payload: {
          from: "codex",
          to: "you",
          type: "review",
          content: "The product entry is ready.",
          replyTo: "evt-started",
        },
      },
    });
  });
});
