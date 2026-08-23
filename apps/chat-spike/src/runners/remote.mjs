import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  RUNNER_CANCEL_OUTCOMES,
  RUNNER_ERROR_CODES,
  RUNNER_EVENT_KINDS,
  RunnerDispatchError,
  normalizeRunnerResult,
  runnerError,
  runnerLifecycleEvent,
  validateDispatchRequest,
} from "./contract.mjs";
import { sessionKey } from "./session-store.mjs";

const DEFAULT_PREFIX = "/runner/v1";
export const REMOTE_POLL_TIMEOUT_MS = 25_000;
export const REMOTE_POLL_RESPONSE_TIMEOUT_MS = REMOTE_POLL_TIMEOUT_MS + 5_000;
const DEFAULT_POLL_TIMEOUT_MS = REMOTE_POLL_TIMEOUT_MS;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_OFFER_LEASE_MS = 500;
const DEFAULT_RECONNECT_DELAY_MS = 100;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 10_000;
const DEFAULT_LIVENESS_TIMEOUT_MS = 60_000;
const DEFAULT_CLOSE_GRACE_MS = 5_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_COMPLETED_REQUESTS = 1_000;
const DEFAULT_MAX_PENDING_CONTROLS = 100;
const DEFAULT_MAX_COMPLETED_CONTROLS = 1_000;
const DEFAULT_MAX_EVENTS_PER_REQUEST = 10_000;
const DEFAULT_MAX_EVENT_GAP = 1_000;
const DEFAULT_MAX_CONCURRENT_DISPATCHES = 4;
const DEFAULT_MAX_CONCURRENT_CONTROLS = 16;
export const REMOTE_MAX_POLLERS = 16;
const PLACEMENT_FORMAT_VERSION = 1;
const REQUEST_LEDGER_FORMAT_VERSION = 1;
const MIN_TOKEN_BYTES = 32;
export const REMOTE_BODY_LIMIT_BYTES = 1024 * 1024;
export const REMOTE_BODY_TIMEOUT_MS = 3_000;
const REMOTE_MAX_DELIVERY = Number.MAX_SAFE_INTEGER;
const REMOTE_MAX_LEASE_ID = "00000000-0000-4000-8000-000000000000";
export const REMOTE_POLL_ENVELOPE_BYTES =
  remotePollWorkBytes(dispatchPollWork(null, REMOTE_MAX_DELIVERY, REMOTE_MAX_LEASE_ID)) -
  Buffer.byteLength("null", "utf8");
export const REMOTE_REQUEST_LIMIT_BYTES =
  REMOTE_BODY_LIMIT_BYTES - REMOTE_POLL_ENVELOPE_BYTES;
export const REMOTE_EVENT_LIMIT_BYTES = 256 * 1024;
export const REMOTE_REQUEST_EVENT_LIMIT_BYTES = 4 * 1024 * 1024;
export const REMOTE_EXECUTION_PAYLOAD_LIMIT_BYTES =
  REMOTE_REQUEST_LIMIT_BYTES +
  REMOTE_REQUEST_EVENT_LIMIT_BYTES +
  REMOTE_EVENT_LIMIT_BYTES;
export const REMOTE_CACHED_PAYLOAD_LIMIT_BYTES = 32 * 1024 * 1024;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateToken(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    }) ||
    Buffer.byteLength(value) < MIN_TOKEN_BYTES ||
    Buffer.byteLength(value) > 4096
  ) {
    throw new TypeError(
      `${label} 必须是至少 ${MIN_TOKEN_BYTES} bytes 且不含空白的 token`,
    );
  }
  return value;
}

function loopbackHostname(hostname) {
  const value = hostname.toLowerCase();
  if (value === "localhost" || value.endsWith(".localhost")) return true;
  if (value === "[::1]" || value === "::1") return true;
  const octets = value.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
  );
}

function validateRemoteUrl(value) {
  if (!nonEmptyString(value)) {
    throw new TypeError("RemoteRunnerWorker.url 必须是非空字符串");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new TypeError("RemoteRunnerWorker.url 必须是有效绝对 URL", { cause: error });
  }
  const allowed =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && loopbackHostname(parsed.hostname));
  if (!allowed) {
    throw new TypeError("RemoteRunnerWorker.url 必须使用 HTTPS；HTTP 仅允许 loopback");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("RemoteRunnerWorker.url 不得包含 credential、query 或 fragment");
  }
  return parsed;
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
  );
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function fingerprint(value) {
  return JSON.stringify(value);
}

function serializedBytes(value) {
  return Buffer.byteLength(fingerprint(value), "utf8");
}

export function remotePollWorkBytes(work) {
  const serialized = JSON.stringify(work);
  if (typeof serialized !== "string") {
    throw new TypeError("Remote Runner work 必须可序列化为 JSON");
  }
  return Buffer.byteLength(`${serialized}\n`, "utf8");
}

function dispatchPollWork(request, delivery, leaseId) {
  return { kind: "dispatch", request, delivery, leaseId };
}

function controlPollWork(control, delivery, leaseId) {
  return control.kind === "reset-session"
    ? {
        kind: control.kind,
        controlId: control.controlId,
        scope: control.scope,
        delivery,
        leaseId,
      }
    : {
        kind: control.kind,
        controlId: control.controlId,
        requestId: control.requestId,
        delivery,
        leaseId,
      };
}

function projectedPollWork(value) {
  return "request" in value
    ? dispatchPollWork(value.request, REMOTE_MAX_DELIVERY, REMOTE_MAX_LEASE_ID)
    : controlPollWork(value, REMOTE_MAX_DELIVERY, REMOTE_MAX_LEASE_ID);
}

function pollWorkFits(work) {
  return remotePollWorkBytes(work) <= REMOTE_BODY_LIMIT_BYTES;
}

function assertPollWorkFits(work) {
  if (!pollWorkFits(work)) {
    throw new ProtocolInputError(
      500,
      "Remote Runner work response 超出限制",
      "response_too_large",
    );
  }
  return work;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requestFingerprint(value) {
  return sha256(fingerprint(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function transportError(
  requestId,
  message,
  retryable = true,
  code = RUNNER_ERROR_CODES.INTERNAL,
) {
  return new RunnerDispatchError(runnerError({ requestId, code, message, retryable }));
}

function cancelResult(requestId, outcome) {
  return Object.freeze({ requestId, outcome });
}

function validateCancelResult(requestId, value) {
  if (!exactKeys(value, ["requestId", "outcome"])) {
    throw new ProtocolInputError(400, "Runner cancel result 不符合共享契约");
  }
  if (
    value.requestId !== requestId ||
    !Object.values(RUNNER_CANCEL_OUTCOMES).includes(value.outcome)
  ) {
    throw new ProtocolInputError(400, "Runner cancel result 字段无效");
  }
  return cancelResult(requestId, value.outcome);
}

function validateHostId(value) {
  if (!nonEmptyString(value))
    throw new ProtocolInputError(400, "hostId 必须是非空字符串");
  return value;
}

function validateScope(value) {
  if (!exactKeys(value, ["user", "project", "agent"])) {
    throw new ProtocolInputError(400, "session scope 必须只包含 user / project / agent");
  }
  try {
    sessionKey(value);
  } catch (error) {
    throw new ProtocolInputError(400, error.message);
  }
  return Object.freeze({ user: value.user, project: value.project, agent: value.agent });
}

function validateWireError(requestId, value) {
  if (!exactKeys(value, ["requestId", "code", "message", "retryable"])) {
    throw new ProtocolInputError(400, "Runner error 不符合共享契约");
  }
  if (
    value.requestId !== requestId ||
    !Object.values(RUNNER_ERROR_CODES).includes(value.code) ||
    !nonEmptyString(value.message) ||
    typeof value.retryable !== "boolean"
  ) {
    throw new ProtocolInputError(400, "Runner error 字段无效");
  }
  return Object.freeze({
    requestId,
    code: value.code,
    message: value.message,
    retryable: value.retryable,
  });
}

function validateWireResult(requestId, value) {
  if (!exactKeys(value, ["requestId", "text", "sessionId", "ms", "fresh"])) {
    throw new ProtocolInputError(400, "Runner result 不符合共享契约");
  }
  if (value.requestId !== requestId) {
    throw new ProtocolInputError(409, "Runner result.requestId 与投递不一致");
  }
  try {
    return normalizeRunnerResult(requestId, value);
  } catch (error) {
    throw new ProtocolInputError(400, error.message);
  }
}

const EVENT_FIELDS = Object.freeze({
  started: ["requestId", "sequence", "at", "kind", "fresh"],
  delta: ["requestId", "sequence", "at", "kind", "text"],
  thought: ["requestId", "sequence", "at", "kind", "text"],
  progress: ["requestId", "sequence", "at", "kind", "label"],
  usage: null,
  completed: ["requestId", "sequence", "at", "kind", "result"],
  failed: ["requestId", "sequence", "at", "kind", "error"],
});

function validateWireEvent(requestId, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolInputError(400, "Runner event 必须是对象");
  }
  if (!RUNNER_EVENT_KINDS.includes(value.kind)) {
    throw new ProtocolInputError(400, "Runner event.kind 无效");
  }
  const expected =
    value.kind === "usage"
      ? [
          "requestId",
          "sequence",
          "at",
          "kind",
          ...["input", "output", "total", "window", "costUsd"].filter(
            (field) => value[field] !== undefined,
          ),
        ]
      : EVENT_FIELDS[value.kind];
  if (!exactKeys(value, expected)) {
    throw new ProtocolInputError(400, `Runner ${value.kind} event 含未知或缺失字段`);
  }
  if (
    value.requestId !== requestId ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !nonEmptyString(value.at) ||
    !Number.isFinite(Date.parse(value.at))
  ) {
    throw new ProtocolInputError(400, "Runner event 基础字段无效");
  }

  if (value.kind === "started" && typeof value.fresh !== "boolean") {
    throw new ProtocolInputError(400, "started.fresh 必须是 boolean");
  }
  if (
    (value.kind === "delta" || value.kind === "thought") &&
    (typeof value.text !== "string" || value.text.length === 0)
  ) {
    throw new ProtocolInputError(400, `${value.kind}.text 必须是非空字符串`);
  }
  if (value.kind === "progress" && !nonEmptyString(value.label)) {
    throw new ProtocolInputError(400, "progress.label 必须是非空字符串");
  }
  if (value.kind === "usage") {
    for (const field of ["input", "output", "total", "window", "costUsd"]) {
      const amount = value[field];
      if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) {
        throw new ProtocolInputError(400, `usage.${field} 必须是非负有限数`);
      }
    }
  }
  if (value.kind === "completed") validateWireResult(requestId, value.result);
  if (value.kind === "failed") validateWireError(requestId, value.error);
  return Object.freeze({ ...value });
}

class ProtocolInputError extends Error {
  constructor(
    status,
    message,
    code = "invalid_request",
    { closeConnection = false } = {},
  ) {
    super(message);
    this.name = "ProtocolInputError";
    this.status = status;
    this.code = code;
    this.closeConnection = closeConnection;
  }
}

export class RemoteAuthenticationError extends Error {
  constructor(message = "Remote Runner credential 被 Hub 拒绝") {
    super(message);
    this.name = "RemoteAuthenticationError";
  }
}

export class RemoteProtocolError extends Error {
  constructor(status, message, code = "protocol_error") {
    super(message);
    this.name = "RemoteProtocolError";
    this.status = status;
    this.code = code;
  }
}

function jsonResponse(response, status, value) {
  const body = value === undefined ? "" : `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "cache-control": "no-store",
    ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function failAndCloseRequest(request, response, status, value) {
  response.setHeader("connection", "close");
  response.once("finish", () => request.destroy());
  request.resume();
  jsonResponse(response, status, value);
}

export function readRemoteJsonBody(
  request,
  {
    maxBytes = REMOTE_BODY_LIMIT_BYTES,
    timeoutMs = REMOTE_BODY_TIMEOUT_MS,
    timerApi = { setTimeout, clearTimeout },
  } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("Remote body maxBytes 必须是正整数");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Remote body timeoutMs 必须是正整数");
  }
  if (
    !timerApi ||
    typeof timerApi.setTimeout !== "function" ||
    typeof timerApi.clearTimeout !== "function"
  ) {
    throw new TypeError("Remote body timerApi 必须提供 setTimeout / clearTimeout");
  }

  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer !== null) timerApi.clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveBody(value);
    };
    const rejectOnce = (error, { drain = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain) request.resume();
      rejectBody(error);
    };
    const rejectClosed = (status, message, code) => {
      rejectOnce(
        new ProtocolInputError(status, message, code, { closeConnection: true }),
        { drain: true },
      );
    };
    const onData = (chunk) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > maxBytes) {
        rejectClosed(413, "请求体过大", "payload_too_large");
        return;
      }
      chunks.push(value);
    };
    const onEnd = () => {
      try {
        resolveOnce(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectOnce(new ProtocolInputError(400, "请求体必须是 JSON"));
      }
    };
    const onAborted = () => {
      rejectOnce(
        new ProtocolInputError(400, "请求体不可用", "invalid_request", {
          closeConnection: true,
        }),
      );
    };
    const onError = () => {
      rejectOnce(
        new ProtocolInputError(400, "请求体不可用", "invalid_request", {
          closeConnection: true,
        }),
      );
    };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("aborted", onAborted);
    request.on("error", onError);

    timer = timerApi.setTimeout(() => {
      rejectClosed(408, "请求体读取超时", "request_timeout");
    }, timeoutMs);
    // An injected timer may fire synchronously. In that case cleanup ran while
    // the handle was not assigned yet, so release the returned handle here.
    if (settled && timer !== null) timerApi.clearTimeout(timer);

    const rawContentLength = request.headers?.["content-length"];
    if (
      typeof rawContentLength === "string" &&
      /^\d+$/u.test(rawContentLength) &&
      Number(rawContentLength) > maxBytes
    ) {
      rejectClosed(413, "请求体过大", "payload_too_large");
    }
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  // A transport shutdown may reject before a caller attaches its handler.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function placementFailure(message, cause) {
  return new RunnerDispatchError(
    runnerError({
      requestId: "unknown",
      code: RUNNER_ERROR_CODES.SESSION_FAILURE,
      message,
      retryable: false,
    }),
    cause,
  );
}

function validPlacementRecord(value) {
  return (
    exactKeys(value, ["user", "project", "agent", "hostId", "updatedAt"]) &&
    [value.user, value.project, value.agent, value.hostId, value.updatedAt].every(
      nonEmptyString,
    ) &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}

/**
 * Durable Hub placement index. It intentionally stores only the logical
 * session scope and credential-bound host id, never a vendor session id.
 */
export class RemotePlacementStore {
  constructor({ filePath } = {}) {
    if (!nonEmptyString(filePath)) {
      throw new TypeError("RemotePlacementStore.filePath 必须是非空字符串");
    }
    this.filePath = filePath;
    this.placements = new Map();

    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (
        parsed?.version !== PLACEMENT_FORMAT_VERSION ||
        parsed.placements === null ||
        typeof parsed.placements !== "object" ||
        Array.isArray(parsed.placements)
      ) {
        throw new Error("未知 placement store 格式");
      }
      for (const [key, record] of Object.entries(parsed.placements)) {
        if (!validPlacementRecord(record) || key !== sessionKey(record)) {
          throw new Error(`损坏的 placement 记录：${key}`);
        }
        this.placements.set(key, Object.freeze(clone(record)));
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw placementFailure(`无法读取 placement store：${filePath}`, error);
    }
  }

  has(scope) {
    return this.placements.has(sessionKey(scope));
  }

  getHostId(scope) {
    return this.placements.get(sessionKey(scope))?.hostId ?? null;
  }

  set(scope, hostId) {
    const key = sessionKey(scope);
    validateHostId(hostId);
    const record = Object.freeze({
      user: scope.user,
      project: scope.project,
      agent: scope.agent,
      hostId,
      updatedAt: new Date().toISOString(),
    });
    const candidate = new Map(this.placements);
    candidate.set(key, record);
    this.persist(candidate);
    this.placements = candidate;
    return clone(record);
  }

  delete(scope) {
    const key = sessionKey(scope);
    if (!this.placements.has(key)) return false;
    const candidate = new Map(this.placements);
    candidate.delete(key);
    this.persist(candidate);
    this.placements = candidate;
    return true;
  }

  persist(placements = this.placements) {
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify(
      {
        version: PLACEMENT_FORMAT_VERSION,
        placements: Object.fromEntries(placements),
      },
      null,
      2,
    )}\n`;
    try {
      writeFileSync(temp, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temp, this.filePath);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {}
      throw placementFailure(`无法写入 placement store：${this.filePath}`, error);
    }
  }
}

function requestLedgerFailure(requestId, message, cause) {
  return new RunnerDispatchError(
    runnerError({
      requestId,
      code: RUNNER_ERROR_CODES.UNAVAILABLE,
      message,
      retryable: true,
    }),
    cause,
  );
}

function validLedgerRecord(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !nonEmptyString(value.requestId) ||
    !/^[a-f0-9]{64}$/u.test(value.fingerprint) ||
    !["completed", "failed", "cancelled"].includes(value.state) ||
    !Array.isArray(value.events) ||
    !nonEmptyString(value.updatedAt) ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    return false;
  }
  const expected = [
    "requestId",
    "fingerprint",
    "state",
    "events",
    "updatedAt",
    value.state === "completed" ? "result" : "error",
  ];
  if (!exactKeys(value, expected)) return false;
  try {
    value.events.forEach((event, index) => {
      if (event.sequence !== index + 1) throw new Error("event sequence 不连续");
      validateWireEvent(value.requestId, event);
    });
    if (value.state === "completed") {
      validateWireResult(value.requestId, value.result);
      return value.events.at(-1)?.kind === "completed";
    }
    validateWireError(value.requestId, value.error);
    return value.events.at(-1)?.kind === "failed";
  } catch {
    return false;
  }
}

