import {
  type DeepReadonly,
  type EntityId,
  type EventId,
  type ProjectId,
  type StoredEvent,
  entityIdSchema,
  parseStoredEvent,
} from "@agent-os/event-core";
import { reduceTaskProject } from "@agent-os/task-engine";
import type { TaskProjectState } from "@agent-os/task-engine";
import {
  type ApprovalProjectState,
  type ApprovalState,
  reduceApprovalProject,
} from "./approval-projection.js";

export type ApprovalMenuAction = "quick-decision" | "review-in-app" | "none";
export type ApprovalCenterItem = DeepReadonly<{
  approval: EntityId;
  project: ProjectId;
  status: ApprovalState["status"];
  action: string;
  detail: string;
  risk: ApprovalState["risk"];
  reversible: boolean;
  requestedBy: EntityId;
  task?: string;
  requestedAt: string;
  decision?: ApprovalState["decision"];
  menuAction: ApprovalMenuAction;
  sourceEvents: readonly EventId[];
}>;
export type ApprovalCenterView = DeepReadonly<{
  project: ProjectId;
  icon: "normal" | "attention" | "waiting";
  pendingCount: number;
  blockerCount: number;
  approvals: readonly ApprovalCenterItem[];
}>;
export type ApprovalCenterSource = Readonly<{
  project: ProjectId;
  history: readonly unknown[];
}>;

export type ApprovalDecisionIntent =
  | DeepReadonly<{
      surface: "app" | "menu-bar";
      action: "grant";
      approval: EntityId;
      note?: string;
    }>
  | DeepReadonly<{
      surface: "app" | "menu-bar";
      action: "reject";
      approval: EntityId;
      reason: string;
    }>
  | DeepReadonly<{
      surface: "menu-bar";
      action: "review-in-app";
      approval: EntityId;
    }>;

export interface ApprovalDecisionClient {
  decide(
    intent: Exclude<ApprovalDecisionIntent, { action: "review-in-app" }>,
  ): void | Promise<void>;
  reviewInApp(approval: EntityId): void | Promise<void>;
}

export class ApprovalCenterError extends Error {
  readonly code:
    | "DUPLICATE_EVENT"
    | "INVALID_HISTORY"
    | "INVALID_INTENT"
    | "MIXED_PROJECT"
    | "NOT_PENDING"
    | "REVIEW_REQUIRED"
    | "SEQUENCE_GAP"
    | "UNKNOWN_APPROVAL";
  readonly approval: string | undefined;

  constructor(
    code: ApprovalCenterError["code"],
    message: string,
    approval?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApprovalCenterError";
    this.code = code;
    this.approval = approval;
  }
}

function freeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value as DeepReadonly<Value>;
}

function parseHistory(source: ApprovalCenterSource): readonly StoredEvent[] {
  const seen = new Set<string>();
  return source.history.map((value, index) => {
    let event: StoredEvent;
    try {
      event = parseStoredEvent(value);
    } catch (cause) {
      throw new ApprovalCenterError(
        "INVALID_HISTORY",
        `history[${index}] is invalid`,
        undefined,
        { cause },
      );
    }
    if (event.project !== source.project) {
      throw new ApprovalCenterError(
        "MIXED_PROJECT",
        `history[${index}] belongs to another project`,
      );
    }
    if (Number(event.seq) !== index + 1) {
      throw new ApprovalCenterError(
        "SEQUENCE_GAP",
        `history[${index}] must have seq ${index + 1}`,
      );
    }
    if (seen.has(event.id)) {
      throw new ApprovalCenterError(
        "DUPLICATE_EVENT",
        `event ${event.id} appears more than once`,
      );
    }
    seen.add(event.id);
    return event;
  });
}

function menuAction(approval: ApprovalState): ApprovalMenuAction {
  if (approval.status !== "pending") return "none";
  return approval.reversible && (approval.risk === "low" || approval.risk === "medium")
    ? "quick-decision"
    : "review-in-app";
}

