import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MenuBarPanel } from "../src/MenuBar.js";
import type { MenuBarPresentation } from "../src/menu-bar.js";
import "../src/styles/global.css";
import "../src/styles/menu-bar-global.css";

const view: MenuBarPresentation = {
  icon: "attention",
  project: "Agent OS",
  activeAgents: 3,
  activeTasks: 7,
  blockerCount: 1,
  pendingCount: 2,
  decisionsEnabled: true,
  approvals: [
    {
      approval: "apr_preview_restart",
      action: "Restart preview worker",
      requestedBy: "Supervisor",
      risk: "medium",
      menuAction: "quick-decision",
    },
    {
      approval: "apr_production_delete",
      action: "Delete production data",
      requestedBy: "Migration Agent",
      risk: "critical",
      menuAction: "review-in-app",
    },
  ],
};

const root = document.querySelector("#root");
if (root === null) throw new Error("missing menu-bar preview root");

createRoot(root).render(
  <StrictMode>
    <MenuBarPanel initialView={view} locale="en" />
  </StrictMode>,
);
