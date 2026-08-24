import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CanvasView, type ProjectCanvasViewModel } from "../src/Canvas.js";
import "../src/styles/global.css";

const canvas: ProjectCanvasViewModel = {
  projects: [
    {
      project: "proj_agent_os",
      name: "Agent OS",
      progress: 86,
      health: "attention",
      sourceEvents: ["evt_project"],
      nodes: [
        {
          id: "project:proj_agent_os",
          project: "proj_agent_os",
          kind: "project",
          label: "Agent OS",
          completed: false,
          sourceEvents: ["evt_project"],
        },
        {
          id: "goal:GOAL-LOCAL",
          project: "proj_agent_os",
          kind: "goal",
          label: "GOAL-LOCAL",
          completed: false,
          sourceEvents: ["evt_local"],
        },
        {
          id: "goal:GOAL-REMOTE",
          project: "proj_agent_os",
          kind: "goal",
          label: "GOAL-REMOTE",
          completed: false,
          sourceEvents: ["evt_remote"],
        },
        {
          id: "task:TASK-001",
          project: "proj_agent_os",
          kind: "task",
          label: "Local Agent flow",
          status: "completed",
          progress: 100,
          executor: "agent-codex",
          dependsOn: [],
          completed: true,
          sourceEvents: ["evt_task_1"],
        },
        {
          id: "task:TASK-002",
          project: "proj_agent_os",
          kind: "task",
          label: "Remote Agent flow",
          status: "running",
          progress: 72,
          executor: "agent-codex",
          dependsOn: ["task:TASK-001"],
          completed: false,
          sourceEvents: ["evt_task_2"],
        },
        {
          id: "agent:agent-codex",
          project: "proj_agent_os",
          kind: "agent",
          label: "Codex",
          status: "working",
          completed: false,
          sourceEvents: ["evt_agent"],
        },
        {
          id: "knowledge:KN-001",
          project: "proj_agent_os",
          kind: "knowledge",
          label: "MCP first",
          status: "decision",
          completed: false,
          sourceEvents: ["evt_knowledge"],
        },
        {
          id: "resource:architecture",
          project: "proj_agent_os",
          kind: "resource",
          label: "docs/architecture.md",
          completed: false,
          sourceEvents: ["evt_resource"],
        },
      ],
      edges: [
        {
          from: "task:TASK-001",
          to: "agent:agent-codex",
          relation: "causedBy",
          event: "evt_task_1",
          eventType: "task.created",
          sourceEvents: ["evt_task_1", "evt_agent"],
        },
        {
          from: "task:TASK-002",
          to: "task:TASK-001",
          relation: "causedBy",
          event: "evt_task_2",
          eventType: "task.created",
          sourceEvents: ["evt_task_2", "evt_task_1"],
        },
        {
          from: "knowledge:KN-001",
          to: "task:TASK-002",
          relation: "causedBy",
          event: "evt_knowledge",
          eventType: "knowledge.created",
          sourceEvents: ["evt_knowledge", "evt_task_2"],
        },
        {
          from: "resource:architecture",
          to: "knowledge:KN-001",
          relation: "causedBy",
          event: "evt_resource",
          eventType: "artifact.produced",
          sourceEvents: ["evt_resource", "evt_knowledge"],
        },
      ],
    },
    {
      project: "proj_remote_lab",
      name: "Remote Lab",
      progress: 38,
      health: "blocked",
      sourceEvents: ["evt_lab"],
      nodes: [],
      edges: [],
    },
  ],
};

const root = document.getElementById("root");
if (root === null) throw new Error("canvas preview root is missing");

createRoot(root).render(
  <StrictMode>
    <CanvasView canvas={canvas} locale="en" />
  </StrictMode>,
);
