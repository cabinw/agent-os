import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "../apps/macos/node_modules/react-dom/server.js";
import React from "../apps/macos/node_modules/react/index.js";
import { ProjectPulseView, type ProjectPulseViewModel } from "../apps/macos/src/Pulse.js";
import { CATALOG_KEYS } from "../apps/macos/src/i18n.js";

const EVENT = "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PULSE: ProjectPulseViewModel = {
  project: "proj_pulse",
  window: {
    startInclusive: "2026-08-24T00:00:00Z",
    endExclusive: "2026-08-25T00:00:00Z",
  },
  kpis: {
    activeAgents: { value: 1, sourceEvents: [EVENT] },
    activeTasks: { value: 2, sourceEvents: [EVENT] },
    doneToday: { value: 3, sourceEvents: [EVENT] },
    blockers: { value: 4, sourceEvents: [EVENT] },
  },
  topConsequence: {
    kind: "overdue-blocker",
    title: "Owner decision",
    detail: "Choose the storage boundary.",
    actionable: true,
    sourceEvents: [EVENT],
  },
  story: {
    headline: "Decision blocks the critical path",
    body: "One sourced decision is required.",
    at: "2026-08-24T12:00:00Z",
    sourceEvents: [EVENT],
  },
  progress: [
    {
      task: "TASK-001",
      title: "Local runtime",
      progress: 80,
      delta: 20,
      sourceEvents: [EVENT],
    },
  ],
  activity: [
    {
      event: EVENT,
      type: "task.progress.updated",
      actor: "agent-local",
      subject: "TASK-001",
      at: "2026-08-24T12:00:00Z",
      sourceEvents: [EVENT],
    },
  ],
  risks: [
    {
      task: "TASK-002",
      title: "Remote connection",
      reason: "Needs an owner decision",
      severity: "high",
      needs: "human",
      since: "2026-08-23T00:00:00Z",
      overdue: true,
      sourceEvents: [EVENT],
    },
  ],
  knowledge: [
    {
      knowledge: "KN-001",
      title: "MCP ingress",
      summary: "One collaboration layer remains canonical.",
      type: "decision",
      at: "2026-08-24T12:00:00Z",
      sourceEvents: [EVENT],
    },
  ],
  research: [
    {
      knowledge: "KN-002",
      title: "Latency study",
      summary: "Local dispatch stays under budget.",
      type: "research",
      at: "2026-08-24T12:00:00Z",
      sourceEvents: [EVENT],
    },
  ],
  moments: [
    {
      metric: "dispatch-latency",
      value: 18,
      unit: "ms",
      source: "benchmark",
      at: "2026-08-24T12:00:00Z",
      sourceEvents: [EVENT],
    },
  ],
};

describe("RM-3.3 · Project Pulse macOS surface", () => {
  it("renders four sourced KPIs, the top story, attention, and all six cards", () => {
    const html = renderToStaticMarkup(<ProjectPulseView pulse={PULSE} locale="en" />);

    for (const label of [
      "Active agents",
      "Active tasks",
      "Done today",
      "Current blockers",
      "Top Story",
      "Needs attention",
      "Progress",
      "Activity",
      "Risks and blockers",
      "Knowledge",
      "Research",
      "Key measurements",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Decision blocks the critical path");
    expect(html.match(/View events/g)).toHaveLength(12);
    expect(html).not.toContain(EVENT);
  });

  it("renders the same semantic surface in Chinese", () => {
    const html = renderToStaticMarkup(<ProjectPulseView pulse={PULSE} locale="zh-CN" />);
    expect(html).toContain("项目脉冲");
    expect(html).toContain("项目脉冲六张信息卡");
    expect(html).toContain("查看事件");
  });

  it("keeps the disconnected state honest with no invented KPI values", () => {
    const html = renderToStaticMarkup(<ProjectPulseView pulse={null} locale="zh-CN" />);
    expect(html).toContain("等待真实项目脉冲");
    expect(html).toContain("不会填充演示数字");
    expect(html).not.toContain("Active agents");
    expect(html).not.toMatch(/<strong>[0-9]+<\/strong>/);
  });

  it("keeps both strict catalogs synchronized after adding Pulse copy", () => {
    expect(CATALOG_KEYS).toHaveLength(60);
    expect(CATALOG_KEYS.filter((key) => key.startsWith("pulse."))).toHaveLength(23);
  });
});
