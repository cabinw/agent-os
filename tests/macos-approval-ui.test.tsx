import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "../apps/macos/node_modules/react-dom/server.js";
import React from "../apps/macos/node_modules/react/index.js";
import {
  ApprovalCenter,
  type ApprovalCenterViewModel,
} from "../apps/macos/src/ApprovalCenter.js";
import { MenuBarPanel } from "../apps/macos/src/MenuBar.js";
import {
  type MenuBarPresentation,
  admitMenuBarIntent,
  toMenuBarPresentation,
} from "../apps/macos/src/menu-bar.js";

const APPROVALS: ApprovalCenterViewModel = Object.freeze({
  project: "project-1",
  icon: "attention",
  pendingCount: 2,
  blockerCount: 1,
  approvals: Object.freeze([
    Object.freeze({
      approval: "approval-safe",
      project: "project-1",
      status: "pending",
      action: "Restart preview worker",
      detail: "Restart one reversible preview worker.",
      risk: "medium",
      reversible: true,
      requestedBy: "agent-1",
      task: "task-1",
      requestedAt: "2026-08-24T08:00:00.000Z",
      menuAction: "quick-decision",
      sourceEvents: Object.freeze(["event-safe"]),
    }),
    Object.freeze({
      approval: "approval-critical",
      project: "project-1",
      status: "pending",
      action: "Delete production data",
      detail: "Permanently delete the production dataset.",
      risk: "critical",
      reversible: false,
      requestedBy: "agent-2",
      requestedAt: "2026-08-24T08:01:00.000Z",
      menuAction: "review-in-app",
      sourceEvents: Object.freeze(["event-critical"]),
    }),
  ]),
});

function menu(decisionsEnabled = true): MenuBarPresentation {
  return toMenuBarPresentation(APPROVALS, null, decisionsEnabled);
}

describe("RM-3.4 approval surfaces", () => {
  it("renders complete disclosure and evidence in the in-app center", () => {
    const html = renderToStaticMarkup(
      <ApprovalCenter
        view={APPROVALS}
        locale="en"
        preferredApproval="approval-critical"
        onClose={() => {}}
      />,
    );
    expect(html).toContain("Delete production data");
    expect(html).toContain("Permanently delete the production dataset.");
    expect(html).toContain("Critical");
    expect(html).toContain("event-critical");
    expect(html).toContain("trusted human decision client is not connected");
    expect(html).not.toContain(">Approve<");
  });

  it("renders honest projection-pending and empty states", () => {
    const pending = renderToStaticMarkup(
      <ApprovalCenter view={null} locale="en" onClose={() => {}} />,
    );
    const empty = renderToStaticMarkup(
      <ApprovalCenter
        view={{ ...APPROVALS, pendingCount: 0, blockerCount: 0, approvals: [] }}
        locale="en"
        onClose={() => {}}
      />,
    );
    expect(pending).toContain("Approval projection pending");
    expect(empty).toContain("No approvals are waiting");
  });

  it("derives a compact menu projection without dropping safety policy", () => {
    expect(menu()).toMatchObject({
      icon: "attention",
      project: "project-1",
      pendingCount: 2,
      blockerCount: 1,
      decisionsEnabled: true,
    });
    expect(
      menu().approvals.map(({ approval, menuAction }) => [approval, menuAction]),
    ).toEqual([
      ["approval-safe", "quick-decision"],
      ["approval-critical", "review-in-app"],
    ]);
  });

  it("admits safe grant and reasoned rejection only", () => {
    expect(
      admitMenuBarIntent(menu(), { action: "grant", approval: "approval-safe" }),
    ).toEqual({ action: "grant", approval: "approval-safe" });
    expect(
      admitMenuBarIntent(menu(), {
        action: "reject",
        approval: "approval-safe",
        reason: "The preview is still serving traffic.",
      }),
    ).toEqual({
      action: "reject",
      approval: "approval-safe",
      reason: "The preview is still serving traffic.",
    });
  });

  it("rejects irreversible quick decisions, blank reasons and injected fields", () => {
    expect(() =>
      admitMenuBarIntent(menu(), { action: "grant", approval: "approval-critical" }),
    ).toThrow(/in-app review/);
    expect(() =>
      admitMenuBarIntent(menu(), {
        action: "reject",
        approval: "approval-safe",
        reason: "   ",
      }),
    ).toThrow(/reason is required/);
    expect(() =>
      admitMenuBarIntent(menu(), {
        action: "grant",
        approval: "approval-safe",
        actor: "human-1",
      }),
    ).toThrow(/unknown fields/);
    expect(() =>
      admitMenuBarIntent(menu(false), { action: "grant", approval: "approval-safe" }),
    ).toThrow(/unavailable/);
  });

  it("renders safe controls but forces critical review into the app", () => {
    const html = renderToStaticMarkup(<MenuBarPanel initialView={menu()} locale="en" />);
    expect(html).toContain("Restart preview worker");
    expect(html).toContain("Delete production data");
    expect(html).toContain("Review in app");
    expect(html).toContain("Reject");
    expect(html).toContain("Grant");
  });
});
