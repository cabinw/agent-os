/**
 * Transport-neutral Runner contract.
 *
 * Local and Remote Runners use the same execution shapes: dispatch request,
 * normalized event, result and error. Control methods add strict cancel and
 * health results. Vendor-specific values stop at the adapter boundary.
 */

export const RUNNER_EVENT_KINDS = Object.freeze([
  "started",
  "delta",
  "thought",
  "progress",
  "usage",
  "completed",
  "failed",
]);

/**
 * Minimal transport-neutral surface every Runner implementation exposes.
 * RemoteRunner must implement this same surface; only its transport differs.
 */
export const RUNNER_INTERFACE_METHODS = Object.freeze([
  "dispatch",
  "cancel",
  "health",
  "hasSession",
  "resetSession",
  "close",
]);

export const RUNNER_CANCEL_OUTCOMES = Object.freeze({
  CANCELLED: "cancelled",
  NOT_FOUND: "not_found",
  ALREADY_TERMINAL: "already_terminal",
});

export const RUNNER_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: "INVALID_REQUEST",
  WORKSPACE_NOT_ALLOWED: "WORKSPACE_NOT_ALLOWED",
  WORKSPACE_NOT_FOUND: "WORKSPACE_NOT_FOUND",
  ADAPTER_NOT_FOUND: "ADAPTER_NOT_FOUND",
  ADAPTER_FAILURE: "ADAPTER_FAILURE",
  CANCELLED: "CANCELLED",
  TIMEOUT: "TIMEOUT",
  UNAVAILABLE: "UNAVAILABLE",
  SESSION_FAILURE: "SESSION_FAILURE",
  INTERNAL: "INTERNAL",
});

export const RUNNER_RETRYABLE_ERROR_CODES = Object.freeze([
  RUNNER_ERROR_CODES.TIMEOUT,
  RUNNER_ERROR_CODES.UNAVAILABLE,
]);

/**
 * A Runner never retries an adapter call itself. Re-dispatching the same
 * requestId replays its one durable terminal result, including failures. The
 * Hub may retry only with a new requestId linked through causedBy. CANCELLED
 * and ordinary ADAPTER_FAILURE are final; TIMEOUT and UNAVAILABLE explicitly
 * permit that higher-level retry.
 */

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

const REQUIRED_REQUEST_FIELDS = [
  "requestId",
  "user",
  "project",
  "agent",
  "adapter",
  "workspace",
  "prompt",
];

