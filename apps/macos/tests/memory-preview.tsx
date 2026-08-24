import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryView, type ProjectMemoryViewModel } from "../src/Memory.js";
import "../src/styles/global.css";

const memory: ProjectMemoryViewModel = {
  project: "proj_agent_os",
  results: [
    {
      item: {
        id: "KN-001",
        project: "proj_agent_os",
        type: "decision",
        title: "MCP is the collaboration layer",
        summary: "External agents enter through one protocol boundary.",
        rationale: "Provider-specific paths would fragment authorization and evidence.",
        sourceEvents: ["evt_architecture"],
        relatedTasks: ["TASK-008"],
        author: { kind: "human", id: "human-owner" },
        at: "2026-08-18T09:00:00Z",
        createdEvent: "evt_kn_1",
        createdSeq: 2,
        supersededBy: "KN-002",
      },
      relations: [
        {
          kind: "related-task",
          from: "KN-001",
          to: "TASK-008",
          relation: "related-task",
        },
        {
          kind: "superseded-by",
          from: "KN-001",
          to: "KN-002",
          relation: "superseded-by",
        },
      ],
    },
    {
      item: {
        id: "KN-002",
        project: "proj_agent_os",
        type: "decision",
        title: "MCP first, Local Runner before Remote",
        summary:
          "The local Agent call path establishes the contract before remote transport.",
        rationale: "Separate semantic correctness from network failure modes.",
        alternatives: ["Build both paths together"],
        sourceEvents: ["evt_runner_contract"],
        relatedTasks: ["TASK-014"],
        author: { kind: "human", id: "human-owner" },
        at: "2026-08-20T09:00:00Z",
        createdEvent: "evt_kn_2",
        createdSeq: 3,
        supersedes: "KN-001",
      },
      relations: [
        { kind: "supersedes", from: "KN-002", to: "KN-001", relation: "supersedes" },
        {
          kind: "related-task",
          from: "KN-002",
          to: "TASK-014",
          relation: "related-task",
        },
        {
          kind: "linked",
          from: "KN-002",
          to: "measurement-local-gate",
          relation: "validated-by",
          event: "evt_link",
        },
      ],
    },
    {
      item: {
        id: "KN-003",
        project: "proj_agent_os",
        type: "research",
        title: "Remote restart behavior",
        summary: "In-flight work requires an explicit recovery owner.",
        sourceEvents: ["evt_remote_test"],
        author: { kind: "agent", id: "agent-codex" },
        at: "2026-08-22T09:00:00Z",
        createdEvent: "evt_kn_3",
        createdSeq: 4,
      },
      relations: [],
    },
  ],
};

const root = document.getElementById("root");
if (root === null) throw new Error("memory preview root is missing");

createRoot(root).render(
  <StrictMode>
    <MemoryView memory={memory} locale="en" />
  </StrictMode>,
);
