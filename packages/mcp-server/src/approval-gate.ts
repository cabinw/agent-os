import { entityIdSchema, newEventId } from "@agent-os/event-core";
import type { EntityId, ProjectId, TaskId } from "@agent-os/event-core";
import { mcpCallContextSchema, toolInputSchemas } from "./schemas.js";
import type { McpCallContext, ToolInputMap } from "./schemas.js";

type Awaitable<T> = T | Promise<T>;
type TimerHandle = unknown;

export type HumanPrincipal = Readonly<{ kind: "human"; id: EntityId }>;

export type PendingApproval = Readonly<{
  approval: EntityId;
  project: ProjectId;
  requestedBy: EntityId;
  action: string;
  risk: "low" | "medium" | "high" | "critical";
  reversible: boolean;
  task?: TaskId;
  detail: string;
  requestedAt: string;
  deadline: string;
}>;

export type ApprovalOutcome =
  | Readonly<{ approval: EntityId; status: "granted"; by: EntityId; note?: string }>
  | Readonly<{ approval: EntityId; status: "rejected"; by: EntityId; reason: string }>
  | Readonly<{ approval: EntityId; status: "expired"; after: string }>;

export type ApprovalPromptDecision =
  | Readonly<{ status: "granted"; human: HumanPrincipal; note?: string }>
  | Readonly<{ status: "rejected"; human: HumanPrincipal; reason: string }>;

export interface ApprovalCommandPort {
  request(command: PendingApproval): Awaitable<void>;
  grant(
    command: Readonly<{
      approval: EntityId;
      project: ProjectId;
      task?: TaskId;
      human: HumanPrincipal;
      note?: string;
    }>,
  ): Awaitable<void>;
  reject(
    command: Readonly<{
      approval: EntityId;
      project: ProjectId;
      task?: TaskId;
      human: HumanPrincipal;
      reason: string;
    }>,
  ): Awaitable<void>;
  expire(
    command: Readonly<{
      approval: EntityId;
      project: ProjectId;
      task?: TaskId;
      after: string;
    }>,
  ): Awaitable<void>;
}

export interface ApprovalScheduler {
  schedule(callback: () => void, delayMs: number): TimerHandle;
  cancel(handle: TimerHandle): void;
}

export type ApprovalPrompt = (
  approval: PendingApproval,
) => Awaitable<ApprovalPromptDecision>;

export type ApprovalGateOptions = Readonly<{
  commands: ApprovalCommandPort;
  timeoutMs: number;
  scheduler?: ApprovalScheduler;
  now?: () => number;
  idFactory?: () => EntityId;
  prompt?: ApprovalPrompt;
  onError?: (cause: unknown, approval: PendingApproval) => void;
}>;

export class ApprovalGateError extends Error {
  readonly code:
    | "CLOSED"
    | "DUPLICATE_APPROVAL"
    | "INVALID_HUMAN"
    | "INVALID_OPTIONS"
    | "NOT_PENDING"
    | "RESOLUTION_IN_PROGRESS";
  readonly approval: string | undefined;

  constructor(
    code: ApprovalGateError["code"],
    message: string,
    approval?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApprovalGateError";
    this.code = code;
    this.approval = approval;
  }
}

type PendingRecord = {
  readonly value: PendingApproval;
  readonly admission: Promise<void>;
  readonly resolve: (outcome: ApprovalOutcome) => void;
  readonly reject: (cause: unknown) => void;
  phase: "admitting" | "pending" | "settling";
  timer?: TimerHandle;
};

function defaultScheduler(): ApprovalScheduler {
  const timers = globalThis as unknown as {
    setTimeout?: (callback: () => void, delayMs: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
  };
  if (
    typeof timers.setTimeout !== "function" ||
    typeof timers.clearTimeout !== "function"
  ) {
    throw new ApprovalGateError(
      "INVALID_OPTIONS",
      "a scheduler is required in this runtime",
    );
  }
  return {
    schedule: (callback, delayMs) => timers.setTimeout?.(callback, delayMs),
    cancel: (handle) => timers.clearTimeout?.(handle),
  };
}

function assertPort(commands: ApprovalCommandPort): void {
  if (commands === null || typeof commands !== "object") {
    throw new ApprovalGateError("INVALID_OPTIONS", "ApprovalCommandPort is required");
  }
  for (const method of ["request", "grant", "reject", "expire"] as const) {
    if (typeof commands[method] !== "function") {
      throw new ApprovalGateError(
        "INVALID_OPTIONS",
        `ApprovalCommandPort.${method} must be a function`,
      );
    }
  }
}

function parseHuman(value: unknown): HumanPrincipal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApprovalGateError("INVALID_HUMAN", "human principal is required");
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "kind" && key !== "id")) {
    throw new ApprovalGateError("INVALID_HUMAN", "human principal has unknown fields");
  }
  const id = entityIdSchema.safeParse(raw.id);
  if (raw.kind !== "human" || !id.success) {
    throw new ApprovalGateError("INVALID_HUMAN", "approval requires a human principal");
  }
  return Object.freeze({ kind: "human", id: id.data });
}

