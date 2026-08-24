import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "../apps/macos/node_modules/react-dom/server.js";
import React from "../apps/macos/node_modules/react/index.js";
import {
  ProjectDetailPanel,
  type ProjectLibraryItemViewModel,
  ProjectLibraryView,
  type ProjectLibraryViewModel,
  createRevivalStepActivationIntent,
} from "../apps/macos/src/ProjectLibrary.js";

const PROJECT: ProjectLibraryItemViewModel = {
  project: "proj_library",
  name: "Agent OS",
  state: "paused",
  stack: ["TypeScript", "SQLite"],
  progress: 72,
  currentWork: {
    task: "TASK-014",
    title: "Build Project Library",
    status: "blocked",
    priority: "high",
    sourceEvents: ["evt_task"],
  },
  health: { status: "blocked", sourceEvents: ["evt_blocked"] },
  summary: {
    text: "The local-first foundation is ready for portfolio surfaces.",
    sourceEvents: ["evt_story", "evt_task"],
  },
  agents: [
    {
      id: "agent-codex",
      name: "Codex",
      status: "waiting",
      sourceEvents: ["evt_agent"],
    },
  ],
  lastActivity: {
    at: "2026-07-01T08:00:00Z",
    actor: "Codex",
    type: "task.blocked",
    sourceEvents: ["evt_blocked"],
  },
  dormantDays: 54,
  revival: {
    built: [
      {
        task: "TASK-001",
        title: "Event Core",
        status: "completed",
        priority: "high",
        sourceEvents: ["evt_completed"],
      },
    ],
    current: {
      state: "paused",
      progress: 72,
      health: "blocked",
      sourceEvents: ["evt_blocked"],
    },
    decisions: [
      {
        knowledge: "knowledge-1",
        type: "decision",
        title: "Use SQLite",
        summary: "Keep the store local.",
        rationale: "One native boundary is easier to audit.",
        at: "2026-06-29T08:00:00Z",
        sourceEvents: ["evt_decision"],
      },
    ],
    unfinished: [
      {
        task: "TASK-014",
        title: "Build Project Library",
        status: "blocked",
        priority: "high",
        sourceEvents: ["evt_blocked"],
      },
    ],
    issues: [
      {
        task: "TASK-014",
        title: "Build Project Library",
        kind: "blocked",
        reason: "Owner decision required",
        sourceEvents: ["evt_blocked"],
      },
    ],
    staleness: [
      {
        area: "dependencies",
        state: "stale",
        detail: "The lockfile no longer resolves.",
        sourceEvents: ["evt_environment"],
      },
      {
        area: "apis",
        state: "likely-stale",
        detail: null,
        sourceEvents: ["evt_blocked"],
      },
      {
        area: "credentials",
        state: "current",
        detail: "Credential validation succeeded.",
        sourceEvents: ["evt_environment"],
      },
    ],
    plan: [
      {
        title: "Check environment",
        estimateMinutes: 30,
        detail: "Run the build and verify credentials.",
        sourceEvents: ["evt_revived"],
      },
    ],
  },
  snapshots: [
    {
      label: "MVP",
      image: "snapshots/mvp.png",
      at: "2026-06-30T08:00:00Z",
      sourceEvents: ["evt_snapshot"],
    },
  ],
  nextSteps: [
    {
      title: "Check environment",
      estimateMinutes: 30,
      detail: "Run the build and verify credentials.",
      sourceEvents: ["evt_revived"],
    },
  ],
  timeline: [
    {
      event: "evt_blocked",
      type: "task.blocked",
      actor: "Codex",
      subject: "TASK-014",
      at: "2026-07-01T08:00:00Z",
      sourceEvents: ["evt_blocked"],
    },
  ],
  knowledge: [
    {
      knowledge: "knowledge-1",
      type: "decision",
      title: "Use SQLite",
      summary: "Keep the store local.",
      rationale: "One native boundary is easier to audit.",
      at: "2026-06-29T08:00:00Z",
      sourceEvents: ["evt_decision"],
    },
  ],
  files: [
    {
      path: "docs/architecture.md",
      kind: "document",
      task: "TASK-014",
      at: "2026-06-28T08:00:00Z",
      sourceEvents: ["evt_file"],
    },
  ],
};

