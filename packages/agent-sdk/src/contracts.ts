import type { EventId, ProjectId, TaskId } from "@agent-os/event-core";

export type Awaitable<T> = T | Promise<T>;
export type AgentId = string & { readonly __brand: "AgentId" };
export type RequestId = string & { readonly __brand: "RequestId" };

export type IntegrationCapabilities = Readonly<{
  participates: boolean;
  streaming: boolean;
  reasoning: boolean;
  session: boolean;
  usage: boolean;
}>;
export type AdapterDescriptor = Readonly<{
  id: string;
  label: string;
  integration: IntegrationCapabilities;
}>;
export type RunnerDispatchRequest = Readonly<{
  requestId: RequestId;
  user: string;
  project: ProjectId;
  agent: AgentId;
  adapter: string;
  workspace: string;
  prompt: string;
  taskId?: TaskId;
  causedBy?: EventId;
  model?: string;
}>;
export type RunnerObservation =
  | Readonly<{ kind: "delta" | "thought"; text: string }>
  | Readonly<{ kind: "progress"; label: string }>
  | Readonly<{
      kind: "usage";
      input: number;
      output: number;
      total: number;
      costUsd?: number;
      window?: number;
    }>;
export type AdapterResult = Readonly<{
  text: string;
  sessionId: string | null;
  durationMs: number;
  fresh: boolean;
}>;
export const RUNNER_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
  "WORKSPACE_NOT_ALLOWED",
  "WORKSPACE_NOT_FOUND",
  "ADAPTER_NOT_FOUND",
  "ADAPTER_FAILURE",
  "CANCELLED",
  "TIMEOUT",
  "UNAVAILABLE",
  "SESSION_FAILURE",
  "INTERNAL",
] as const);
export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];
export type RunnerError = Readonly<{
  requestId: RequestId | "unknown";
  code: RunnerErrorCode;
  message: string;
  retryable: boolean;
}>;
export type RunnerEvent = Readonly<{ requestId: RequestId; sequence: number }> &
  (
    | Readonly<{ kind: "started"; fresh: boolean }>
    | RunnerObservation
    | Readonly<{ kind: "completed"; result: AdapterResult }>
    | Readonly<{ kind: "failed"; error: RunnerError }>
  );
export type RunnerCancelOutcome = "cancelled" | "not_found" | "already_terminal";
export type RunnerHealth = Readonly<{
  accepting: boolean;
  active: number;
  adapters: readonly AdapterDescriptor[];
}>;
export interface Runner {
  dispatch(
    request: RunnerDispatchRequest,
    options?: Readonly<{ onEvent?: (event: RunnerEvent) => void }>,
  ): Promise<AdapterResult>;
  cancel(requestId: RequestId): Promise<RunnerCancelOutcome>;
  health(): Awaitable<RunnerHealth>;
  hasSession(
    scope: Readonly<{ user: string; project: ProjectId; agent: AgentId }>,
  ): Awaitable<boolean>;
  resetSession(
    scope: Readonly<{ user: string; project: ProjectId; agent: AgentId }>,
  ): Awaitable<void>;
  close(): Promise<void>;
}
export type AbortSignalLike = Readonly<{
  aborted: boolean;
  reason?: unknown;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}>;
export type ScopedMcpMount = Readonly<{
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}>;
export type AdapterInvocation = Readonly<{
  prompt: string;
  workspace: string;
  model?: string;
  sessionId?: string;
  mcp?: ScopedMcpMount;
}>;
export interface AgentAdapter {
  readonly descriptor: AdapterDescriptor;
  send(
    invocation: AdapterInvocation,
    options?: Readonly<{
      signal?: AbortSignalLike;
      emit?: (event: RunnerObservation) => void;
    }>,
  ): Promise<AdapterResult>;
  cancel(reason?: unknown): Promise<void>;
  close(): Promise<void>;
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}
export class AgentSdkContractError extends Error {
  readonly code:
    | "INVALID_ADAPTER"
    | "INVALID_EVENT"
    | "INVALID_REQUEST"
    | "INVALID_RESULT";
  constructor(code: AgentSdkContractError["code"], message: string) {
    super(message);
    this.name = "AgentSdkContractError";
    this.code = code;
  }
}

const REQUEST_FIELDS = new Set([
  "requestId",
  "user",
  "project",
  "agent",
  "adapter",
  "workspace",
  "prompt",
  "taskId",
  "causedBy",
  "model",
]);
export function parseRunnerDispatchRequest(value: unknown): RunnerDispatchRequest {
  if (!plain(value))
    throw new AgentSdkContractError(
      "INVALID_REQUEST",
      "dispatch request must be a plain object",
    );
  const unknown = Object.keys(value).filter((key) => !REQUEST_FIELDS.has(key));
  if (unknown.length)
    throw new AgentSdkContractError(
      "INVALID_REQUEST",
      `unknown dispatch fields: ${unknown.join(", ")}`,
    );
  for (const key of [
    "requestId",
    "user",
    "project",
    "agent",
    "adapter",
    "workspace",
    "prompt",
  ] as const) {
    if (!text(value[key]))
      throw new AgentSdkContractError(
        "INVALID_REQUEST",
        `dispatch.${key} must be non-empty`,
      );
  }
  for (const key of ["taskId", "causedBy", "model"] as const) {
    if (value[key] !== undefined && !text(value[key]))
      throw new AgentSdkContractError(
        "INVALID_REQUEST",
        `dispatch.${key} must be non-empty`,
      );
  }
  return Object.freeze({ ...value }) as RunnerDispatchRequest;
}

