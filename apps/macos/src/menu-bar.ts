import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ApprovalCenterViewModel,
  ApprovalSurfaceClient,
  ApprovalSurfaceIntent,
} from "./ApprovalCenter.js";
import type { ProjectPulseViewModel } from "./Pulse.js";

export type MenuBarApproval = Readonly<{
  approval: string;
  action: string;
  requestedBy: string;
  risk: "low" | "medium" | "high" | "critical";
  menuAction: "quick-decision" | "review-in-app";
}>;

export type MenuBarPresentation = Readonly<{
  icon: "normal" | "attention" | "waiting";
  project: string | null;
  activeAgents: number;
  activeTasks: number;
  blockerCount: number;
  pendingCount: number;
  decisionsEnabled: boolean;
  approvals: readonly MenuBarApproval[];
}>;

export type MenuBarIntent =
  | Readonly<{ action: "grant"; approval: string }>
  | Readonly<{ action: "reject"; approval: string; reason: string }>
  | Readonly<{ action: "review-in-app"; approval: string }>
  | Readonly<{ action: "open-app" }>
  | Readonly<{ action: "open-pulse" }>;

export function toMenuBarPresentation(
  approvals: ApprovalCenterViewModel | null,
  pulse: ProjectPulseViewModel | null,
  decisionsEnabled: boolean,
): MenuBarPresentation {
  return Object.freeze({
    icon: approvals?.icon ?? "normal",
    project: approvals?.project ?? pulse?.project ?? null,
    activeAgents: pulse?.kpis.activeAgents.value ?? 0,
    activeTasks: pulse?.kpis.activeTasks.value ?? 0,
    blockerCount: approvals?.blockerCount ?? pulse?.kpis.blockers.value ?? 0,
    pendingCount: approvals?.pendingCount ?? 0,
    decisionsEnabled,
    approvals: Object.freeze(
      (approvals?.approvals ?? [])
        .filter((item) => item.status === "pending")
        .map((item) =>
          Object.freeze({
            approval: item.approval,
            action: item.action,
            requestedBy: item.requestedBy,
            risk: item.risk,
            menuAction:
              item.menuAction === "quick-decision" ? "quick-decision" : "review-in-app",
          }),
        ),
    ),
  });
}

function intentRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("menu-bar intent must be an object");
  }
  return value as Record<string, unknown>;
}

export function admitMenuBarIntent(
  view: MenuBarPresentation,
  value: unknown,
): MenuBarIntent {
  const raw = intentRecord(value);
  if (raw.action === "open-app" || raw.action === "open-pulse") {
    if (Object.keys(raw).length !== 1) throw new Error("navigation intent has extras");
    return Object.freeze({ action: raw.action });
  }
  if (
    raw.action !== "grant" &&
    raw.action !== "reject" &&
    raw.action !== "review-in-app"
  ) {
    throw new Error("menu-bar intent action is invalid");
  }
  const allowed =
    raw.action === "reject" ? ["action", "approval", "reason"] : ["action", "approval"];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) {
    throw new Error("menu-bar intent has unknown fields");
  }
  if (typeof raw.approval !== "string") throw new Error("approval id is invalid");
  const approval = view.approvals.find((item) => item.approval === raw.approval);
  if (approval === undefined) throw new Error("approval is not currently pending");
  if (raw.action === "review-in-app") {
    return Object.freeze({ action: raw.action, approval: approval.approval });
  }
  if (!view.decisionsEnabled) throw new Error("decision client is unavailable");
  if (approval.menuAction !== "quick-decision") {
    throw new Error("approval requires in-app review");
  }
  if (raw.action === "grant") {
    return Object.freeze({ action: raw.action, approval: approval.approval });
  }
  if (
    typeof raw.reason !== "string" ||
    raw.reason.length === 0 ||
    raw.reason.trim() !== raw.reason
  ) {
    throw new Error("rejection reason is required");
  }
  return Object.freeze({
    action: raw.action,
    approval: approval.approval,
    reason: raw.reason,
  });
}

export async function syncNativeMenuBar(view: MenuBarPresentation): Promise<void> {
  if (!isTauri()) return;
  await invoke("update_menu_bar", { view });
}

export async function listenForMenuBarIntents(
  getView: () => MenuBarPresentation,
  client: ApprovalSurfaceClient | undefined,
  onReview: (approval: string) => void,
  onNavigate: (destination: "app" | "pulse") => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return await listen<unknown>("agent-os://menu-intent", (event) => {
    let intent: MenuBarIntent;
    try {
      intent = admitMenuBarIntent(getView(), event.payload);
    } catch {
      return;
    }
    if (intent.action === "review-in-app") {
      onReview(intent.approval);
    } else if (intent.action === "open-app" || intent.action === "open-pulse") {
      onNavigate(intent.action === "open-pulse" ? "pulse" : "app");
    } else if (client !== undefined) {
      const surfaceIntent: ApprovalSurfaceIntent =
        intent.action === "grant"
          ? { surface: "app", action: "grant", approval: intent.approval }
          : {
              surface: "app",
              action: "reject",
              approval: intent.approval,
              reason: intent.reason,
            };
      void Promise.resolve(client.decide(surfaceIntent)).catch(() => {});
    }
  });
}