const LIBRARY: ProjectLibraryViewModel = {
  now: "2026-08-24T12:00:00Z",
  counts: { all: 1, active: 0, paused: 1, archived: 0, completed: 0 },
  projects: [PROJECT],
  insights: null,
};

describe("RM-3.5 Project Library macOS surface", () => {
  it("renders state filters, five-column data and honest Insights status", () => {
    const html = renderToStaticMarkup(
      <ProjectLibraryView library={LIBRARY} locale="en" />,
    );
    expect(html).toContain("Five-column project list");
    expect(html).toContain("Agent OS");
    expect(html).toContain("72%");
    expect(html).toContain("Build Project Library");
    expect(html).toContain("TypeScript");
    expect(html).toContain("54 days ago");
    expect(html).toContain("Project Insights");
    expect(html).toContain("stay unavailable");
  });

  it("renders a truthful projection-pending state without project data", () => {
    const html = renderToStaticMarkup(<ProjectLibraryView library={null} locale="en" />);
    expect(html).toContain("Waiting for the project portfolio");
    expect(html).toContain("No sample projects are inserted");
    expect(html).not.toContain("Agent OS</strong>");
  });

  it("renders exactly five detail tabs and a sourced dormant Overview", () => {
    const html = renderToStaticMarkup(
      <ProjectDetailPanel
        project={PROJECT}
        now={LIBRARY.now}
        locale="en"
        onClose={() => {}}
      />,
    );
    for (const tab of ["Overview", "Timeline", "Memory", "Files", "Settings"]) {
      expect(html).toContain(`>${tab}<`);
    }
    expect(html).toContain("Revival Mode");
    expect(html).toContain("54 days without activity");
    expect(html).toContain("Completed");
    expect(html).toContain("Unfinished");
    expect(html).toContain("Known issues");
    expect(html).toContain("Past decisions");
    expect(html).toContain("Current state");
    expect(html).toContain("Recommended restart plan");
    expect(html).toContain("Environment status");
    expect(html).toContain("Verified stale");
    expect(html).toContain("Likely stale");
    expect(html).toContain("Verified current");
    expect(html).toContain("no environment check has verified it");
    expect(html).toContain("Check environment");
    expect(html).toContain("Create and assign restart step Check environment");
    expect(html).toContain("Visual checkpoints");
    expect(html).toContain('src="snapshots/mvp.png"');
    expect(html).toContain("View project snapshot MVP");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("Use SQLite");
    expect(html).toContain("Project selection is not connected");
  });

  it("creates a strict ordered step intent for the first connected executor", () => {
    const intent = createRevivalStepActivationIntent(PROJECT, 0);
    expect(intent).toEqual({
      project: "proj_library",
      ordinal: 1,
      executor: "agent-codex",
      title: "Check environment",
      estimateMinutes: 30,
      detail: "Run the build and verify credentials.",
    });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.keys(intent)).toEqual([
      "project",
      "ordinal",
      "executor",
      "title",
      "estimateMinutes",
      "detail",
    ]);
  });

  it("renders honest empty Overview sections", () => {
    const sparse = {
      ...PROJECT,
      state: "active" as const,
      dormantDays: 0,
      revival: null,
      summary: null,
      snapshots: [],
      nextSteps: [],
      knowledge: [],
      files: [],
    };
    const html = renderToStaticMarkup(
      <ProjectDetailPanel
        project={sparse}
        now={LIBRARY.now}
        locale="en"
        onClose={() => {}}
      />,
    );
    expect(html).toContain("No sourced pulse story");
    expect(html).toContain("No durable revival plan");
    expect(html).toContain("No project snapshots");
    expect(html).not.toContain("Revival Mode");
  });
});