export function parseAdapterDescriptor(value: unknown): AdapterDescriptor {
  const keys = ["participates", "streaming", "reasoning", "session", "usage"] as const;
  if (
    !plain(value) ||
    Object.keys(value).some((key) => !["id", "label", "integration"].includes(key)) ||
    !text(value.id) ||
    !text(value.label) ||
    !plain(value.integration)
  ) {
    throw new AgentSdkContractError("INVALID_ADAPTER", "adapter descriptor is invalid");
  }
  const integration = value.integration;
  if (
    Object.keys(integration).some((key) => !keys.includes(key as never)) ||
    keys.some((key) => typeof integration[key] !== "boolean")
  ) {
    throw new AgentSdkContractError("INVALID_ADAPTER", "adapter descriptor is invalid");
  }
  return Object.freeze({
    id: value.id,
    label: value.label,
    integration: Object.freeze({
      participates: integration.participates as boolean,
      streaming: integration.streaming as boolean,
      reasoning: integration.reasoning as boolean,
      session: integration.session as boolean,
      usage: integration.usage as boolean,
    }),
  });
}

export function parseRunnerObservation(value: unknown): RunnerObservation {
  if (!plain(value) || !text(value.kind))
    throw new AgentSdkContractError("INVALID_EVENT", "observation is invalid");
  if (value.kind === "delta" || value.kind === "thought") {
    if (
      Object.keys(value).some((key) => key !== "kind" && key !== "text") ||
      !text(value.text)
    )
      throw new AgentSdkContractError("INVALID_EVENT", `${value.kind} is invalid`);
    return Object.freeze({ kind: value.kind, text: value.text });
  }
  if (value.kind === "progress") {
    if (
      Object.keys(value).some((key) => key !== "kind" && key !== "label") ||
      !text(value.label)
    )
      throw new AgentSdkContractError("INVALID_EVENT", "progress is invalid");
    return Object.freeze({ kind: value.kind, label: value.label });
  }
  if (value.kind === "usage") {
    const allowed = new Set(["kind", "input", "output", "total", "costUsd", "window"]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
      throw new AgentSdkContractError("INVALID_EVENT", "usage has unknown fields");
    for (const key of ["input", "output", "total"] as const)
      if (!Number.isFinite(value[key]) || (value[key] as number) < 0)
        throw new AgentSdkContractError("INVALID_EVENT", `usage.${key} is invalid`);
    for (const key of ["costUsd", "window"] as const)
      if (
        value[key] !== undefined &&
        (!Number.isFinite(value[key]) || (value[key] as number) < 0)
      )
        throw new AgentSdkContractError("INVALID_EVENT", `usage.${key} is invalid`);
    return Object.freeze({ ...value }) as RunnerObservation;
  }
  throw new AgentSdkContractError("INVALID_EVENT", `unknown observation ${value.kind}`);
}

export function parseAdapterResult(value: unknown): AdapterResult {
  if (
    !plain(value) ||
    Object.keys(value).some(
      (key) => !["text", "sessionId", "durationMs", "fresh"].includes(key),
    ) ||
    typeof value.text !== "string" ||
    !(value.sessionId === null || text(value.sessionId)) ||
    !Number.isFinite(value.durationMs) ||
    (value.durationMs as number) < 0 ||
    typeof value.fresh !== "boolean"
  )
    throw new AgentSdkContractError("INVALID_RESULT", "adapter result is invalid");
  return Object.freeze({ ...value }) as AdapterResult;
}

export function createAdapterCatalog(adapters: readonly AgentAdapter[]) {
  const byId = new Map<string, AgentAdapter>();
  for (const adapter of adapters) {
    const descriptor = parseAdapterDescriptor(adapter?.descriptor);
    if (byId.has(descriptor.id))
      throw new AgentSdkContractError(
        "INVALID_ADAPTER",
        `duplicate adapter ${descriptor.id}`,
      );
    if (
      typeof adapter.send !== "function" ||
      typeof adapter.cancel !== "function" ||
      typeof adapter.close !== "function"
    )
      throw new AgentSdkContractError(
        "INVALID_ADAPTER",
        `adapter ${descriptor.id} is incomplete`,
      );
    byId.set(descriptor.id, adapter);
  }
  return Object.freeze({
    get: (id: string) => byId.get(id),
    describe: (): readonly AdapterDescriptor[] =>
      Object.freeze([...byId.values()].map((adapter) => adapter.descriptor)),
  });
}
