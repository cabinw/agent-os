import {
  PRIORITIES,
  entityIdSchema,
  projectIdSchema,
  rfc3339Schema,
  taskIdSchema,
} from "@agent-os/event-core";
import type {
  EntityId,
  EventBus,
  ProjectId,
  ReducerHandle,
  StoredEvent,
  TaskId,
} from "@agent-os/event-core";

export type ApprovalStatus = "pending" | "granted" | "rejected" | "expired";

export type ApprovalDecision =
  | Readonly<{ status: "granted"; by: EntityId; note?: string; at: string }>
  | Readonly<{ status: "rejected"; by: EntityId; reason: string; at: string }>
  | Readonly<{ status: "expired"; after: string; at: string }>;

export type ApprovalState = Readonly<{
  id: EntityId;
  project: ProjectId;
  status: ApprovalStatus;
  action: string;
  risk: "low" | "medium" | "high" | "critical";
  reversible: boolean;
  requestedBy: EntityId;
  task?: TaskId;
  detail: string;
  requestedAt: string;
  decision?: ApprovalDecision;
}>;

export type ApprovalProjectState = Readonly<{
  approvals: Readonly<Record<string, ApprovalState>>;
}>;

export class ApprovalProjectionError extends Error {
  readonly code:
    | "DUPLICATE_APPROVAL"
    | "INVALID_ACTOR"
    | "INVALID_STATE"
    | "MISSING_APPROVAL"
    | "TERMINAL_APPROVAL";
  readonly approvalId: string | undefined;

  constructor(
    code: ApprovalProjectionError["code"],
    message: string,
    approvalId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApprovalProjectionError";
    this.code = code;
    this.approvalId = approvalId;
  }
}

function requireHumanDecision(
  event: StoredEvent<"approval.granted" | "approval.rejected">,
): void {
  if (event.actor.kind !== "human" || event.actor.id !== event.payload.by) {
    throw new ApprovalProjectionError(
      "INVALID_ACTOR",
      `${event.type} must be admitted for its authenticated human actor`,
      event.subject.id,
    );
  }
}

export function reduceApprovalProject(
  state: ApprovalProjectState,
  event: StoredEvent,
): ApprovalProjectState {
  if (!event.type.startsWith("approval.")) return state;
  const approvalId = schemaValue(
    entityIdSchema,
    event.subject.id,
    "approval event subject id",
  );
  const existing = state.approvals[approvalId];
  if (event.type === "approval.requested") {
    if (existing !== undefined) {
      throw new ApprovalProjectionError(
        "DUPLICATE_APPROVAL",
        `approval ${approvalId} already exists`,
        approvalId,
      );
    }
    if (event.actor.kind !== "agent" || event.actor.id !== event.payload.requestedBy) {
      throw new ApprovalProjectionError(
        "INVALID_ACTOR",
        "approval requester must match the authenticated agent actor",
        approvalId,
      );
    }
    return {
      approvals: {
        ...state.approvals,
        [approvalId]: {
          id: approvalId,
          project: event.project,
          status: "pending",
          action: event.payload.action,
          risk: event.payload.risk,
          reversible: event.payload.reversible,
          requestedBy: event.payload.requestedBy,
          ...(event.payload.task === undefined ? {} : { task: event.payload.task }),
          detail: event.payload.detail,
          requestedAt: event.at,
        },
      },
    };
  }
  if (existing === undefined) {
    throw new ApprovalProjectionError(
      "MISSING_APPROVAL",
      `approval ${approvalId} does not exist`,
      approvalId,
    );
  }
  if (existing.status !== "pending") {
    throw new ApprovalProjectionError(
      "TERMINAL_APPROVAL",
      `approval ${approvalId} is already ${existing.status}`,
      approvalId,
    );
  }

  let decision: ApprovalDecision;
  if (event.type === "approval.granted") {
    requireHumanDecision(event);
    decision = {
      status: "granted",
      by: event.payload.by,
      ...(event.payload.note === undefined ? {} : { note: event.payload.note }),
      at: event.at,
    };
  } else if (event.type === "approval.rejected") {
    requireHumanDecision(event);
    decision = {
      status: "rejected",
      by: event.payload.by,
      reason: event.payload.reason,
      at: event.at,
    };
  } else if (event.type === "approval.expired") {
    if (event.actor.kind !== "system") {
      throw new ApprovalProjectionError(
        "INVALID_ACTOR",
        "approval expiration must be admitted by the system",
        approvalId,
      );
    }
    decision = { status: "expired", after: event.payload.after, at: event.at };
  } else {
    return state;
  }
  return {
    approvals: {
      ...state.approvals,
      [approvalId]: { ...existing, status: decision.status, decision },
    },
  };
}