function parseNote(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new ApprovalGateError("INVALID_OPTIONS", `${label} must be non-empty`);
  }
  return value;
}

function freezePending(value: PendingApproval): PendingApproval {
  return Object.freeze({ ...value });
}

function timestamp(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApprovalGateError("INVALID_OPTIONS", `${label} returned an invalid time`);
  }
  try {
    return new Date(value).toISOString();
  } catch (cause) {
    throw new ApprovalGateError(
      "INVALID_OPTIONS",
      `${label} returned an out-of-range time`,
      undefined,
      { cause },
    );
  }
}

export class ApprovalGate {
  readonly #commands: ApprovalCommandPort;
  readonly #timeoutMs: number;
  readonly #scheduler: ApprovalScheduler;
  readonly #now: () => number;
  readonly #idFactory: () => EntityId;
  readonly #prompt: ApprovalPrompt | undefined;
  readonly #onError: (cause: unknown, approval: PendingApproval) => void;
  readonly #pending = new Map<EntityId, PendingRecord>();
  #closed = false;

  constructor(options: ApprovalGateOptions) {
    if (options === null || typeof options !== "object") {
      throw new ApprovalGateError(
        "INVALID_OPTIONS",
        "Approval Gate options are required",
      );
    }
    assertPort(options.commands);
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 7 * 24 * 60 * 60 * 1_000
    ) {
      throw new ApprovalGateError(
        "INVALID_OPTIONS",
        "timeoutMs must be an integer from 1 through 604800000",
      );
    }
    this.#commands = options.commands;
    this.#timeoutMs = options.timeoutMs;
    this.#scheduler = options.scheduler ?? defaultScheduler();
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? (() => newEventId() as unknown as EntityId);
    this.#prompt = options.prompt;
    this.#onError = options.onError ?? (() => {});
  }

  pending(): readonly PendingApproval[] {
    return Object.freeze(
      [...this.#pending.values()]
        .filter((record) => record.phase !== "admitting")
        .map((record) => record.value)
        .sort((left, right) => left.approval.localeCompare(right.approval)),
    );
  }

  async request(
    inputValue: ToolInputMap["request_approval"],
    contextValue: McpCallContext,
  ): Promise<ApprovalOutcome> {
    if (this.#closed) throw new ApprovalGateError("CLOSED", "Approval Gate is closed");
    const input = toolInputSchemas.request_approval.parse(inputValue);
    const context = mcpCallContextSchema.parse(contextValue);
    const approval = this.#idFactory();
    const parsedId = entityIdSchema.safeParse(approval);
    if (!parsedId.success) {
      throw new ApprovalGateError("INVALID_OPTIONS", "idFactory returned an invalid id");
    }
    if (this.#pending.has(parsedId.data)) {
      throw new ApprovalGateError(
        "DUPLICATE_APPROVAL",
        `approval ${parsedId.data} is already active`,
        parsedId.data,
      );
    }
    const requestedAtMs = this.#now();
    const requestedAt = timestamp(requestedAtMs, "clock");
    const deadline = timestamp(requestedAtMs + this.#timeoutMs, "deadline");
    const value = freezePending({
      approval: parsedId.data,
      project: context.project,
      requestedBy: context.principal.id,
      action: input.action,
      risk: input.risk,
      reversible: input.reversible,
      ...(input.task === undefined ? {} : { task: input.task }),
      detail: input.detail,
      requestedAt,
      deadline,
    });

    let resolveWaiter!: (outcome: ApprovalOutcome) => void;
    let rejectWaiter!: (cause: unknown) => void;
    const waiter = new Promise<ApprovalOutcome>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    const admission = Promise.resolve().then(() => this.#commands.request(value));
    const record: PendingRecord = {
      value,
      admission,
      resolve: resolveWaiter,
      reject: rejectWaiter,
      phase: "admitting",
    };
    this.#pending.set(value.approval, record);
    try {
      await admission;
    } catch (cause) {
      this.#pending.delete(value.approval);
      throw cause;
    }
    if (this.#closed) {
      this.#pending.delete(value.approval);
      throw new ApprovalGateError("CLOSED", "Approval Gate closed during admission");
    }
    record.phase = "pending";
    record.timer = this.#scheduler.schedule(() => {
      void this.#expire(record).catch((cause) => this.#onError(cause, record.value));
    }, this.#timeoutMs);
    this.#startPrompt(record);
    return await waiter;
  }

  async grant(
    approval: EntityId,
    humanValue: HumanPrincipal,
    note?: string,
  ): Promise<void> {
    const human = parseHuman(humanValue);
    const admittedNote = parseNote(note, "approval note");
    await this.#decide(approval, async (record) => {
      await this.#commands.grant({
        approval: record.value.approval,
        project: record.value.project,
        ...(record.value.task === undefined ? {} : { task: record.value.task }),
        human,
        ...(admittedNote === undefined ? {} : { note: admittedNote }),
      });
      return {
        approval: record.value.approval,
        status: "granted" as const,
        by: human.id,
        ...(admittedNote === undefined ? {} : { note: admittedNote }),
      };
    });
  }

  async reject(
    approval: EntityId,
    humanValue: HumanPrincipal,
    reason: string,
  ): Promise<void> {
    const human = parseHuman(humanValue);
    const admittedReason = parseNote(reason, "rejection reason");
    if (admittedReason === undefined) {
      throw new ApprovalGateError("INVALID_OPTIONS", "rejection reason is required");
    }
    await this.#decide(approval, async (record) => {
      await this.#commands.reject({
        approval: record.value.approval,
        project: record.value.project,
        ...(record.value.task === undefined ? {} : { task: record.value.task }),
        human,
        reason: admittedReason,
      });
      return {
        approval: record.value.approval,
        status: "rejected" as const,
        by: human.id,
        reason: admittedReason,
      };
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const record of this.#pending.values()) {
      if (record.timer !== undefined) this.#scheduler.cancel(record.timer);
      if (record.phase !== "admitting") {
        record.reject(
          new ApprovalGateError(
            "CLOSED",
            `approval ${record.value.approval} remains pending after Gate close`,
            record.value.approval,
          ),
        );
      }
    }
    this.#pending.clear();
  }

  #startPrompt(record: PendingRecord): void {
    if (this.#prompt === undefined) return;
    void Promise.resolve(this.#prompt(record.value))
      .then(async (decision) => {
        if (decision.status === "granted") {
          await this.grant(record.value.approval, decision.human, decision.note);
        } else {
          await this.reject(record.value.approval, decision.human, decision.reason);
        }
      })
      .catch((cause) => this.#onError(cause, record.value));
  }

  async #decide(
    approval: EntityId,
    command: (record: PendingRecord) => Promise<ApprovalOutcome>,
  ): Promise<void> {
    const parsed = entityIdSchema.safeParse(approval);
    const record = parsed.success ? this.#pending.get(parsed.data) : undefined;
    if (record === undefined) {
      throw new ApprovalGateError("NOT_PENDING", "approval is not pending", approval);
    }
    await record.admission;
    if (record.phase === "settling") {
      throw new ApprovalGateError(
        "RESOLUTION_IN_PROGRESS",
        `approval ${record.value.approval} is already resolving`,
        record.value.approval,
      );
    }
    if (record.phase !== "pending") {
      throw new ApprovalGateError(
        "NOT_PENDING",
        `approval ${record.value.approval} is not pending`,
        record.value.approval,
      );
    }
    record.phase = "settling";
    let outcome: ApprovalOutcome;
    try {
      outcome = await command(record);
    } catch (cause) {
      record.phase = "pending";
      throw cause;
    }
    if (record.timer !== undefined) this.#scheduler.cancel(record.timer);
    this.#pending.delete(record.value.approval);
    record.resolve(Object.freeze(outcome));
  }

  async #expire(record: PendingRecord): Promise<void> {
    if (
      this.#pending.get(record.value.approval) !== record ||
      record.phase !== "pending"
    ) {
      return;
    }
    await this.#decide(record.value.approval, async (active) => {
      await this.#commands.expire({
        approval: active.value.approval,
        project: active.value.project,
        ...(active.value.task === undefined ? {} : { task: active.value.task }),
        after: active.value.deadline,
      });
      return {
        approval: active.value.approval,
        status: "expired" as const,
        after: active.value.deadline,
      };
    });
  }
}

export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  return new ApprovalGate(options);
}