export function buildApprovalCenter(source: ApprovalCenterSource): ApprovalCenterView {
  const history = parseHistory(source);
  let approvals: ApprovalProjectState = { approvals: {} };
  let tasks: TaskProjectState = { tasks: {} };
  const requestEvent = new Map<string, StoredEvent<"approval.requested">>();
  const decisionEvent = new Map<
    string,
    StoredEvent<"approval.granted" | "approval.rejected" | "approval.expired">
  >();

  try {
    for (const event of history) {
      approvals = reduceApprovalProject(approvals, event);
      tasks = reduceTaskProject(tasks, event);
      if (event.type === "approval.requested") {
        requestEvent.set(event.subject.id, event);
      } else if (
        event.type === "approval.granted" ||
        event.type === "approval.rejected" ||
        event.type === "approval.expired"
      ) {
        decisionEvent.set(event.subject.id, event);
      }
    }
  } catch (cause) {
    throw new ApprovalCenterError(
      "INVALID_HISTORY",
      "approval or task projection rejected history",
      undefined,
      { cause },
    );
  }

  const items = Object.values(approvals.approvals).map((approval) => {
    const request = requestEvent.get(approval.id);
    if (request === undefined) {
      throw new ApprovalCenterError(
        "INVALID_HISTORY",
        `approval ${approval.id} lacks request evidence`,
        approval.id,
      );
    }
    const decision = decisionEvent.get(approval.id);
    if ((approval.status === "pending") !== (decision === undefined)) {
      throw new ApprovalCenterError(
        "INVALID_HISTORY",
        `approval ${approval.id} decision evidence mismatches state`,
        approval.id,
      );
    }
    return {
      approval: approval.id,
      project: approval.project,
      status: approval.status,
      action: approval.action,
      detail: approval.detail,
      risk: approval.risk,
      reversible: approval.reversible,
      requestedBy: approval.requestedBy,
      ...(approval.task === undefined ? {} : { task: approval.task }),
      requestedAt: approval.requestedAt,
      ...(approval.decision === undefined ? {} : { decision: approval.decision }),
      menuAction: menuAction(approval),
      sourceEvents: [request.id, ...(decision === undefined ? [] : [decision.id])],
      requestSeq: Number(request.seq),
    };
  });
  items.sort(
    (left, right) =>
      Number(right.status === "pending") - Number(left.status === "pending") ||
      right.requestSeq - left.requestSeq ||
      left.approval.localeCompare(right.approval),
  );
  const pendingCount = items.filter((item) => item.status === "pending").length;
  const blockerCount = Object.values(tasks.tasks).filter(
    (task) => task.status === "blocked",
  ).length;

  return freeze({
    project: source.project,
    icon: pendingCount > 0 ? "waiting" : blockerCount > 0 ? "attention" : "normal",
    pendingCount,
    blockerCount,
    approvals: items.map(({ requestSeq: _requestSeq, ...item }) => item),
  });
}

function plainIntent(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new ApprovalCenterError("INVALID_INTENT", "approval intent must be an object");
  }
  return value as Record<string, unknown>;
}

function exactIntentKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ApprovalCenterError(
      "INVALID_INTENT",
      `approval intent has unknown field ${unknown[0]}`,
    );
  }
  for (const required of ["surface", "action", "approval"]) {
    if (!Object.hasOwn(value, required)) {
      throw new ApprovalCenterError(
        "INVALID_INTENT",
        `approval intent is missing ${required}`,
      );
    }
  }
}

function intentText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new ApprovalCenterError("INVALID_INTENT", `${label} must be non-empty`);
  }
  return value;
}

export function admitApprovalIntent(
  view: ApprovalCenterView,
  value: unknown,
): ApprovalDecisionIntent {
  const raw = plainIntent(value);
  if (raw.surface !== "app" && raw.surface !== "menu-bar") {
    throw new ApprovalCenterError("INVALID_INTENT", "approval surface is invalid");
  }
  if (
    raw.action !== "grant" &&
    raw.action !== "reject" &&
    raw.action !== "review-in-app"
  ) {
    throw new ApprovalCenterError("INVALID_INTENT", "approval action is invalid");
  }
  const allowed =
    raw.action === "grant"
      ? ["surface", "action", "approval", "note"]
      : raw.action === "reject"
        ? ["surface", "action", "approval", "reason"]
        : ["surface", "action", "approval"];
  exactIntentKeys(raw, allowed);
  const approvalResult = entityIdSchema.safeParse(raw.approval);
  if (!approvalResult.success) {
    throw new ApprovalCenterError("INVALID_INTENT", "approval id is invalid");
  }
  const approval = view.approvals.find((item) => item.approval === approvalResult.data);
  if (approval === undefined) {
    throw new ApprovalCenterError(
      "UNKNOWN_APPROVAL",
      `approval ${approvalResult.data} is unknown`,
      approvalResult.data,
    );
  }
  if (approval.status !== "pending") {
    throw new ApprovalCenterError(
      "NOT_PENDING",
      `approval ${approval.approval} is ${approval.status}`,
      approval.approval,
    );
  }
  if (raw.action === "review-in-app") {
    if (raw.surface !== "menu-bar") {
      throw new ApprovalCenterError(
        "INVALID_INTENT",
        "review-in-app is only a menu-bar action",
        approval.approval,
      );
    }
    return freeze({
      surface: "menu-bar",
      action: raw.action,
      approval: approval.approval,
    });
  }
  if (raw.surface === "menu-bar" && approval.menuAction !== "quick-decision") {
    throw new ApprovalCenterError(
      "REVIEW_REQUIRED",
      `approval ${approval.approval} requires in-app review`,
      approval.approval,
    );
  }
  if (raw.action === "grant") {
    const note = raw.note === undefined ? undefined : intentText(raw.note, "grant note");
    return freeze({
      surface: raw.surface,
      action: raw.action,
      approval: approval.approval,
      ...(note === undefined ? {} : { note }),
    });
  }
  return freeze({
    surface: raw.surface,
    action: raw.action,
    approval: approval.approval,
    reason: intentText(raw.reason, "rejection reason"),
  });
}
