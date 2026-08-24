import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProjectPulseView, type ProjectPulseViewModel } from "../src/Pulse.js";
import "../src/styles/global.css";

const EVENT = "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const sourced = { sourceEvents: [EVENT] } as const;
const pulse: ProjectPulseViewModel = {
  project: "proj_pulse",
  window: {
    startInclusive: "2026-08-24T00:00:00Z",
    endExclusive: "2026-08-25T00:00:00Z",
  },
  kpis: {
    activeAgents: { value: 3, ...sourced },
    activeTasks: { value: 7, ...sourced },
    doneToday: { value: 2, ...sourced },
    blockers: { value: 1, ...sourced },
  },
  topConsequence: {
    kind: "overdue-blocker",
    title: "Owner decision blocks remote dispatch",
    detail: "Choose the credential boundary before remote activation.",
    actionable: true,
    ...sourced,
  },
  story: {
    headline: "Local agent flow is ready for integration",
    body: "The sourced runtime path passed its focused checks; remote work remains gated.",
    at: "2026-08-24T12:00:00Z",
    ...sourced,
  },
  progress: [
    { task: "TASK-001", title: "Local runtime", progress: 80, delta: 20, ...sourced },
  ],
  activity: [
    {
      event: EVENT,
      type: "task.progress.updated",
      actor: "agent-local",
      subject: "TASK-001",
      at: "2026-08-24T12:00:00Z",
      ...sourced,
    },
  ],
  risks: [
    {
      task: "TASK-002",
      title: "Remote activation",
      reason: "Needs an owner decision",
      severity: "high",
      needs: "human",
      since: "2026-08-23T00:00:00Z",
      overdue: true,
      ...sourced,
    },
  ],
  knowledge: [
    {
      knowledge: "KN-001",
      title: "MCP-only ingress",
      summary: "One collaboration layer remains canonical.",
      type: "decision",
      at: "2026-08-24T12:00:00Z",
      ...sourced,
    },
  ],
  research: [
    {
      knowledge: "KN-002",
      title: "Dispatch latency study",
      summary: "Local dispatch stays under budget.",
      type: "research",
      at: "2026-08-24T12:00:00Z",
      ...sourced,
    },
  ],
  moments: [
    {
      metric: "dispatch-latency",
      value: 18,
      unit: "ms",
      source: "benchmark",
      at: "2026-08-24T12:00:00Z",
      ...sourced,
    },
  ],
};

const root = document.getElementById("root");
if (root === null) throw new Error("Pulse fixture root is missing");

createRoot(root).render(
  <StrictMode>
    <ProjectPulseView pulse={pulse} locale="en" />
  </StrictMode>,
);