const APPROVAL_KEYS = new Set([
  "id",
  "project",
  "status",
  "action",
  "risk",
  "reversible",
  "requestedBy",
  "task",
  "detail",
  "requestedAt",
  "decision",
]);

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new ApprovalProjectionError("INVALID_STATE", `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ApprovalProjectionError(
        "INVALID_STATE",
        `${label} has unknown field ${key}`,
      );
    }
  }
}

function schemaValue<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  label: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApprovalProjectionError("INVALID_STATE", `${label} is invalid`);
  }
  return result.data;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new ApprovalProjectionError("INVALID_STATE", `${label} must be non-empty`);
  }
  return value;
}

function parseDecision(
  value: unknown,
  status: ApprovalStatus,
  label: string,
): ApprovalDecision {
  const decision = plainObject(value, label);
  if (status === "granted") {
    exactKeys(decision, new Set(["status", "by", "note", "at"]), label);
    if (decision.status !== status) {
      throw new ApprovalProjectionError("INVALID_STATE", `${label}.status mismatches`);
    }
    return {
      status,
      by: schemaValue(entityIdSchema, decision.by, `${label}.by`),
      ...(decision.note === undefined
        ? {}
        : { note: text(decision.note, `${label}.note`) }),
      at: schemaValue(rfc3339Schema, decision.at, `${label}.at`),
    };
  }
  if (status === "rejected") {
    exactKeys(decision, new Set(["status", "by", "reason", "at"]), label);
    if (decision.status !== status) {
      throw new ApprovalProjectionError("INVALID_STATE", `${label}.status mismatches`);
    }
    return {
      status,
      by: schemaValue(entityIdSchema, decision.by, `${label}.by`),
      reason: text(decision.reason, `${label}.reason`),
      at: schemaValue(rfc3339Schema, decision.at, `${label}.at`),
    };
  }
  if (status !== "expired") {
    throw new ApprovalProjectionError(
      "INVALID_STATE",
      `${label} cannot exist for pending`,
    );
  }
  exactKeys(decision, new Set(["status", "after", "at"]), label);
  if (decision.status !== status) {
    throw new ApprovalProjectionError("INVALID_STATE", `${label}.status mismatches`);
  }
  return {
    status,
    after: schemaValue(rfc3339Schema, decision.after, `${label}.after`),
    at: schemaValue(rfc3339Schema, decision.at, `${label}.at`),
  };
}

function parseApproval(value: unknown, key: string, project: ProjectId): ApprovalState {
  const label = `approval ${key}`;
  const raw = plainObject(value, label);
  exactKeys(raw, APPROVAL_KEYS, label);
  const id = schemaValue(entityIdSchema, raw.id, `${label}.id`);
  if (id !== key) {
    throw new ApprovalProjectionError("INVALID_STATE", `${label} has mismatched id`);
  }
  const parsedProject = schemaValue(projectIdSchema, raw.project, `${label}.project`);
  if (parsedProject !== project) {
    throw new ApprovalProjectionError("INVALID_STATE", `${label} has wrong project`);
  }
  if (!(PRIORITIES as readonly unknown[]).includes(raw.risk)) {
    throw new ApprovalProjectionError("INVALID_STATE", `${label}.risk is invalid`);
  }
  if (
    !(
      raw.status === "pending" ||
      raw.status === "granted" ||
      raw.status === "rejected" ||
      raw.status === "expired"
    )
  ) {
    throw new ApprovalProjectionError("INVALID_STATE", `${label}.status is invalid`);
  }
  if (typeof raw.reversible !== "boolean") {
    throw new ApprovalProjectionError("INVALID_STATE", `${label}.reversible is invalid`);
  }
  const decision =
    raw.decision === undefined
      ? undefined
      : parseDecision(raw.decision, raw.status, `${label}.decision`);
  if ((raw.status === "pending") !== (decision === undefined)) {
    throw new ApprovalProjectionError(
      "INVALID_STATE",
      `${label} decision state mismatches`,
    );
  }
  return {
    id,
    project: parsedProject,
    status: raw.status,
    action: text(raw.action, `${label}.action`),
    risk: raw.risk as ApprovalState["risk"],
    reversible: raw.reversible,
    requestedBy: schemaValue(entityIdSchema, raw.requestedBy, `${label}.requestedBy`),
    ...(raw.task === undefined
      ? {}
      : { task: schemaValue(taskIdSchema, raw.task, `${label}.task`) }),
    detail: text(raw.detail, `${label}.detail`),
    requestedAt: schemaValue(rfc3339Schema, raw.requestedAt, `${label}.requestedAt`),
    ...(decision === undefined ? {} : { decision }),
  };
}

export function parseApprovalProjectState(
  value: unknown,
  project: ProjectId,
): ApprovalProjectState {
  const root = plainObject(value, "approval project state");
  exactKeys(root, new Set(["approvals"]), "approval project state");
  const approvals = plainObject(root.approvals, "approvals");
  const parsed: Record<string, ApprovalState> = {};
  for (const [key, approval] of Object.entries(approvals)) {
    parsed[key] = parseApproval(approval, key, project);
  }
  return { approvals: parsed };
}

export function registerApprovalReducer(
  bus: EventBus,
): ReducerHandle<ApprovalProjectState> {
  return bus.registerReducer(
    "approvals",
    () => ({ approvals: {} }),
    reduceApprovalProject,
    { version: "1", parseState: parseApprovalProjectState },
  );
}
