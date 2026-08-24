import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  ApprovalCenter,
  type ApprovalCenterViewModel,
  type ApprovalSurfaceIntent,
} from "../src/ApprovalCenter.js";
import "../src/styles/global.css";

declare global {
  interface Window {
    approvalIntents: ApprovalSurfaceIntent[];
  }
}

window.approvalIntents = [];

const view: ApprovalCenterViewModel = {
  project: "Agent OS",
  icon: "attention",
  pendingCount: 2,
  blockerCount: 1,
  approvals: [
    {
      approval: "apr_preview_restart",
      project: "Agent OS",
      status: "pending",
      action: "Restart preview worker",
      detail: "Restart one reversible preview worker after its health check failed.",
      risk: "medium",
      reversible: true,
      requestedBy: "Supervisor",
      task: "RM-3.4",
      requestedAt: "2026-08-24T08:00:00.000Z",
      menuAction: "quick-decision",
      sourceEvents: ["evt_preview_requested"],
    },
    {
      approval: "apr_production_delete",
      project: "Agent OS",
      status: "pending",
      action: "Delete production data",
      detail: "Permanently delete the production dataset and all retained snapshots.",
      risk: "critical",
      reversible: false,
      requestedBy: "Migration Agent",
      task: "RM-3.4",
      requestedAt: "2026-08-24T08:01:00.000Z",
      menuAction: "review-in-app",
      sourceEvents: ["evt_delete_requested", "evt_task_blocked"],
    },
  ],
};

const root = document.querySelector("#root");
if (root === null) throw new Error("missing approval preview root");

createRoot(root).render(
  <StrictMode>
    <ApprovalCenter
      view={view}
      locale="en"
      client={{
        decide: (intent) => {
          window.approvalIntents.push(intent);
          document.body.dataset.lastIntent = JSON.stringify(intent);
        },
      }}
      onClose={() => {}}
    />
  </StrictMode>,
);
