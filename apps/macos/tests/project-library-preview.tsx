import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type {
  ProjectLibraryItemViewModel,
  ProjectLibraryViewModel,
} from "../src/ProjectLibrary.js";
import "../src/styles/global.css";

const SNAPSHOT_ONE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='960' height='540'%3E%3Crect width='960' height='540' fill='%23151a24'/%3E%3Crect x='64' y='64' width='832' height='412' rx='24' fill='%23232a38' stroke='%237c6df2' stroke-width='4'/%3E%3Ctext x='96' y='140' fill='white' font-size='38' font-family='sans-serif'%3EAgent OS · MVP%3C/text%3E%3Ctext x='96' y='205' fill='%23aab2c3' font-size='24' font-family='sans-serif'%3EEvent Core and local runtime ready%3C/text%3E%3C/svg%3E";
const SNAPSHOT_TWO =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='960' height='540'%3E%3Crect width='960' height='540' fill='%23151a24'/%3E%3Crect x='64' y='64' width='832' height='412' rx='24' fill='%23232a38' stroke='%234ac7a5' stroke-width='4'/%3E%3Ctext x='96' y='140' fill='white' font-size='38' font-family='sans-serif'%3EAgent OS · Revival%3C/text%3E%3Ctext x='96' y='205' fill='%23aab2c3' font-size='24' font-family='sans-serif'%3ESourced report and restart plan%3C/text%3E%3C/svg%3E";

const base: ProjectLibraryItemViewModel = {
  project: "proj_agent_os",
  name: "Agent OS",
  state: "paused",
  stack: ["TypeScript", "SQLite", "Tauri"],
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
      image: SNAPSHOT_TWO,
      at: "2026-06-30T08:00:00Z",
      sourceEvents: ["evt_snapshot"],
    },
    {
      label: "Foundation",
      image: SNAPSHOT_ONE,
      at: "2026-05-30T08:00:00Z",
      sourceEvents: ["evt_snapshot_foundation"],
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

const active: ProjectLibraryItemViewModel = {
  ...base,
  project: "proj_runner",
  name: "Remote Runner",
  state: "active",
  progress: 88,
  health: { status: "healthy", sourceEvents: ["evt_runner"] },
  summary: null,
  currentWork: {
    task: "TASK-021",
    title: "Verify Windows worker",
    status: "running",
    priority: "high",
    sourceEvents: ["evt_runner"],
  },
  lastActivity: {
    at: "2026-08-24T10:00:00Z",
    actor: "Server Engineer",
    type: "task.progress.updated",
    sourceEvents: ["evt_runner"],
  },
  dormantDays: 0,
  revival: null,
  snapshots: [],
  nextSteps: [],
};

const completed: ProjectLibraryItemViewModel = {
  ...base,
  project: "proj_demo",
  name: "Core Demo",
  state: "completed",
  progress: 100,
  currentWork: null,
  health: { status: "healthy", sourceEvents: ["evt_demo"] },
  lastActivity: {
    at: "2026-08-20T10:00:00Z",
    actor: "Supervisor",
    type: "task.completed",
    sourceEvents: ["evt_demo"],
  },
  dormantDays: 4,
  revival: null,
};

const library: ProjectLibraryViewModel = {
  now: "2026-08-24T12:00:00Z",
  counts: { all: 3, active: 1, paused: 1, archived: 0, completed: 1 },
  projects: [active, completed, base],
  insights: null,
};

const root = document.querySelector("#root");
if (root === null) throw new Error("missing Project Library preview root");

createRoot(root).render(
  <StrictMode>
    <App library={library} revivalStepClient={{ createAndAssignStep: async () => {} }} />
  </StrictMode>,
);