const OPTIONAL_REQUEST_FIELDS = ["taskId", "causedBy", "model"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requestIdFrom(value) {
  return isObject(value) && nonEmptyString(value.requestId) ? value.requestId : "unknown";
}

export function runnerError({ requestId, code, message, retryable = false }) {
  return Object.freeze({
    requestId: nonEmptyString(requestId) ? requestId : "unknown",
    code: Object.values(RUNNER_ERROR_CODES).includes(code)
      ? code
      : RUNNER_ERROR_CODES.INTERNAL,
    message: nonEmptyString(message) ? message : "Runner 发生未知错误",
    retryable: retryable === true,
  });
}

export class RunnerDispatchError extends Error {
  constructor(error, cause) {
    super(error.message, cause === undefined ? undefined : { cause });
    this.name = "RunnerDispatchError";
    this.error = error;
  }
}

export function throwRunnerError(error, cause) {
  throw new RunnerDispatchError(runnerError(error), cause);
}

/** Strictly validate a request before it reaches a workspace or adapter. */
export function validateDispatchRequest(value) {
  const requestId = requestIdFrom(value);
  if (!isObject(value)) {
    throwRunnerError({
      requestId,
      code: RUNNER_ERROR_CODES.INVALID_REQUEST,
      message: "Runner dispatch request 必须是对象",
    });
  }

  const unknown = Object.keys(value).filter((key) => !REQUEST_FIELDS.has(key));
  if (unknown.length > 0) {
    throwRunnerError({
      requestId,
      code: RUNNER_ERROR_CODES.INVALID_REQUEST,
      message: `Runner dispatch request 含未知字段：${unknown.join(", ")}`,
    });
  }

  for (const field of REQUIRED_REQUEST_FIELDS) {
    if (!nonEmptyString(value[field])) {
      throwRunnerError({
        requestId,
        code: RUNNER_ERROR_CODES.INVALID_REQUEST,
        message: `Runner dispatch request.${field} 必须是非空字符串`,
      });
    }
  }

  for (const field of OPTIONAL_REQUEST_FIELDS) {
    if (value[field] !== undefined && !nonEmptyString(value[field])) {
      throwRunnerError({
        requestId,
        code: RUNNER_ERROR_CODES.INVALID_REQUEST,
        message: `Runner dispatch request.${field} 必须是非空字符串`,
      });
    }
  }

  return Object.freeze({
    requestId: value.requestId,
    user: value.user,
    project: value.project,
    agent: value.agent,
    adapter: value.adapter,
    workspace: value.workspace,
    prompt: value.prompt,
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
    ...(value.causedBy === undefined ? {} : { causedBy: value.causedBy }),
    ...(value.model === undefined ? {} : { model: value.model }),
  });
}

export function normalizeRunnerResult(requestId, value) {
  const valid =
    isObject(value) &&
    typeof value.text === "string" &&
    (value.sessionId === null || nonEmptyString(value.sessionId)) &&
    typeof value.ms === "number" &&
    Number.isFinite(value.ms) &&
    value.ms >= 0 &&
    typeof value.fresh === "boolean";

  if (!valid) {
    throwRunnerError({
      requestId,
      code: RUNNER_ERROR_CODES.ADAPTER_FAILURE,
      message: "Adapter 返回值不符合 Runner result contract",
      retryable: false,
    });
  }

  return Object.freeze({
    requestId,
    text: value.text,
    sessionId: value.sessionId,
    ms: value.ms,
    fresh: value.fresh,
  });
}

function baseEvent(requestId, sequence, kind) {
  return {
    requestId,
    sequence,
    at: new Date().toISOString(),
    kind,
  };
}

export function runnerLifecycleEvent(requestId, sequence, kind, value) {
  if (kind === "started") {
    return Object.freeze({
      ...baseEvent(requestId, sequence, kind),
      fresh: value?.fresh === true,
    });
  }
  if (kind === "completed") {
    return Object.freeze({ ...baseEvent(requestId, sequence, kind), result: value });
  }
  if (kind === "failed") {
    return Object.freeze({ ...baseEvent(requestId, sequence, kind), error: value });
  }
  throw new TypeError(`未知 Runner lifecycle event：${kind}`);
}

/** Convert an adapter callback into the one event vocabulary used by all Runners. */
export function normalizeAdapterEvent(requestId, sequence, value) {
  if (!isObject(value)) return null;

  if (value.kind === "delta" || value.kind === "thought") {
    if (typeof value.text !== "string" || value.text.length === 0) return null;
    return Object.freeze({
      ...baseEvent(requestId, sequence, value.kind),
      text: value.text,
    });
  }

  if (value.kind === "usage") {
    const usage = {};
    for (const field of ["input", "output", "total", "window", "costUsd"]) {
      const amount = value[field];
      if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) {
        usage[field] = amount;
      }
    }
    return Object.freeze({ ...baseEvent(requestId, sequence, "usage"), ...usage });
  }

  const label =
    typeof value.label === "string" && value.label.trim().length > 0
      ? value.label
      : typeof value.kind === "string" && value.kind.trim().length > 0
        ? value.kind
        : "event";
  return Object.freeze({ ...baseEvent(requestId, sequence, "progress"), label });
}

export function normalizeRunnerError(error, requestId, fallbackCode) {
  if (error instanceof RunnerDispatchError) {
    return runnerError({ ...error.error, requestId });
  }
  return runnerError({
    requestId,
    code: fallbackCode ?? RUNNER_ERROR_CODES.INTERNAL,
    message: error instanceof Error ? error.message : String(error),
    retryable: RUNNER_RETRYABLE_ERROR_CODES.includes(fallbackCode),
  });
}