/**
 * Cold terminal ledger: one atomic 0600 file per request id. No prompt is
 * persisted, and lookup does not require an unbounded in-memory index.
 */
export class RemoteRequestLedger {
  constructor({ directoryPath } = {}) {
    if (!nonEmptyString(directoryPath)) {
      throw new TypeError("RemoteRequestLedger.directoryPath 必须是非空字符串");
    }
    this.directoryPath = directoryPath;
    try {
      mkdirSync(directoryPath, { recursive: true });
    } catch (error) {
      throw requestLedgerFailure(
        "unknown",
        `无法创建 remote request ledger：${directoryPath}`,
        error,
      );
    }
  }

  pathFor(requestId) {
    if (!nonEmptyString(requestId)) {
      throw new TypeError("RemoteRequestLedger.requestId 必须是非空字符串");
    }
    return join(this.directoryPath, `${sha256(requestId)}.json`);
  }

  get(requestId) {
    const path = this.pathFor(requestId);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (
        !exactKeys(parsed, ["version", "request"]) ||
        parsed.version !== REQUEST_LEDGER_FORMAT_VERSION ||
        !validLedgerRecord(parsed.request) ||
        parsed.request.requestId !== requestId
      ) {
        throw new Error("损坏或不匹配的 request ledger record");
      }
      return clone(parsed.request);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw requestLedgerFailure(
        requestId,
        `无法读取 remote request ledger：${path}`,
        error,
      );
    }
  }

  put(value) {
    const record = Object.freeze({
      ...clone(value),
      updatedAt: new Date().toISOString(),
    });
    if (!validLedgerRecord(record)) {
      throw new TypeError("remote request ledger record 不符合格式");
    }
    const path = this.pathFor(record.requestId);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify(
      { version: REQUEST_LEDGER_FORMAT_VERSION, request: record },
      null,
      2,
    )}\n`;
    try {
      writeFileSync(temp, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temp, path);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {}
      throw requestLedgerFailure(
        record.requestId,
        `无法写入 remote request ledger：${path}`,
        error,
      );
    }
    return clone(record);
  }
}

/**
 * Hub-side transport. It owns no adapter and exposes the same surface as a
 * LocalRunner; work is only claimed by an authenticated outbound worker poll.
 */
export class RemoteRunner {
  constructor({
    token,
    hostId,
    placementStore,
    requestLedger,
    pathPrefix = DEFAULT_PREFIX,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    leaseMs = DEFAULT_LEASE_MS,
    offerLeaseMs = DEFAULT_OFFER_LEASE_MS,
    livenessTimeoutMs = DEFAULT_LIVENESS_TIMEOUT_MS,
    closeGraceMs = DEFAULT_CLOSE_GRACE_MS,
    controlTimeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
    maxPending = 100,
    maxCompletedRequests = DEFAULT_MAX_COMPLETED_REQUESTS,
    maxPendingControls = DEFAULT_MAX_PENDING_CONTROLS,
    maxCompletedControls = DEFAULT_MAX_COMPLETED_CONTROLS,
    maxEventsPerRequest = DEFAULT_MAX_EVENTS_PER_REQUEST,
    maxEventGap = DEFAULT_MAX_EVENT_GAP,
    maxPollers = REMOTE_MAX_POLLERS,
    maxRequestBytes = REMOTE_REQUEST_LIMIT_BYTES,
    maxEventBytes = REMOTE_EVENT_LIMIT_BYTES,
    maxRequestEventBytes = REMOTE_REQUEST_EVENT_LIMIT_BYTES,
    maxCachedPayloadBytes = REMOTE_CACHED_PAYLOAD_LIMIT_BYTES,
  }) {
    validateToken(token, "RemoteRunner.token");
    if (!nonEmptyString(hostId))
      throw new TypeError("RemoteRunner.hostId 必须是 credential 绑定的非空字符串");
    if (
      !placementStore ||
      typeof placementStore.has !== "function" ||
      typeof placementStore.getHostId !== "function" ||
      typeof placementStore.set !== "function" ||
      typeof placementStore.delete !== "function"
    ) {
      throw new TypeError(
        "RemoteRunner.placementStore 必须实现 has / getHostId / set / delete",
      );
    }
    const resolvedRequestLedger =
      requestLedger ??
      (nonEmptyString(placementStore.filePath)
        ? new RemoteRequestLedger({
            directoryPath: `${placementStore.filePath}.requests`,
          })
        : null);
    if (
      !resolvedRequestLedger ||
      typeof resolvedRequestLedger.get !== "function" ||
      typeof resolvedRequestLedger.put !== "function"
    ) {
      throw new TypeError(
        "RemoteRunner.requestLedger 必须实现 get / put；无显式 ledger 时 placementStore 必须暴露 filePath",
      );
    }
    if (
      !nonEmptyString(pathPrefix) ||
      !pathPrefix.startsWith("/") ||
      pathPrefix === "/"
    ) {
      throw new TypeError("RemoteRunner.pathPrefix 必须是绝对 URL path");
    }
    for (const [label, value] of [
      ["pollTimeoutMs", pollTimeoutMs],
      ["leaseMs", leaseMs],
      ["offerLeaseMs", offerLeaseMs],
      ["livenessTimeoutMs", livenessTimeoutMs],
      ["closeGraceMs", closeGraceMs],
      ["controlTimeoutMs", controlTimeoutMs],
      ["maxPending", maxPending],
      ["maxCompletedRequests", maxCompletedRequests],
      ["maxPendingControls", maxPendingControls],
      ["maxCompletedControls", maxCompletedControls],
      ["maxEventsPerRequest", maxEventsPerRequest],
      ["maxEventGap", maxEventGap],
      ["maxPollers", maxPollers],
      ["maxRequestBytes", maxRequestBytes],
      ["maxEventBytes", maxEventBytes],
      ["maxRequestEventBytes", maxRequestEventBytes],
      ["maxCachedPayloadBytes", maxCachedPayloadBytes],
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`RemoteRunner.${label} 必须是正整数`);
      }
    }
    for (const [label, value, upperBound] of [
      ["pollTimeoutMs", pollTimeoutMs, REMOTE_POLL_TIMEOUT_MS],
      ["maxRequestBytes", maxRequestBytes, REMOTE_REQUEST_LIMIT_BYTES],
      ["maxEventBytes", maxEventBytes, REMOTE_EVENT_LIMIT_BYTES],
      ["maxRequestEventBytes", maxRequestEventBytes, REMOTE_REQUEST_EVENT_LIMIT_BYTES],
      ["maxCachedPayloadBytes", maxCachedPayloadBytes, REMOTE_CACHED_PAYLOAD_LIMIT_BYTES],
      ["maxPollers", maxPollers, REMOTE_MAX_POLLERS],
    ]) {
      if (value > upperBound) {
        throw new TypeError(`RemoteRunner.${label} 不得超过 staging hard limit`);
      }
    }
    if (maxEventsPerRequest < 2) {
      throw new TypeError("RemoteRunner.maxEventsPerRequest 必须至少为 2");
    }
    if (maxRequestEventBytes < maxEventBytes) {
      throw new TypeError("RemoteRunner.maxRequestEventBytes 不得小于 maxEventBytes");
    }
    if (maxCachedPayloadBytes < maxEventBytes) {
      throw new TypeError("RemoteRunner.maxCachedPayloadBytes 不得小于 maxEventBytes");
    }

    this.token = token;
    this.hostId = hostId;
    this.placementStore = placementStore;
    this.requestLedger = resolvedRequestLedger;
    this.pathPrefix = pathPrefix.replace(/\/$/, "");
    this.pollTimeoutMs = pollTimeoutMs;
    this.leaseMs = leaseMs;
    this.offerLeaseMs = offerLeaseMs;
    this.livenessTimeoutMs = livenessTimeoutMs;
    this.closeGraceMs = closeGraceMs;
    this.controlTimeoutMs = controlTimeoutMs;
    this.maxPending = maxPending;
    this.maxCompletedRequests = maxCompletedRequests;
    this.maxPendingControls = maxPendingControls;
    this.maxCompletedControls = maxCompletedControls;
    this.maxEventsPerRequest = maxEventsPerRequest;
    this.maxEventGap = maxEventGap;
    this.maxPollers = maxPollers;
    this.maxRequestBytes = maxRequestBytes;
    this.maxEventBytes = maxEventBytes;
    this.maxRequestEventBytes = maxRequestEventBytes;
    this.maxCachedPayloadBytes = maxCachedPayloadBytes;
    this.cachedPayloadBytes = 0;
    this.requests = new Map();
    this.controls = new Map();
    this.completedControls = new Map();
    this.pollers = new Set();
    this.closed = false;
    this.closePromise = null;
    this.lastSeenAt = 0;
  }

  dispatch(value, { onEvent } = {}) {
    const request = validateDispatchRequest(value);
    if (this.closed) {
      return Promise.reject(
        transportError(
          request.requestId,
          "Remote Runner 已关闭",
          true,
          RUNNER_ERROR_CODES.UNAVAILABLE,
        ),
      );
    }
    const placementHost = this.placementStore.getHostId(request);
    if (placementHost !== null && placementHost !== this.hostId) {
      return Promise.reject(
        transportError(
          request.requestId,
          `session placement 属于其他 host：${placementHost}`,
          true,
          RUNNER_ERROR_CODES.UNAVAILABLE,
        ),
      );
    }
    const digest = requestFingerprint(request);
    const found = this.requests.get(request.requestId);
    if (found) {
      if (found.fingerprint !== digest) {
        return Promise.reject(
          transportError(
            request.requestId,
            "同一 requestId 不能对应不同 dispatch request",
            false,
            RUNNER_ERROR_CODES.INVALID_REQUEST,
          ),
        );
      }
      this.subscribe(found, onEvent);
      return found.deferred.promise;
    }
    const archived = this.requestLedger.get(request.requestId);
    if (archived) {
      if (archived.fingerprint !== digest) {
        return Promise.reject(
          transportError(
            request.requestId,
            "同一 requestId 不能对应不同 dispatch request",
            false,
            RUNNER_ERROR_CODES.INVALID_REQUEST,
          ),
        );
      }
      if (typeof onEvent === "function") {
        for (const event of archived.events) {
          try {
            onEvent(Object.freeze(clone(event)));
          } catch {}
        }
      }
      return archived.state === "completed"
        ? Promise.resolve(Object.freeze(clone(archived.result)))
        : Promise.reject(new RunnerDispatchError(Object.freeze(clone(archived.error))));
    }

    const active = [...this.requests.values()].filter(
      (record) => !record.terminal,
    ).length;
    if (active >= this.maxPending) {
      return Promise.reject(
        transportError(request.requestId, "Remote Runner 队列已满", true),
      );
    }

    const requestBytes = serializedBytes(request);
    if (requestBytes > this.maxRequestBytes) {
      return Promise.reject(
        transportError(
          request.requestId,
          "Remote Runner dispatch request bytes 超出限制",
          false,
          RUNNER_ERROR_CODES.INVALID_REQUEST,
        ),
      );
    }
    if (!pollWorkFits(projectedPollWork({ request }))) {
      return Promise.reject(
        transportError(
          request.requestId,
          "Remote Runner dispatch work bytes 超出限制",
          false,
          RUNNER_ERROR_CODES.INVALID_REQUEST,
        ),
      );
    }
    const reservedBytes = this.syntheticTerminalReserveBytes(request.requestId);
    if (!this.makeCachedPayloadCapacity(requestBytes + reservedBytes)) {
      return Promise.reject(
        transportError(
          request.requestId,
          "Remote Runner cached payload 容量不足",
          true,
          RUNNER_ERROR_CODES.UNAVAILABLE,
        ),
      );
    }

    const deferred = createDeferred();
    const record = {
      request,
      fingerprint: digest,
      deferred,
      state: "pending",
      // Placement comes from the credential-bound composition root, never
      // from a worker-controlled request body.
      assignedHostId: this.hostId,
      delivery: 0,
      leaseId: null,
      leaseUntil: 0,
      eventDigests: new Map(),
      bufferedEvents: new Map(),
      events: [],
      eventBytes: 0,
      payloadBytes: requestBytes,
      reservedBytes,
      nextSequence: 1,
      listeners: new Map(),
      terminal: false,
      completedAt: 0,
      cancelOperation: null,
    };
    this.requests.set(request.requestId, record);
    this.cachedPayloadBytes += requestBytes + reservedBytes;
    this.subscribe(record, onEvent);
    this.wakePollers();
    return deferred.promise;
  }

  deliver(record, listener, event) {
    const delivered = record.listeners.get(listener);
    if (delivered === undefined || delivered >= event.sequence) return;
    record.listeners.set(listener, event.sequence);
    try {
      listener(event);
    } catch {}
  }

  subscribe(record, listener) {
    if (typeof listener !== "function") return;
    if (!record.listeners.has(listener)) record.listeners.set(listener, 0);
    for (const event of record.events) this.deliver(record, listener, event);
    if (record.terminal) record.listeners.delete(listener);
  }

  hasSession(scope) {
    return this.placementStore.getHostId(scope) === this.hostId;
  }

  resetSession(scopeValue) {
    if (this.closed)
      return Promise.reject(
        transportError(
          "unknown",
          "Remote Runner 已关闭",
          true,
          RUNNER_ERROR_CODES.UNAVAILABLE,
        ),
      );
    const scope = validateScope(scopeValue);
    const key = sessionKey(scope);
    const placementHost = this.placementStore.getHostId(scope);
    if (placementHost !== null && placementHost !== this.hostId) {
      return Promise.reject(
        transportError(
          "unknown",
          `session placement 属于其他 host：${placementHost}`,
          true,
          RUNNER_ERROR_CODES.UNAVAILABLE,
        ),
      );
    }
    if (this.controls.size >= this.maxPendingControls) {
      return Promise.reject(
        transportError(
          "unknown",
          "Remote Runner control 队列已满",
          true,
          RUNNER_ERROR_CODES.UNAVAILABLE,
        ),
      );
    }
    const controlId = randomUUID();
    const projectedControl = {
      controlId,
      kind: "reset-session",
      scope,
    };
    if (!pollWorkFits(projectedPollWork(projectedControl))) {
      return Promise.reject(
        transportError(
          "unknown",
          "Remote Runner control work bytes 超出限制",
          false,
          RUNNER_ERROR_CODES.INVALID_REQUEST,
        ),
      );
    }
    const deferred = createDeferred();
    const control = {
      controlId,
      kind: "reset-session",
      scope,
      assignedHostId: this.hostId,
      state: "pending",
      delivery: 0,
      leaseId: null,
      leaseUntil: 0,
      deferred,
      key,
      waitFor: new Set(
        [...this.requests.values()]
          .filter((record) => !record.terminal && sessionKey(record.request) === key)
          .map((record) => record.request.requestId),
      ),
    };
    this.controls.set(control.controlId, control);
    this.armControlTimeout(control);
    this.wakePollers();
    return deferred.promise;
  }

  cancel(requestId) {
    if (!nonEmptyString(requestId)) {
      return Promise.reject(
        transportError(
          "unknown",
          "cancel.requestId 必须是非空字符串",
          false,
          RUNNER_ERROR_CODES.INVALID_REQUEST,
        ),
      );
    }
    const record = this.requests.get(requestId);
    if (!record) {
      const archived = this.requestLedger.get(requestId);
      if (archived?.state === "cancelled") {
        return Promise.resolve(cancelResult(requestId, RUNNER_CANCEL_OUTCOMES.CANCELLED));
      }
      if (archived) {
        return Promise.resolve(
          cancelResult(requestId, RUNNER_CANCEL_OUTCOMES.ALREADY_TERMINAL),
        );
      }
      return Promise.resolve(cancelResult(requestId, RUNNER_CANCEL_OUTCOMES.NOT_FOUND));
    }
    if (record.state === "cancelled") {
      return Promise.resolve(cancelResult(requestId, RUNNER_CANCEL_OUTCOMES.CANCELLED));
    }
    if (record.terminal) {
      return Promise.resolve(
        cancelResult(requestId, RUNNER_CANCEL_OUTCOMES.ALREADY_TERMINAL),
      );
    }
    if (record.state === "pending" || record.state === "offered") {
      this.cancelPendingRecord(record);
      return Promise.resolve(cancelResult(requestId, RUNNER_CANCEL_OUTCOMES.CANCELLED));
    }
    if (record.cancelOperation) return record.cancelOperation;
    if (this.controls.size >= this.maxPendingControls) {
      return Promise.reject(
        transportError(
          requestId,
          "Remote Runner control 队列已满",
          true,
          RUNNER_ERROR_CODES.UNAVAILABLE,
        ),
      );
    }

    const controlId = randomUUID();
    const projectedControl = { controlId, kind: "cancel", requestId };
    if (!pollWorkFits(projectedPollWork(projectedControl))) {
      return Promise.reject(
        transportError(
          requestId,
          "Remote Runner control work bytes 超出限制",
          false,
          RUNNER_ERROR_CODES.INVALID_REQUEST,
        ),
      );
    }
    const deferred = createDeferred();
    const control = {
      controlId,
      kind: "cancel",
      requestId,
      assignedHostId: record.assignedHostId,
      state: "pending",
      delivery: 0,
      leaseId: null,
      leaseUntil: 0,
      deferred,
      waitFor: new Set(),
    };
    this.controls.set(control.controlId, control);
    this.armControlTimeout(control);
    record.cancelOperation = deferred.promise;
    this.wakePollers();
    return record.cancelOperation;
  }

  cancelPendingRecord(record, requestedError) {
    if (record.terminal) return;
    const observedFailure = record.events.at(-1);
    const error =
      requestedError ??
      (observedFailure?.kind === "failed"
        ? observedFailure.error
        : runnerError({
            requestId: record.request.requestId,
            code: RUNNER_ERROR_CODES.CANCELLED,
            message: "Runner request 已取消",
            retryable: false,
          }));
    let event = null;
    if (observedFailure?.kind !== "failed") {
      event = runnerLifecycleEvent(
        record.request.requestId,
        record.nextSequence,
        "failed",
        error,
      );
    }
    const terminalPayload = this.planTerminalPayload(record, [
      ...(event ? [event] : []),
      error,
    ]);
    this.archiveTerminalRecord(
      record,
      error.code === RUNNER_ERROR_CODES.CANCELLED ? "cancelled" : "failed",
      undefined,
      error,
      event ? [...record.events, event] : record.events,
    );
    this.applyTerminalPayload(record, terminalPayload);
    if (event) {
      record.eventDigests.set(event.sequence, sha256(fingerprint(event)));
      record.events.push(event);
      record.nextSequence++;
    }
    record.state = error.code === RUNNER_ERROR_CODES.CANCELLED ? "cancelled" : "failed";
    record.error = error;
    record.terminal = true;
    record.completedAt = Date.now();
    if (event) {
      for (const listener of [...record.listeners.keys()]) {
        this.deliver(record, listener, event);
      }
    }
    record.listeners.clear();
    record.deferred.reject(new RunnerDispatchError(error));
    if (!terminalPayload.cache) {
      this.removeCachedRequest(record.request.requestId, record);
    }
    this.trimCompletedRequests();
    this.wakePollers();
  }

  removeCachedRequest(requestId, record) {
    if (this.requests.get(requestId) !== record) return false;
    this.requests.delete(requestId);
    this.cachedPayloadBytes = Math.max(
      0,
      this.cachedPayloadBytes - record.payloadBytes - record.reservedBytes,
    );
    return true;
  }

  syntheticTerminalReserveBytes(requestId) {
    return Math.max(
      ...[
        [RUNNER_ERROR_CODES.CANCELLED, "Runner request 已取消"],
        [RUNNER_ERROR_CODES.INTERNAL, "Remote Runner cached payload 超出限制"],
        [RUNNER_ERROR_CODES.INTERNAL, "dispatch event bytes 超出限制"],
        [RUNNER_ERROR_CODES.INTERNAL, "Remote Runner event buffer 超出限制"],
      ].map(([code, message]) => {
        const error = runnerError({ requestId, code, message, retryable: false });
        const event = runnerLifecycleEvent(requestId, 1, "failed", error);
        return serializedBytes(error) + serializedBytes(event);
      }),
    );
  }

  makeCachedPayloadCapacity(additionalBytes) {
    if (this.cachedPayloadBytes + additionalBytes <= this.maxCachedPayloadBytes) {
      return true;
    }
    for (const [requestId, record] of this.requests) {
      if (!record.terminal) continue;
      this.removeCachedRequest(requestId, record);
      if (this.cachedPayloadBytes + additionalBytes <= this.maxCachedPayloadBytes) {
        return true;
      }
    }
    return false;
  }

  planTerminalPayload(record, values) {
    const actualBytes = values.reduce(
      (total, value) => total + serializedBytes(value),
      0,
    );
    const additionalBytes = actualBytes - record.reservedBytes;
    return Object.freeze({
      actualBytes,
      additionalBytes,
      cache: additionalBytes <= 0 || this.makeCachedPayloadCapacity(additionalBytes),
    });
  }

  applyTerminalPayload(record, plan) {
    if (!plan.cache) return;
    record.payloadBytes += plan.actualBytes;
    record.reservedBytes = 0;
    this.cachedPayloadBytes += plan.additionalBytes;
  }

  rejectCachedPayload(
    record,
    {
      message = "Remote Runner cached payload 超出限制",
      code = "cached_payload_exceeded",
    } = {},
  ) {
    record.bufferedEvents.clear();
    this.cancelPendingRecord(
      record,
      runnerError({
        requestId: record.request.requestId,
        code: RUNNER_ERROR_CODES.INTERNAL,
        message,
        retryable: false,
      }),
    );
    this.removeCachedRequest(record.request.requestId, record);
    throw new ProtocolInputError(413, message, code);
  }

  trimCompletedRequests() {
    let completed = [...this.requests.values()].filter(
      (record) => record.terminal,
    ).length;
    if (completed <= this.maxCompletedRequests) return;
    for (const [requestId, record] of this.requests) {
      if (!record.terminal) continue;
      this.removeCachedRequest(requestId, record);
      completed--;
      if (completed <= this.maxCompletedRequests) break;
    }
  }

  archiveTerminalRecord(record, state, result, error, events = record.events) {
    this.requestLedger.put({
      requestId: record.request.requestId,
      fingerprint: record.fingerprint,
      state,
      events,
      ...(state === "completed" ? { result } : { error }),
    });
  }

  rememberCompletedControl(controlId, value) {
    this.completedControls.set(controlId, Object.freeze(value));
    while (this.completedControls.size > this.maxCompletedControls) {
      this.completedControls.delete(this.completedControls.keys().next().value);
    }
  }

  armControlTimeout(control) {
    control.timeout = setTimeout(() => {
      if (this.controls.get(control.controlId) !== control) return;
      this.controls.delete(control.controlId);
      if (control.kind === "cancel") {
        const record = this.requests.get(control.requestId);
        if (record?.cancelOperation === control.deferred.promise) {
          record.cancelOperation = null;
        }
      }
      control.deferred.reject(
        transportError(
          control.requestId ?? "unknown",
          "Remote Runner control 超时，执行端不可用",
          true,
          RUNNER_ERROR_CODES.UNAVAILABLE,
        ),
      );
      this.wakePollers();
    }, this.controlTimeoutMs);
    control.timeout.unref?.();
  }

  health() {
    let inflight = 0;
    let queued = 0;
    for (const record of this.requests.values()) {
      if (record.state === "offered" || record.state === "inflight") inflight++;
      if (record.state === "pending") queued++;
    }
    return Object.freeze({
      ready:
        !this.closed &&
        this.lastSeenAt > 0 &&
        Date.now() - this.lastSeenAt <= this.livenessTimeoutMs,
      hostId: this.hostId,
      inflight,
      queued,
    });
  }

  claim(hostId, { acceptDispatch = true, acceptControl = true } = {}) {
    const now = Date.now();
    for (const control of acceptControl ? this.controls.values() : []) {
      if (
        (control.state === "pending" || control.leaseUntil <= now) &&
        control.assignedHostId === hostId &&
        [...control.waitFor].every(
          (requestId) => this.requests.get(requestId)?.terminal !== false,
        )
      ) {
        const delivery = control.delivery + 1;
        const leaseId = randomUUID();
        const work = Object.freeze(
          assertPollWorkFits(controlPollWork(control, delivery, leaseId)),
        );
        control.state = "offered";
        control.delivery = delivery;
        control.leaseId = leaseId;
        control.leaseUntil = now + this.offerLeaseMs;
        this.expireOffer(work);
        return work;
      }
    }
    for (const record of acceptDispatch ? this.requests.values() : []) {
      if (
        !record.terminal &&
        (record.state === "pending" || record.leaseUntil <= now) &&
        record.assignedHostId === hostId &&
        ![...this.requests.values()].some(
          (other) =>
            other !== record &&
            !other.terminal &&
            (other.state === "offered" || other.state === "inflight") &&
            sessionKey(other.request) === sessionKey(record.request),
        )
      ) {
        const delivery = record.delivery + 1;
        const leaseId = randomUUID();
        const work = Object.freeze(
          assertPollWorkFits(dispatchPollWork(record.request, delivery, leaseId)),
        );
        record.state = "offered";
        record.delivery = delivery;
        record.leaseId = leaseId;
        record.leaseUntil = now + this.offerLeaseMs;
        this.expireOffer(work);
        return work;
      }
    }
    return null;
  }

  expireOffer(work) {
    const timer = setTimeout(() => {
      if (work.kind === "dispatch") {
        const record = this.requests.get(work.request.requestId);
        if (
          record &&
          !record.terminal &&
          record.state === "offered" &&
          record.delivery === work.delivery &&
          record.leaseId === work.leaseId
        ) {
          record.state = "pending";
          record.leaseUntil = 0;
          this.wakePollers();
        }
        return;
      }
      const control = this.controls.get(work.controlId);
      if (
        control &&
        control.state === "offered" &&
        control.delivery === work.delivery &&
        control.leaseId === work.leaseId
      ) {
        control.state = "pending";
        control.leaseUntil = 0;
        this.wakePollers();
      }
    }, this.offerLeaseMs);
    timer.unref?.();
  }

  waitForWork(hostId, capabilities, signal) {
    if (signal?.aborted) return Promise.resolve(null);
    const immediate = this.claim(hostId, capabilities);
    if (immediate || this.closed) return Promise.resolve(immediate);
    if (this.pollers.size >= this.maxPollers) {
      return Promise.reject(
        new ProtocolInputError(429, "Remote Runner poll capacity 已满", "poll_capacity", {
          closeConnection: true,
        }),
      );
    }
    return new Promise((resolve) => {
      const poller = {
        hostId,
        capabilities,
        settled: false,
        finish: (work) => {
          if (poller.settled) return;
          poller.settled = true;
          clearTimeout(poller.timer);
          signal?.removeEventListener("abort", poller.abort);
          this.pollers.delete(poller);
          resolve(work);
        },
      };
      poller.abort = () => poller.finish(null);
      poller.timer = setTimeout(() => poller.finish(null), this.pollTimeoutMs);
      if (signal?.aborted) {
        poller.finish(null);
        return;
      }
      signal?.addEventListener("abort", poller.abort, { once: true });
      this.pollers.add(poller);
      if (signal?.aborted) poller.abort();
    });
  }

  wakePollers() {
    for (const poller of [...this.pollers]) {
      const work = this.claim(poller.hostId, poller.capabilities);
      if (work) poller.finish(work);
    }
  }

  releaseClaim(work) {
    if (work?.kind === "dispatch") {
      const record = this.requests.get(work.request.requestId);
      if (
        record &&
        !record.terminal &&
        (record.state === "offered" || record.state === "inflight") &&
        record.delivery === work.delivery &&
        record.leaseId === work.leaseId
      ) {
        record.state = "pending";
        record.leaseUntil = 0;
      }
    } else if (work?.controlId) {
      const control = this.controls.get(work.controlId);
      if (
        control &&
        (control.state === "offered" || control.state === "inflight") &&
        control.delivery === work.delivery &&
        control.leaseId === work.leaseId
      ) {
        control.state = "pending";
        control.leaseUntil = 0;
      }
    }
    queueMicrotask(() => this.wakePollers());
  }

  recordForHost(requestId, hostId) {
    const record = this.requests.get(requestId);
    if (!record) throw new ProtocolInputError(404, "未知 requestId", "unknown_work");
    if (record.assignedHostId !== hostId) {
      throw new ProtocolInputError(403, "该 request 不属于当前 host");
    }
    return record;
  }

  assertDelivery(item, delivery, leaseId, label) {
    if (!Number.isSafeInteger(delivery) || delivery < 1) {
      throw new ProtocolInputError(400, `${label} delivery 无效`);
    }
    if (!nonEmptyString(leaseId)) {
      throw new ProtocolInputError(400, `${label} leaseId 无效`);
    }
    if (item.delivery !== delivery || item.leaseId !== leaseId) {
      throw new ProtocolInputError(409, `${label} fence 已过期`, "stale_delivery");
    }
  }

  assertActiveLease(item, delivery, leaseId, label) {
    this.assertDelivery(item, delivery, leaseId, label);
    if (item.state !== "inflight" || item.leaseUntil <= Date.now()) {
      if (item.state === "inflight" || item.state === "offered") {
        item.state = "pending";
        item.leaseUntil = 0;
        queueMicrotask(() => this.wakePollers());
      }
      throw new ProtocolInputError(
        409,
        `${label} lease 已过期或尚未确认`,
        "stale_delivery",
      );
    }
  }

  acceptAck(hostId, body) {
    if (body.requestId !== undefined) {
      const record = this.recordForHost(body.requestId, hostId);
      this.assertDelivery(record, body.delivery, body.leaseId, "dispatch");
      if (record.terminal) return false;
      if (record.leaseUntil <= Date.now()) {
        record.state = "pending";
        record.leaseUntil = 0;
        this.wakePollers();
        throw new ProtocolInputError(
          409,
          "dispatch offer/lease 已过期",
          "stale_delivery",
        );
      }
      if (record.state === "offered") {
        record.state = "inflight";
        record.leaseUntil = Date.now() + this.leaseMs;
      } else if (record.state !== "inflight") {
        throw new ProtocolInputError(409, "dispatch 当前不可确认", "stale_delivery");
      }
      return true;
    }

    const control = this.controls.get(body.controlId);
    if (!control) {
      const completed = this.completedControls.get(body.controlId);
      if (completed)
        this.assertDelivery(completed, body.delivery, body.leaseId, "control");
      return false;
    }
    if (control.assignedHostId !== hostId) {
      throw new ProtocolInputError(403, "该 control 不属于当前 host");
    }
    this.assertDelivery(control, body.delivery, body.leaseId, "control");
    if (control.leaseUntil <= Date.now()) {
      control.state = "pending";
      control.leaseUntil = 0;
      this.wakePollers();
      throw new ProtocolInputError(409, "control offer/lease 已过期", "stale_delivery");
    }
    if (control.state === "offered") {
      control.state = "inflight";
      control.leaseUntil = Date.now() + this.leaseMs;
    } else if (control.state !== "inflight") {
      throw new ProtocolInputError(409, "control 当前不可确认", "stale_delivery");
    }
    return true;
  }

  acceptHeartbeat(hostId, body) {
    const item =
      body.requestId !== undefined
        ? this.recordForHost(body.requestId, hostId)
        : this.controls.get(body.controlId);
    if (!item) throw new ProtocolInputError(404, "未知 controlId", "unknown_work");
    if (item.assignedHostId !== hostId) {
      throw new ProtocolInputError(403, "该 work 不属于当前 host");
    }
    if (item.terminal) {
      this.assertDelivery(item, body.delivery, body.leaseId, "dispatch");
      return false;
    }
    this.assertActiveLease(
      item,
      body.delivery,
      body.leaseId,
      body.requestId !== undefined ? "dispatch" : "control",
    );
    item.leaseUntil = Date.now() + this.leaseMs;
    return true;
  }

  acceptEvent(hostId, requestId, delivery, leaseId, value) {
    const record = this.recordForHost(requestId, hostId);
    this.assertDelivery(record, delivery, leaseId, "dispatch");
    const event = validateWireEvent(requestId, value);
    const serializedEvent = fingerprint(event);
    const eventBytes = Buffer.byteLength(serializedEvent, "utf8");
    const digest = sha256(serializedEvent);
    const prior = record.eventDigests.get(event.sequence);
    if (record.terminal) {
      if (prior === digest) return true;
      throw new ProtocolInputError(
        409,
        "request 已终止，不能追加或修改 event",
        "conflict",
      );
    }
    this.assertActiveLease(record, delivery, leaseId, "dispatch");
    if (prior !== undefined) {
      if (prior !== digest)
        throw new ProtocolInputError(409, "同一 event sequence 内容冲突", "conflict");
      return true;
    }
    if (
      eventBytes > this.maxEventBytes ||
      record.eventBytes + eventBytes > this.maxRequestEventBytes
    ) {
      this.rejectCachedPayload(record, {
        message: "dispatch event bytes 超出限制",
        code: "event_bytes_exceeded",
      });
    }
    if (
      event.sequence > this.maxEventsPerRequest ||
      event.sequence - record.nextSequence > this.maxEventGap ||
      record.events.length + record.bufferedEvents.size >= this.maxEventsPerRequest
    ) {
      record.bufferedEvents.clear();
      this.cancelPendingRecord(
        record,
        runnerError({
          requestId,
          code: RUNNER_ERROR_CODES.INTERNAL,
          message: "Remote Runner event buffer 超出限制",
          retryable: false,
        }),
      );
      throw new ProtocolInputError(413, "dispatch event buffer 超出限制");
    }
    if (!this.makeCachedPayloadCapacity(eventBytes)) {
      this.rejectCachedPayload(record);
    }
    record.leaseUntil = Date.now() + this.leaseMs;
    record.eventDigests.set(event.sequence, digest);
    record.eventBytes += eventBytes;
    record.payloadBytes += eventBytes;
    this.cachedPayloadBytes += eventBytes;
    record.bufferedEvents.set(event.sequence, event);
    while (record.bufferedEvents.has(record.nextSequence)) {
      const next = record.bufferedEvents.get(record.nextSequence);
      record.bufferedEvents.delete(record.nextSequence);
      record.nextSequence++;
      record.events.push(next);
      for (const listener of [...record.listeners.keys()]) {
        this.deliver(record, listener, next);
      }
    }
    return false;
  }

  acceptResult(hostId, requestId, delivery, leaseId, value) {
    const record = this.recordForHost(requestId, hostId);
    this.assertDelivery(record, delivery, leaseId, "dispatch");
    const result = validateWireResult(requestId, value);
    if (record.terminal) {
      if (record.result && fingerprint(record.result) === fingerprint(result))
        return true;
      throw new ProtocolInputError(409, "request 已用不同结果完成", "conflict");
    }
    this.assertActiveLease(record, delivery, leaseId, "dispatch");
    const last = record.events.at(-1);
    if (
      record.bufferedEvents.size > 0 ||
      last?.kind !== "completed" ||
      fingerprint(last.result) !== fingerprint(result)
    ) {
      throw new ProtocolInputError(409, "完成结果前缺少连续且匹配的 completed event");
    }
    const terminalPayload = this.planTerminalPayload(record, [result]);
    if (result.sessionId) this.placementStore.set(record.request, hostId);
    else this.placementStore.delete(record.request);
    this.archiveTerminalRecord(record, "completed", result);
    this.applyTerminalPayload(record, terminalPayload);
    record.terminal = true;
    record.state = "completed";
    record.result = result;
    record.completedAt = Date.now();
    record.listeners.clear();
    record.deferred.resolve(result);
    if (!terminalPayload.cache) {
      this.removeCachedRequest(requestId, record);
    }
    this.trimCompletedRequests();
    this.wakePollers();
    return false;
  }

  acceptFailure(hostId, requestId, delivery, leaseId, value) {
    const record = this.recordForHost(requestId, hostId);
    this.assertDelivery(record, delivery, leaseId, "dispatch");
    const error = validateWireError(requestId, value);
    if (record.terminal) {
      if (record.error && fingerprint(record.error) === fingerprint(error)) return true;
      throw new ProtocolInputError(409, "request 已用不同错误结束", "conflict");
    }
    this.assertActiveLease(record, delivery, leaseId, "dispatch");
    const last = record.events.at(-1);
    if (
      record.bufferedEvents.size > 0 ||
      last?.kind !== "failed" ||
      fingerprint(last.error) !== fingerprint(error)
    ) {
      throw new ProtocolInputError(409, "失败结果前缺少连续且匹配的 failed event");
    }
    const terminalPayload = this.planTerminalPayload(record, [error]);
    this.archiveTerminalRecord(
      record,
      error.code === RUNNER_ERROR_CODES.CANCELLED ? "cancelled" : "failed",
      undefined,
      error,
    );
    this.applyTerminalPayload(record, terminalPayload);
    record.terminal = true;
    record.state = error.code === RUNNER_ERROR_CODES.CANCELLED ? "cancelled" : "failed";
    record.error = error;
    record.completedAt = Date.now();
    record.listeners.clear();
    record.deferred.reject(new RunnerDispatchError(error));
    if (!terminalPayload.cache) {
      this.removeCachedRequest(requestId, record);
    }
    this.trimCompletedRequests();
    this.wakePollers();
    return false;
  }

  acceptControl(hostId, controlId, delivery, leaseId, ok, resultValue, errorValue) {
    const control = this.controls.get(controlId);
    const digest = sha256(
      fingerprint(ok === true ? { ok, result: resultValue } : { ok, error: errorValue }),
    );
    if (!control) {
      const completed = this.completedControls.get(controlId);
      if (!completed) throw new ProtocolInputError(404, "未知 controlId", "unknown_work");
      if (completed.assignedHostId !== hostId) {
        throw new ProtocolInputError(403, "该 control 不属于当前 host");
      }
      this.assertDelivery(completed, delivery, leaseId, "control");
      if (completed.digest !== digest) {
        throw new ProtocolInputError(409, "control 已用不同 reply 结束", "conflict");
      }
      return true;
    }
    if (control.assignedHostId !== hostId) {
      throw new ProtocolInputError(403, "该 control 不属于当前 host");
    }
    this.assertActiveLease(control, delivery, leaseId, "control");

    let result;
    let error;
    if (ok === true) {
      if (control.kind === "reset-session") {
        if (resultValue !== undefined) {
          throw new ProtocolInputError(400, "reset-session reply 不得包含 result");
        }
      } else {
        result = validateCancelResult(control.requestId, resultValue);
      }
    } else {
      error = validateWireError("unknown", errorValue);
    }

    // All validation and durable placement mutation happen before removing the
    // live control, so a malformed or failed write remains retryable.
    if (ok === true && control.kind === "reset-session") {
      this.placementStore.delete(control.scope);
    }
    clearTimeout(control.timeout);
    this.controls.delete(controlId);
    this.rememberCompletedControl(controlId, {
      assignedHostId: control.assignedHostId,
      delivery,
      leaseId,
      digest,
    });
    if (ok === true) control.deferred.resolve(result);
    else control.deferred.reject(new RunnerDispatchError(error));
    return false;
  }

  authorized(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    return safeEqual(header.slice(7), this.token);
  }

  boundHost(value) {
    const hostId = validateHostId(value);
    if (hostId !== this.hostId) {
      throw new ProtocolInputError(403, "hostId 不被此 Remote Runner 接受");
    }
    this.lastSeenAt = Date.now();
    return hostId;
  }

  /** Mount this on a Node HTTP server; returns false for paths outside its prefix. */
  async handleHttp(request, response) {
    const url = new URL(request.url ?? "/", "http://runner.invalid");
    if (
      url.pathname !== this.pathPrefix &&
      !url.pathname.startsWith(`${this.pathPrefix}/`)
    ) {
      return false;
    }
    if (!this.authorized(request)) {
      response.setHeader("www-authenticate", 'Bearer realm="agent-os-runner"');
      failAndCloseRequest(request, response, 401, { error: "unauthorized" });
      return true;
    }
    if (request.method !== "POST") {
      failAndCloseRequest(request, response, 405, { error: "method_not_allowed" });
      return true;
    }

    try {
      const body = await readRemoteJsonBody(request);
      const route = url.pathname.slice(this.pathPrefix.length);
      if (route === "/poll") {
        if (
          !exactKeys(body, ["hostId", "acceptDispatch", "acceptControl"]) ||
          typeof body.acceptDispatch !== "boolean" ||
          typeof body.acceptControl !== "boolean"
        ) {
          throw new ProtocolInputError(400, "poll body 无效");
        }
        const hostId = this.boundHost(body.hostId);
        // The bearer credential selects this instance. `body.hostId` is only a
        // consistency assertion against that server-derived principal.
        const controller = new AbortController();
        const abortPoll = () => controller.abort();
        request.once("aborted", abortPoll);
        response.once("close", abortPoll);
        let work;
        try {
          work = await this.waitForWork(
            hostId,
            {
              acceptDispatch: body.acceptDispatch,
              acceptControl: body.acceptControl,
            },
            controller.signal,
          );
        } finally {
          request.off("aborted", abortPoll);
          response.off("close", abortPoll);
        }
        if (response.destroyed) {
          if (work) this.releaseClaim(work);
          return true;
        }
        if (work) jsonResponse(response, 200, work);
        else jsonResponse(response, 204);
        return true;
      }
      if (route === "/event") {
        if (
          !exactKeys(body, ["hostId", "requestId", "delivery", "leaseId", "event"]) ||
          !Number.isSafeInteger(body.delivery) ||
          body.delivery < 1 ||
          !nonEmptyString(body.leaseId)
        ) {
          throw new ProtocolInputError(400, "event body 无效");
        }
        const duplicate = this.acceptEvent(
          this.boundHost(body.hostId),
          body.requestId,
          body.delivery,
          body.leaseId,
          body.event,
        );
        jsonResponse(response, 200, { accepted: true, duplicate });
        return true;
      }
      if (route === "/ack") {
        const dispatchAck = exactKeys(body, [
          "hostId",
          "requestId",
          "delivery",
          "leaseId",
        ]);
        const controlAck = exactKeys(body, [
          "hostId",
          "controlId",
          "delivery",
          "leaseId",
        ]);
        if (
          (!dispatchAck && !controlAck) ||
          !Number.isSafeInteger(body.delivery) ||
          body.delivery < 1 ||
          !nonEmptyString(body.leaseId)
        ) {
          throw new ProtocolInputError(400, "ack body 无效");
        }
        const accepted = this.acceptAck(this.boundHost(body.hostId), body);
        jsonResponse(response, 200, { accepted, leaseMs: this.leaseMs });
        return true;
      }
      if (route === "/heartbeat") {
        const dispatchHeartbeat = exactKeys(body, [
          "hostId",
          "requestId",
          "delivery",
          "leaseId",
        ]);
        const controlHeartbeat = exactKeys(body, [
          "hostId",
          "controlId",
          "delivery",
          "leaseId",
        ]);
        if (
          (!dispatchHeartbeat && !controlHeartbeat) ||
          !Number.isSafeInteger(body.delivery) ||
          body.delivery < 1 ||
          !nonEmptyString(body.leaseId)
        ) {
          throw new ProtocolInputError(400, "heartbeat body 无效");
        }
        const accepted = this.acceptHeartbeat(this.boundHost(body.hostId), body);
        jsonResponse(response, 200, { accepted, leaseMs: this.leaseMs });
        return true;
      }
      if (route === "/complete") {
        if (
          !exactKeys(body, ["hostId", "requestId", "delivery", "leaseId", "result"]) ||
          !Number.isSafeInteger(body.delivery) ||
          body.delivery < 1 ||
          !nonEmptyString(body.leaseId)
        ) {
          throw new ProtocolInputError(400, "complete body 无效");
        }
        const duplicate = this.acceptResult(
          this.boundHost(body.hostId),
          body.requestId,
          body.delivery,
          body.leaseId,
          body.result,
        );
        jsonResponse(response, 200, { accepted: true, duplicate });
        return true;
      }
      if (route === "/fail") {
        if (
          !exactKeys(body, ["hostId", "requestId", "delivery", "leaseId", "error"]) ||
          !Number.isSafeInteger(body.delivery) ||
          body.delivery < 1 ||
          !nonEmptyString(body.leaseId)
        ) {
          throw new ProtocolInputError(400, "fail body 无效");
        }
        const duplicate = this.acceptFailure(
          this.boundHost(body.hostId),
          body.requestId,
          body.delivery,
          body.leaseId,
          body.error,
        );
        jsonResponse(response, 200, { accepted: true, duplicate });
        return true;
      }
      if (route === "/control") {
        const validSuccess =
          body?.ok === true &&
          (exactKeys(body, ["hostId", "controlId", "delivery", "leaseId", "ok"]) ||
            exactKeys(body, [
              "hostId",
              "controlId",
              "delivery",
              "leaseId",
              "ok",
              "result",
            ]));
        const validFailure =
          body?.ok === false &&
          exactKeys(body, ["hostId", "controlId", "delivery", "leaseId", "ok", "error"]);
        if (
          (!validSuccess && !validFailure) ||
          !Number.isSafeInteger(body.delivery) ||
          body.delivery < 1 ||
          !nonEmptyString(body.leaseId)
        ) {
          throw new ProtocolInputError(400, "control body 无效");
        }
        const duplicate = this.acceptControl(
          this.boundHost(body.hostId),
          body.controlId,
          body.delivery,
          body.leaseId,
          body.ok,
          body.result,
          body.error,
        );
        jsonResponse(response, 200, { accepted: true, duplicate });
        return true;
      }
      jsonResponse(response, 404, { error: "not_found" });
    } catch (error) {
      if (request.aborted || response.destroyed) return true;
      const status = error instanceof ProtocolInputError ? error.status : 500;
      if (error instanceof ProtocolInputError && error.closeConnection) {
        failAndCloseRequest(request, response, status, {
          error: error.code,
          message: error.message,
        });
        return true;
      }
      jsonResponse(response, status, {
        error:
          status === 500
            ? "internal_error"
            : error instanceof ProtocolInputError
              ? error.code
              : "invalid_request",
        message:
          status === 500
            ? "Remote Runner transport 发生内部错误"
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
    return true;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const cancellations = [];
    for (const record of this.requests.values()) {
      if (record.terminal) continue;
      if (record.state === "pending" || record.state === "offered") {
        this.cancelPendingRecord(record);
      } else cancellations.push(this.cancel(record.request.requestId));
    }
    this.closePromise = (async () => {
      let timer;
      await Promise.race([
        Promise.allSettled(cancellations),
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.closeGraceMs);
        }),
      ]);
      clearTimeout(timer);
      for (const record of this.requests.values()) {
        if (!record.terminal) this.cancelPendingRecord(record);
      }
      for (const control of this.controls.values()) {
        clearTimeout(control.timeout);
        control.deferred.reject(
          transportError(
            control.requestId ?? "unknown",
            "Remote Runner 已关闭",
            true,
            RUNNER_ERROR_CODES.UNAVAILABLE,
          ),
        );
      }
      this.controls.clear();
      for (const poller of [...this.pollers]) poller.finish(null);
    })();
    return this.closePromise;
  }
}

function abortableDelay(ms, signal, timerApi = { setTimeout, clearTimeout }) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", finish);
      if (timer !== null) timerApi.clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
    timer = timerApi.setTimeout(finish, ms);
    if (finished && timer !== null) timerApi.clearTimeout(timer);
  });
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Abort/parse failures can already have errored the stream. Either way the
    // response is no longer reusable and no raw body is surfaced.
  }
}

export async function readRemoteResponseBody(
  response,
  { maxBytes = REMOTE_BODY_LIMIT_BYTES } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("Remote response body maxBytes 必须是正整数");
  }
  if (maxBytes > REMOTE_BODY_LIMIT_BYTES) {
    throw new TypeError("Remote response body maxBytes 不得超过 staging hard limit");
  }
  if (!response?.body) return null;

  const rawContentLength = response.headers?.get?.("content-length");
  if (
    typeof rawContentLength === "string" &&
    /^\d+$/u.test(rawContentLength) &&
    Number(rawContentLength) > maxBytes
  ) {
    await cancelResponseBody(response);
    throw new RemoteProtocolError(
      response.status,
      "Hub 响应体超出限制",
      "response_too_large",
    );
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) {
        complete = true;
        break;
      }
      const chunk = Buffer.from(item.value);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        throw new RemoteProtocolError(
          response.status,
          "Hub 响应体超出限制",
          "response_too_large",
        );
      }
      chunks.push(chunk);
    }
  } finally {
    if (!complete) {
      try {
        await reader.cancel();
      } catch {
        // The controller may already have aborted the stream.
      }
    }
    reader.releaseLock();
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new RemoteProtocolError(response.status, "Hub 返回了非 JSON 响应");
  }
}

function retryableFetchError(error) {
  return !(
    error instanceof RemoteAuthenticationError || error instanceof RemoteProtocolError
  );
}

function orphanedDeliveryError(error) {
  return (
    error instanceof RemoteProtocolError &&
    (error.code === "unknown_work" || error.code === "stale_delivery")
  );
}

export const REMOTE_WORKER_STOP_FAILURE_MESSAGE = "Remote Runner Worker stop failed";

export class RemoteWorkerStopError extends Error {
  constructor(code) {
    super(REMOTE_WORKER_STOP_FAILURE_MESSAGE);
    this.name = "RemoteWorkerStopError";
    this.code = code;
  }
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve(promise).catch((error) => {
        if (error instanceof RemoteWorkerStopError) throw error;
        throw new RemoteWorkerStopError("close_failed");
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new RemoteWorkerStopError("deadline_exceeded")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execution-side client. It exposes no socket: every poll, event and result is
 * an authenticated outbound HTTP request to the Hub-side RemoteRunner.
 */
export class RemoteRunnerWorker {
  constructor({
    url,
    token,
    hostId,
    runner,
    pathPrefix = DEFAULT_PREFIX,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    reconnectMaxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
    maxCompleted = 1000,
    maxConcurrentDispatches = DEFAULT_MAX_CONCURRENT_DISPATCHES,
    maxConcurrentControls = DEFAULT_MAX_CONCURRENT_CONTROLS,
    maxEventsPerExecution = DEFAULT_MAX_EVENTS_PER_REQUEST,
    maxRequestBytes = REMOTE_REQUEST_LIMIT_BYTES,
    maxEventBytes = REMOTE_EVENT_LIMIT_BYTES,
    maxExecutionPayloadBytes = REMOTE_EXECUTION_PAYLOAD_LIMIT_BYTES,
    maxCachedPayloadBytes = REMOTE_CACHED_PAYLOAD_LIMIT_BYTES,
    maxResponseBytes = REMOTE_BODY_LIMIT_BYTES,
    requestTimeoutMs = REMOTE_BODY_TIMEOUT_MS,
    pollResponseTimeoutMs = REMOTE_POLL_RESPONSE_TIMEOUT_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    onState,
    random = Math.random,
    retryTimerApi = { setTimeout, clearTimeout },
    requestTimerApi = { setTimeout, clearTimeout },
  }) {
    const baseUrl = validateRemoteUrl(url);
    validateToken(token, "RemoteRunnerWorker.token");
    validateHostId(hostId);
    if (
      !runner ||
      typeof runner.dispatch !== "function" ||
      typeof runner.cancel !== "function" ||
      typeof runner.resetSession !== "function"
    ) {
      throw new TypeError(
        "RemoteRunnerWorker.runner 必须实现 dispatch / cancel / resetSession",
      );
    }
    if (typeof fetchImpl !== "function") {
      throw new TypeError("RemoteRunnerWorker.fetchImpl 必须是函数");
    }
    if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 1) {
      throw new TypeError("RemoteRunnerWorker.reconnectDelayMs 必须是正整数");
    }
    if (
      !Number.isSafeInteger(reconnectMaxDelayMs) ||
      reconnectMaxDelayMs < reconnectDelayMs
    ) {
      throw new TypeError(
        "RemoteRunnerWorker.reconnectMaxDelayMs 必须是不小于 reconnectDelayMs 的正整数",
      );
    }
    if (typeof random !== "function") {
      throw new TypeError("RemoteRunnerWorker.random 必须是函数");
    }
    if (
      !retryTimerApi ||
      typeof retryTimerApi.setTimeout !== "function" ||
      typeof retryTimerApi.clearTimeout !== "function"
    ) {
      throw new TypeError(
        "RemoteRunnerWorker.retryTimerApi 必须提供 setTimeout / clearTimeout",
      );
    }
    for (const [label, value] of [
      ["maxCompleted", maxCompleted],
      ["maxConcurrentDispatches", maxConcurrentDispatches],
      ["maxConcurrentControls", maxConcurrentControls],
      ["maxEventsPerExecution", maxEventsPerExecution],
      ["maxRequestBytes", maxRequestBytes],
      ["maxEventBytes", maxEventBytes],
      ["maxExecutionPayloadBytes", maxExecutionPayloadBytes],
      ["maxCachedPayloadBytes", maxCachedPayloadBytes],
      ["maxResponseBytes", maxResponseBytes],
      ["requestTimeoutMs", requestTimeoutMs],
      ["pollResponseTimeoutMs", pollResponseTimeoutMs],
      ["stopTimeoutMs", stopTimeoutMs],
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`RemoteRunnerWorker.${label} 必须是正整数`);
      }
    }
    if (maxEventsPerExecution < 2) {
      throw new TypeError("RemoteRunnerWorker.maxEventsPerExecution 必须至少为 2");
    }
    for (const [label, value, upperBound] of [
      ["maxRequestBytes", maxRequestBytes, REMOTE_REQUEST_LIMIT_BYTES],
      ["maxEventBytes", maxEventBytes, REMOTE_EVENT_LIMIT_BYTES],
      [
        "maxExecutionPayloadBytes",
        maxExecutionPayloadBytes,
        REMOTE_EXECUTION_PAYLOAD_LIMIT_BYTES,
      ],
      ["maxCachedPayloadBytes", maxCachedPayloadBytes, REMOTE_CACHED_PAYLOAD_LIMIT_BYTES],
      ["maxResponseBytes", maxResponseBytes, REMOTE_BODY_LIMIT_BYTES],
      ["requestTimeoutMs", requestTimeoutMs, REMOTE_BODY_TIMEOUT_MS],
      ["pollResponseTimeoutMs", pollResponseTimeoutMs, REMOTE_POLL_RESPONSE_TIMEOUT_MS],
    ]) {
      if (value > upperBound) {
        throw new TypeError(`RemoteRunnerWorker.${label} 不得超过 staging hard limit`);
      }
    }
    if (maxExecutionPayloadBytes < maxEventBytes) {
      throw new TypeError(
        "RemoteRunnerWorker.maxExecutionPayloadBytes 不得小于 maxEventBytes",
      );
    }
    if (maxCachedPayloadBytes < maxEventBytes) {
      throw new TypeError(
        "RemoteRunnerWorker.maxCachedPayloadBytes 不得小于 maxEventBytes",
      );
    }
    if (pollResponseTimeoutMs < requestTimeoutMs) {
      throw new TypeError(
        "RemoteRunnerWorker.pollResponseTimeoutMs 不得小于 requestTimeoutMs",
      );
    }
    if (
      !nonEmptyString(pathPrefix) ||
      !pathPrefix.startsWith("/") ||
      pathPrefix === "/"
    ) {
      throw new TypeError("RemoteRunnerWorker.pathPrefix 必须是绝对 URL path");
    }
    if (
      !requestTimerApi ||
      typeof requestTimerApi.setTimeout !== "function" ||
      typeof requestTimerApi.clearTimeout !== "function"
    ) {
      throw new TypeError(
        "RemoteRunnerWorker.requestTimerApi 必须提供 setTimeout / clearTimeout",
      );
    }

    this.baseUrl = baseUrl;
    this.token = token;
    this.hostId = hostId;
    this.runner = runner;
    this.pathPrefix = pathPrefix.replace(/\/$/, "");
    this.reconnectDelayMs = reconnectDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.maxCompleted = maxCompleted;
    this.maxConcurrentDispatches = maxConcurrentDispatches;
    this.maxConcurrentControls = maxConcurrentControls;
    this.maxEventsPerExecution = maxEventsPerExecution;
    this.maxRequestBytes = maxRequestBytes;
    this.maxEventBytes = maxEventBytes;
    this.maxExecutionPayloadBytes = maxExecutionPayloadBytes;
    this.maxCachedPayloadBytes = maxCachedPayloadBytes;
    this.maxResponseBytes = maxResponseBytes;
    this.requestTimeoutMs = requestTimeoutMs;
    this.pollResponseTimeoutMs = pollResponseTimeoutMs;
    this.cachedPayloadBytes = 0;
    this.stopTimeoutMs = stopTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.onState = onState ?? (() => {});
    this.random = random;
    this.retryTimerApi = retryTimerApi;
    this.requestTimerApi = requestTimerApi;
    this.executions = new Map();
    this.completedControls = new Map();
    this.stopController = null;
    this.pollController = null;
    this.pollCapabilities = null;
    this.requestControllers = new Set();
    this.activeOperations = new Set();
    this.activeDispatches = 0;
    this.activeControls = 0;
    this.loopPromise = null;
    this.fatalError = null;
    this.runnerClosed = false;
    this.runnerClosePromise = null;
    this.stopPromise = null;
  }

  emitState(state, detail) {
    try {
      this.onState({ state, ...(detail ? { detail } : {}) });
    } catch {}
  }

  start() {
    if (this.loopPromise) return this;
    this.stopController = new AbortController();
    this.loopPromise = this.loop(this.stopController.signal);
    void this.loopPromise.catch(() => {});
    return this;
  }

  wait() {
    if (!this.loopPromise) throw new Error("RemoteRunnerWorker 尚未 start");
    return this.loopPromise;
  }

  endpoint(path) {
    return new URL(`${this.pathPrefix}${path}`, this.baseUrl);
  }

  async fetchOnce(path, body, signal) {
    const requestController = new AbortController();
    this.requestControllers.add(requestController);
    const abort = () => requestController.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    let response = null;
    let deadline = null;
    let bodyDeadline = null;
    let timedOut = false;
    let bodyHandled = false;
    try {
      const onTimeout = () => {
        timedOut = true;
        requestController.abort();
      };
      deadline = this.requestTimerApi.setTimeout(
        onTimeout,
        path === "/poll" ? this.pollResponseTimeoutMs : this.requestTimeoutMs,
      );
      deadline?.unref?.();
      response = await this.fetchImpl(this.endpoint(path), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: requestController.signal,
      });
      if (path === "/poll" && response.body) {
        bodyDeadline = this.requestTimerApi.setTimeout(onTimeout, this.requestTimeoutMs);
        bodyDeadline?.unref?.();
      }
      if (response.status === 401 || response.status === 403) {
        await cancelResponseBody(response);
        bodyHandled = true;
        throw new RemoteAuthenticationError();
      }
      if (response.status >= 500) {
        await cancelResponseBody(response);
        bodyHandled = true;
        throw new Error("Hub 暂时不可用");
      }
      const parsed = await readRemoteResponseBody(response, {
        maxBytes: this.maxResponseBytes,
      });
      bodyHandled = true;
      if (!response.ok) {
        throw new RemoteProtocolError(
          response.status,
          "Hub 拒绝了 Remote Runner 请求",
          nonEmptyString(parsed?.error) ? parsed.error : "protocol_error",
        );
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      if (timedOut) {
        throw new Error("Hub 响应读取超时");
      }
      if (requestController.signal.aborted) {
        throw new Error("Remote Runner request aborted");
      }
      throw error;
    } finally {
      if (response && !bodyHandled) await cancelResponseBody(response);
      if (deadline !== null) this.requestTimerApi.clearTimeout(deadline);
      if (bodyDeadline !== null) this.requestTimerApi.clearTimeout(bodyDeadline);
      signal?.removeEventListener("abort", abort);
      this.requestControllers.delete(requestController);
    }
  }

  reconnectBackoffMs(attempt) {
    const exponent = Math.min(attempt, 30);
    const ceiling = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectDelayMs * 2 ** exponent,
    );
    let sample = 0.5;
    try {
      const candidate = this.random();
      if (Number.isFinite(candidate)) sample = Math.min(1, Math.max(0, candidate));
    } catch {
      // A broken entropy source must not remove the retry bound.
    }
    return Math.max(1, Math.floor(ceiling / 2 + (ceiling / 2) * sample));
  }

  waitBeforeReconnect(attempt, signal) {
    return abortableDelay(this.reconnectBackoffMs(attempt), signal, this.retryTimerApi);
  }

  async sendWithReconnect(path, body, signal) {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        return await this.fetchOnce(path, body, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        if (!retryableFetchError(error)) throw error;
        this.emitState(
          "reconnecting",
          error instanceof Error ? error.message : String(error),
        );
        await this.waitBeforeReconnect(attempt++, signal);
      }
    }
    throw new Error("Remote Runner Worker 已停止");
  }

  validateWork(value) {
    if (value?.kind === "dispatch") {
      if (!exactKeys(value, ["kind", "request", "delivery", "leaseId"])) {
        throw new RemoteProtocolError(200, "Hub dispatch envelope 无效");
      }
      if (
        !Number.isSafeInteger(value.delivery) ||
        value.delivery < 1 ||
        !nonEmptyString(value.leaseId)
      ) {
        throw new RemoteProtocolError(200, "Hub dispatch delivery 无效");
      }
      return Object.freeze({
        kind: "dispatch",
        request: validateDispatchRequest(value.request),
        delivery: value.delivery,
        leaseId: value.leaseId,
      });
    }
    if (value?.kind === "reset-session") {
      if (!exactKeys(value, ["kind", "controlId", "scope", "delivery", "leaseId"])) {
        throw new RemoteProtocolError(200, "Hub control envelope 无效");
      }
      if (
        !nonEmptyString(value.controlId) ||
        !Number.isSafeInteger(value.delivery) ||
        value.delivery < 1 ||
        !nonEmptyString(value.leaseId)
      ) {
        throw new RemoteProtocolError(200, "Hub control 字段无效");
      }
      return Object.freeze({
        kind: "reset-session",
        controlId: value.controlId,
        scope: validateScope(value.scope),
        delivery: value.delivery,
        leaseId: value.leaseId,
      });
    }
    if (value?.kind === "cancel") {
      if (!exactKeys(value, ["kind", "controlId", "requestId", "delivery", "leaseId"])) {
        throw new RemoteProtocolError(200, "Hub cancel control envelope 无效");
      }
      if (
        !nonEmptyString(value.controlId) ||
        !nonEmptyString(value.requestId) ||
        !Number.isSafeInteger(value.delivery) ||
        value.delivery < 1 ||
        !nonEmptyString(value.leaseId)
      ) {
        throw new RemoteProtocolError(200, "Hub cancel control 字段无效");
      }
      return Object.freeze({
        kind: "cancel",
        controlId: value.controlId,
        requestId: value.requestId,
        delivery: value.delivery,
        leaseId: value.leaseId,
      });
    }
    throw new RemoteProtocolError(200, "Hub 返回未知 work kind");
  }

  async poll(signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    this.pollController = controller;
    const capabilities = {
      acceptDispatch: this.activeDispatches < this.maxConcurrentDispatches,
      acceptControl: this.activeControls < this.maxConcurrentControls,
    };
    this.pollCapabilities = capabilities;
    try {
      const response = await this.fetchOnce(
        "/poll",
        {
          hostId: this.hostId,
          ...capabilities,
        },
        controller.signal,
      );
      if (response.status === 204) return null;
      return this.validateWork(response.body);
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.pollController === controller) {
        this.pollController = null;
        this.pollCapabilities = null;
      }
    }
  }

  async acknowledge(work, signal) {
    const response = await this.sendWithReconnect(
      "/ack",
      work.kind === "dispatch"
        ? {
            hostId: this.hostId,
            requestId: work.request.requestId,
            delivery: work.delivery,
            leaseId: work.leaseId,
          }
        : {
            hostId: this.hostId,
            controlId: work.controlId,
            delivery: work.delivery,
            leaseId: work.leaseId,
          },
      signal,
    );
    if (
      !exactKeys(response.body, ["accepted", "leaseMs"]) ||
      typeof response.body.accepted !== "boolean" ||
      !Number.isSafeInteger(response.body.leaseMs) ||
      response.body.leaseMs < 1
    ) {
      throw new RemoteProtocolError(200, "Hub ack response 无效");
    }
    return Object.freeze({
      accepted: response.body.accepted,
      leaseMs: response.body.leaseMs,
    });
  }

  postEvent(requestId, delivery, leaseId, event, signal) {
    return this.sendWithReconnect(
      "/event",
      { hostId: this.hostId, requestId, delivery, leaseId, event },
      signal,
    );
  }

  postOutcome(entry, delivery, leaseId, signal) {
    if (entry.result) {
      return this.sendWithReconnect(
        "/complete",
        {
          hostId: this.hostId,
          requestId: entry.request.requestId,
          delivery,
          leaseId,
          result: entry.result,
        },
        signal,
      );
    }
    return this.sendWithReconnect(
      "/fail",
      {
        hostId: this.hostId,
        requestId: entry.request.requestId,
        delivery,
        leaseId,
        error: entry.error,
      },
      signal,
    );
  }

  async replayExecution(entry, delivery, leaseId, signal) {
    for (const event of entry.events) {
      await this.postEvent(entry.request.requestId, delivery, leaseId, event, signal);
    }
    await this.postOutcome(entry, delivery, leaseId, signal);
  }

  workerTerminalReserveBytes(requestId) {
    const error = runnerError({
      requestId,
      code: RUNNER_ERROR_CODES.INTERNAL,
      message: "Remote Runner Worker payload cache 超出限制",
      retryable: false,
    });
    const event = runnerLifecycleEvent(
      requestId,
      this.maxEventsPerExecution,
      "failed",
      error,
    );
    return serializedBytes(error) + serializedBytes(event);
  }

  removeExecution(requestId, entry) {
    if (this.executions.get(requestId) !== entry) return false;
    this.executions.delete(requestId);
    this.cachedPayloadBytes = Math.max(
      0,
      this.cachedPayloadBytes - entry.payloadBytes - entry.reservedBytes,
    );
    return true;
  }

  removeControlExecution(controlId, entry) {
    if (this.completedControls.get(controlId) !== entry) return false;
    this.completedControls.delete(controlId);
    this.cachedPayloadBytes = Math.max(0, this.cachedPayloadBytes - entry.payloadBytes);
    return true;
  }

  makeExecutionPayloadCapacity(additionalBytes) {
    if (this.cachedPayloadBytes + additionalBytes <= this.maxCachedPayloadBytes) {
      return true;
    }
    for (const [requestId, entry] of this.executions) {
      if (!entry.settled || entry.pins > 0) continue;
      this.removeExecution(requestId, entry);
      if (this.cachedPayloadBytes + additionalBytes <= this.maxCachedPayloadBytes) {
        return true;
      }
    }
    for (const [controlId, entry] of this.completedControls) {
      if (!entry.settled || entry.pins > 0) continue;
      this.removeControlExecution(controlId, entry);
      if (this.cachedPayloadBytes + additionalBytes <= this.maxCachedPayloadBytes) {
        return true;
      }
    }
    return false;
  }

  cacheControlOutcome(entry) {
    let value = entry.error ?? entry.result;
    let payloadBytes = 0;
    try {
      payloadBytes = value === null ? 0 : serializedBytes(value);
    } catch {
      payloadBytes = this.maxEventBytes + 1;
    }
    if (
      payloadBytes > this.maxEventBytes ||
      !this.makeExecutionPayloadCapacity(payloadBytes)
    ) {
      entry.result = null;
      entry.error = runnerError({
        requestId: "unknown",
        code: RUNNER_ERROR_CODES.SESSION_FAILURE,
        message: "Remote Runner Worker control payload 超出限制",
        retryable: false,
      });
      value = entry.error;
      payloadBytes = serializedBytes(value);
      if (!this.makeExecutionPayloadCapacity(payloadBytes)) {
        throw new RemoteProtocolError(
          503,
          "Remote Runner Worker control cache 容量不足",
          "cache_capacity",
        );
      }
    }
    entry.payloadBytes = payloadBytes;
    this.cachedPayloadBytes += payloadBytes;
  }

  adjustExecutionPayload(
    entry,
    { payloadDelta = 0, reservedBytes = entry.reservedBytes } = {},
  ) {
    const nextPayloadBytes = entry.payloadBytes + payloadDelta;
    const nextAccountedBytes = nextPayloadBytes + reservedBytes;
    const currentAccountedBytes = entry.payloadBytes + entry.reservedBytes;
    const additionalBytes = nextAccountedBytes - currentAccountedBytes;
    if (
      !Number.isSafeInteger(nextPayloadBytes) ||
      nextPayloadBytes < 0 ||
      !Number.isSafeInteger(reservedBytes) ||
      reservedBytes < 0 ||
      nextAccountedBytes > this.maxExecutionPayloadBytes
    ) {
      return false;
    }
    if (additionalBytes > 0 && !this.makeExecutionPayloadCapacity(additionalBytes)) {
      return false;
    }
    entry.payloadBytes = nextPayloadBytes;
    entry.reservedBytes = reservedBytes;
    this.cachedPayloadBytes += additionalBytes;
    return true;
  }

  trimExecutions() {
    if (this.executions.size <= this.maxCompleted) return;
    for (const [requestId, entry] of this.executions) {
      if (entry.settled && entry.pins === 0) this.removeExecution(requestId, entry);
      if (this.executions.size <= this.maxCompleted) break;
    }
  }

  markOrphaned(entry, leaseId) {
    entry.orphanedDeliveries.add(leaseId);
  }

  async transmit(entry, leaseId, operation) {
    if (entry.orphanedDeliveries.has(leaseId)) return false;
    try {
      await operation();
      return true;
    } catch (error) {
      if (!orphanedDeliveryError(error)) throw error;
      this.markOrphaned(entry, leaseId);
      return false;
    }
  }

  heartbeatBody(work) {
    return work.kind === "dispatch"
      ? {
          hostId: this.hostId,
          requestId: work.request.requestId,
          delivery: work.delivery,
          leaseId: work.leaseId,
        }
      : {
          hostId: this.hostId,
          controlId: work.controlId,
          delivery: work.delivery,
          leaseId: work.leaseId,
        };
  }

  startHeartbeat(work, leaseMs, signal, onOrphaned) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const intervalMs = Math.max(1, Math.floor(leaseMs / 3));
    const promise = (async () => {
      while (!controller.signal.aborted) {
        await abortableDelay(intervalMs, controller.signal);
        if (controller.signal.aborted) break;
        try {
          const response = await this.fetchOnce(
            "/heartbeat",
            this.heartbeatBody(work),
            controller.signal,
          );
          if (
            !exactKeys(response.body, ["accepted", "leaseMs"]) ||
            typeof response.body.accepted !== "boolean" ||
            !Number.isSafeInteger(response.body.leaseMs) ||
            response.body.leaseMs < 1
          ) {
            throw new RemoteProtocolError(200, "Hub heartbeat response 无效");
          }
          if (!response.body.accepted) {
            onOrphaned();
            break;
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          if (orphanedDeliveryError(error)) {
            onOrphaned();
            break;
          }
          if (retryableFetchError(error)) {
            this.emitState(
              "reconnecting",
              error instanceof Error ? error.message : String(error),
            );
            continue;
          }
          this.fatalError ??= error;
          this.stopController?.abort(error);
          break;
        }
      }
    })();
    void promise.catch((error) => {
      this.fatalError ??= error;
      this.stopController?.abort(error);
    });
    return async () => {
      controller.abort();
      signal.removeEventListener("abort", abort);
      await promise.catch(() => {});
    };
  }

  async execute(request, entry, delivery, leaseId, signal) {
    let deliveries = Promise.resolve();
    const queueEvent = (event) => {
      deliveries = deliveries.then(() =>
        this.transmit(entry, leaseId, () =>
          this.postEvent(request.requestId, delivery, leaseId, event, signal),
        ),
      );
      void deliveries.catch(() => {});
    };
    const cacheEvent = (event) => {
      const eventBytes = serializedBytes(event);
      if (eventBytes > this.maxEventBytes) return false;
      const terminalValue =
        event.kind === "completed"
          ? event.result
          : event.kind === "failed"
            ? event.error
            : undefined;
      const reservedBytes =
        terminalValue === undefined
          ? entry.reservedBytes
          : serializedBytes(terminalValue);
      if (
        !this.adjustExecutionPayload(entry, {
          payloadDelta: eventBytes,
          reservedBytes,
        })
      ) {
        return false;
      }
      entry.events.push(event);
      queueEvent(event);
      return true;
    };
    const overflow = () => {
      if (entry.overflowed) return;
      entry.overflowed = true;
      entry.result = null;
      entry.error = runnerError({
        requestId: request.requestId,
        code: RUNNER_ERROR_CODES.INTERNAL,
        message: "Remote Runner Worker payload cache 超出限制",
        retryable: false,
      });
      const failed = runnerLifecycleEvent(
        request.requestId,
        entry.events.length + 1,
        "failed",
        entry.error,
      );
      const failedBytes = serializedBytes(failed);
      const errorBytes = serializedBytes(entry.error);
      if (
        !this.adjustExecutionPayload(entry, {
          payloadDelta: failedBytes + errorBytes,
          reservedBytes: 0,
        })
      ) {
        throw new RemoteProtocolError(
          503,
          "Remote Runner Worker terminal reserve 不足",
          "cache_capacity",
        );
      }
      entry.events.push(failed);
      queueEvent(failed);
      void Promise.resolve()
        .then(() => this.runner.cancel(request.requestId))
        .catch(() => {});
    };
    const commitOutcome = (value) =>
      this.adjustExecutionPayload(entry, {
        payloadDelta: serializedBytes(value),
        reservedBytes: 0,
      });
    const onEvent = (event) => {
      if (entry.overflowed) return;
      const terminal = event.kind === "completed" || event.kind === "failed";
      const limit = terminal
        ? this.maxEventsPerExecution
        : this.maxEventsPerExecution - 1;
      if (entry.events.length >= limit || !cacheEvent(event)) overflow();
    };
    try {
      const result = await this.runner.dispatch(request, { onEvent });
      if (!entry.overflowed) {
        if (commitOutcome(result)) entry.result = result;
        else overflow();
      }
    } catch (error) {
      if (!entry.overflowed) {
        const observedError =
          error instanceof RunnerDispatchError
            ? error.error
            : runnerError({
                requestId: request.requestId,
                code: RUNNER_ERROR_CODES.INTERNAL,
                message: error instanceof Error ? error.message : String(error),
                retryable: false,
              });
        if (entry.events.at(-1)?.kind !== "failed") {
          onEvent(
            runnerLifecycleEvent(
              request.requestId,
              entry.events.length + 1,
              "failed",
              observedError,
            ),
          );
        }
        if (!entry.overflowed) {
          if (commitOutcome(observedError)) entry.error = observedError;
          else overflow();
        }
      }
    }
    await deliveries;
    await this.transmit(entry, leaseId, () =>
      this.postOutcome(entry, delivery, leaseId, signal),
    );
    entry.settled = true;
    this.trimExecutions();
  }

  async handleDispatch(work, leaseMs, signal) {
    const request = work.request;
    const serializedRequest = fingerprint(request);
    const digest = sha256(serializedRequest);
    const found = this.executions.get(request.requestId);
    if (found) {
      if (found.fingerprint !== digest) {
        throw new RemoteProtocolError(409, "Hub 对同一 requestId 投递了不同 request");
      }
      found.pins++;
      const stopHeartbeat = this.startHeartbeat(work, leaseMs, signal, () =>
        this.markOrphaned(found, work.leaseId),
      );
      try {
        await found.execution;
        await this.transmit(found, work.leaseId, () =>
          this.replayExecution(found, work.delivery, work.leaseId, signal),
        );
        return;
      } finally {
        try {
          await stopHeartbeat();
        } finally {
          found.orphanedDeliveries.delete(work.leaseId);
          found.pins--;
          this.trimExecutions();
        }
      }
    }
    const requestBytes = Buffer.byteLength(serializedRequest, "utf8");
    const reservedBytes = this.workerTerminalReserveBytes(request.requestId);
    if (
      requestBytes > this.maxRequestBytes ||
      requestBytes + reservedBytes > this.maxExecutionPayloadBytes
    ) {
      throw new RemoteProtocolError(
        413,
        "Hub dispatch request bytes 超出 Worker 限制",
        "payload_too_large",
      );
    }
    if (!this.makeExecutionPayloadCapacity(requestBytes + reservedBytes)) {
      throw new RemoteProtocolError(
        503,
        "Remote Runner Worker cached payload 容量不足",
        "cache_capacity",
      );
    }
    const entry = {
      request,
      fingerprint: digest,
      events: [],
      result: null,
      error: null,
      settled: false,
      overflowed: false,
      orphanedDeliveries: new Set(),
      execution: null,
      payloadBytes: requestBytes,
      reservedBytes,
      pins: 1,
    };
    this.executions.set(request.requestId, entry);
    this.cachedPayloadBytes += requestBytes + reservedBytes;
    const stopHeartbeat = this.startHeartbeat(work, leaseMs, signal, () =>
      this.markOrphaned(entry, work.leaseId),
    );
    try {
      entry.execution = this.execute(request, entry, work.delivery, work.leaseId, signal);
      await entry.execution;
    } finally {
      try {
        await stopHeartbeat();
      } finally {
        entry.orphanedDeliveries.delete(work.leaseId);
        entry.pins--;
        this.trimExecutions();
      }
    }
  }

  trimCompletedControlExecutions() {
    let completed = [...this.completedControls.values()].filter(
      (entry) => entry.settled,
    ).length;
    if (completed <= this.maxCompleted) return;
    for (const [controlId, entry] of this.completedControls) {
      if (!entry.settled || entry.pins > 0) continue;
      this.removeControlExecution(controlId, entry);
      completed--;
      if (completed <= this.maxCompleted) break;
    }
  }

  async postControl(entry, delivery, leaseId, signal) {
    await this.sendWithReconnect(
      "/control",
      {
        hostId: this.hostId,
        controlId: entry.controlId,
        delivery,
        leaseId,
        ok: entry.error === null,
        ...(entry.error === null
          ? entry.kind === "cancel"
            ? { result: entry.result }
            : {}
          : { error: entry.error }),
      },
      signal,
    );
  }

  async handleControl(work, leaseMs, signal) {
    const digest = sha256(
      fingerprint(
        work.kind === "cancel"
          ? { kind: work.kind, requestId: work.requestId }
          : { kind: work.kind, scope: work.scope },
      ),
    );
    let entry = this.completedControls.get(work.controlId);
    if (entry && entry.fingerprint !== digest) {
      throw new RemoteProtocolError(409, "Hub 对同一 controlId 投递了不同 control");
    }
    if (!entry) {
      entry = {
        controlId: work.controlId,
        kind: work.kind,
        fingerprint: digest,
        result: null,
        error: null,
        orphanedDeliveries: new Set(),
        execution: null,
        payloadBytes: 0,
        settled: false,
        pins: 0,
      };
      this.completedControls.set(work.controlId, entry);
      entry.execution = (async () => {
        try {
          if (work.kind === "cancel") {
            entry.result = await this.runner.cancel(work.requestId);
          } else {
            await this.runner.resetSession(work.scope);
            entry.result = null;
          }
        } catch (error) {
          entry.error = runnerError({
            requestId: "unknown",
            code: RUNNER_ERROR_CODES.SESSION_FAILURE,
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          });
        }
        try {
          this.cacheControlOutcome(entry);
        } catch (error) {
          this.removeControlExecution(work.controlId, entry);
          throw error;
        }
      })();
    }
    entry.pins++;
    const stopHeartbeat = this.startHeartbeat(work, leaseMs, signal, () =>
      this.markOrphaned(entry, work.leaseId),
    );
    try {
      await entry.execution;
      await this.transmit(entry, work.leaseId, () =>
        this.postControl(entry, work.delivery, work.leaseId, signal),
      );
      entry.settled = true;
      this.trimCompletedControlExecutions();
    } finally {
      try {
        await stopHeartbeat();
      } finally {
        entry.orphanedDeliveries.delete(work.leaseId);
        entry.pins--;
        this.trimCompletedControlExecutions();
      }
    }
  }

  launch(factory, signal, kind) {
    if (kind === "dispatch") this.activeDispatches++;
    else this.activeControls++;
    const tracked = Promise.resolve()
      .then(() => {
        if (signal.aborted) return undefined;
        return factory();
      })
      .catch((error) => {
        if (signal.aborted) return;
        this.fatalError ??= error;
        this.stopController?.abort(error);
      })
      .finally(() => {
        this.activeOperations.delete(tracked);
        if (kind === "dispatch") this.activeDispatches--;
        else this.activeControls--;
        if (
          (kind === "dispatch" && this.pollCapabilities?.acceptDispatch === false) ||
          (kind === "control" && this.pollCapabilities?.acceptControl === false)
        ) {
          this.pollController?.abort();
        }
      });
    this.activeOperations.add(tracked);
  }

  closeRunner() {
    if (this.runnerClosePromise) return this.runnerClosePromise;
    this.runnerClosed = true;
    this.runnerClosePromise = Promise.resolve().then(() => this.runner.close?.());
    void this.runnerClosePromise.catch(() => {});
    return this.runnerClosePromise;
  }

  async loop(signal) {
    this.emitState("connecting");
    let reconnectAttempt = 0;
    let loopFailure = null;
    try {
      while (!signal.aborted) {
        try {
          const work = await this.poll(signal);
          if (signal.aborted) break;
          reconnectAttempt = 0;
          this.emitState("connected");
          let acknowledgement;
          if (work) {
            try {
              acknowledgement = await this.acknowledge(work, signal);
            } catch (error) {
              if (orphanedDeliveryError(error)) continue;
              throw error;
            }
          }
          if (work && !acknowledgement.accepted) continue;
          if (work?.kind === "dispatch") {
            this.launch(
              () => this.handleDispatch(work, acknowledgement.leaseMs, signal),
              signal,
              "dispatch",
            );
          }
          if (work?.kind === "reset-session" || work?.kind === "cancel") {
            this.launch(
              () => this.handleControl(work, acknowledgement.leaseMs, signal),
              signal,
              "control",
            );
          }
        } catch (error) {
          if (signal.aborted) break;
          if (!retryableFetchError(error)) {
            this.fatalError = error;
            this.emitState(
              error instanceof RemoteAuthenticationError
                ? "authentication-failed"
                : "failed",
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          }
          this.emitState(
            "reconnecting",
            error instanceof Error ? error.message : String(error),
          );
          await this.waitBeforeReconnect(reconnectAttempt++, signal);
        }
      }
    } catch (error) {
      loopFailure = error;
    }

    // Closing the execution runner must precede waiting on operations: a
    // blocked adapter can only settle after close/cancel tears it down.
    let stopFailure = null;
    try {
      await settleWithin(this.closeRunner(), this.stopTimeoutMs);
    } catch (error) {
      stopFailure = error;
    }
    try {
      await settleWithin(
        Promise.allSettled([...this.activeOperations]),
        this.stopTimeoutMs,
      );
    } catch (error) {
      stopFailure ??= error;
    }
    this.emitState("stopped");
    if (loopFailure) throw loopFailure;
    if (stopFailure) throw stopFailure;
    if (this.fatalError) throw this.fatalError;
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopController?.abort();
      for (const controller of this.requestControllers) controller.abort();
      const closePromise = this.closeRunner();
      // A loop failure is reported by wait(); stop() owns teardown failures
      // only, so an already-observed authentication/protocol error must not be
      // relabelled as runner-close failure.
      const loopCleanup = this.loopPromise?.catch(() => {});
      const completion = Promise.all([
        closePromise,
        ...(loopCleanup ? [loopCleanup] : []),
      ]);
      await settleWithin(completion, this.stopTimeoutMs);
    })();
    return this.stopPromise;
  }
}
