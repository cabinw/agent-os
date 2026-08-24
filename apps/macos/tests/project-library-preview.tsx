import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type {
  ProjectLibraryItemViewModel,
  ProjectLibraryViewModel,
} from "../src/ProjectLibrary.js";
import "../src/styles/global.css";

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
    <App library={library} />
  </StrictMode>,
);
