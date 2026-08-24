import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "../apps/macos/node_modules/react-dom/server.js";
import React from "../apps/macos/node_modules/react/index.js";
import {
  AgentsView,
  type ProjectWorkforceViewModel,
  TasksView,
} from "../apps/macos/src/Workforce.js";

const WORKFORCE: ProjectWorkforceViewModel = {
  project: "proj_agent_os",
  observedAt: "2026-08-24T09:30:00Z",
  taskCounts: {
    all: 2,
    created: 1,
    assigned: 0,
    running: 0,
    blocked: 0,
    review: 1,
    completed: 0,
    failed: 0,
    cancelled: 0,
  },
  agentCounts: { logical: 1, connected: 1, available: 1, activeDispatches: 0 },
  tasks: [
    {
      task: "TASK-REVIEW",
      title: "Review local flow",
      goal: "Confirm irreversible behavior",
      status: "review",
      progress: 100,
      priority: "critical",
      owner: "human",
      executor: "agent-codex",
      requires: ["review"],
      assignment: { kind: "assigned", executor: "agent-codex" },
      awaitingHumanReview: true,
      sourceEvents: ["evt-review"],
    },
    {
      task: "TASK-DESIGN",
      title: "Prepare system design",
      goal: "Create the remote workflow",
      status: "created",
      progress: 15,
      priority: "high",
      owner: "supervisor",
      requires: ["design"],
      assignment: { kind: "no-capability", requiredCapabilities: ["design"] },
      awaitingHumanReview: false,
      sourceEvents: ["evt-task"],
    },
  ],
  agents: [
    {
      agent: "agent-codex",
      name: "Codex",
      provider: "mcp",
      role: "developer",
      concurrency: 2,
      availability: "available",
      active: 0,
      completed: 4,
      failed: 1,
      capabilities: ["coding", "review"],
      currentTasks: ["TASK-REVIEW"],
      placements: [
        {
          host: "mac-local",
          capabilities: ["coding", "review"],
          connected: true,
          accepting: true,
          active: 0,
          integration: {
            participates: true,
            streaming: true,
            reasoning: true,
            session: true,
            usage: true,
          },
          sourceEvents: ["evt-agent"],
        },
      ],
      sourceEvents: ["evt-agent"],
    },
  ],
  coverage: [
    {
      capability: "coding",
      covered: true,
      agents: ["agent-codex"],
      placements: 1,
      sourceEvents: ["evt-agent"],
    },
    { capability: "design", covered: false, agents: [], placements: 0, sourceEvents: [] },
  ],
  threads: { available: false },
};

describe("RM-3.6 Tasks and Agents macOS surfaces", () => {
  it("keeps 100% progress visibly in review and exposes no-capability diagnosis", () => {
    const html = renderToStaticMarkup(<TasksView workforce={WORKFORCE} locale="en" />);
    expect(html).toContain("100% progress still requires human review");
    expect(html).toContain("100%");
    expect(html).toContain("No agent has the required capability");
    expect(html).toContain("design");
  });

  it("renders logical agents, live placement state, and honest coverage gaps", () => {
    const html = renderToStaticMarkup(<AgentsView workforce={WORKFORCE} locale="en" />);
    expect(html).toContain("Logical agents");
    expect(html).toContain("Codex");
    expect(html).toContain("mac-local");
    expect(html).toContain("Accepting");
    expect(html).toContain("No live coverage");
    expect(html).not.toContain("heartbeat");
  });

  it("renders a truthful projection-pending state without sample data", () => {
    const tasks = renderToStaticMarkup(<TasksView workforce={null} locale="en" />);
    const agents = renderToStaticMarkup(<AgentsView workforce={null} locale="en" />);
    expect(tasks).toContain("Waiting for the workforce projection");
    expect(agents).toContain("no sample tasks or agents are inserted");
    expect(tasks).not.toContain("TASK-REVIEW");
  });
});
