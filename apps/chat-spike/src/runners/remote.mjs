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
const DEFAULT_POLL_TIMEOUT_MS = 25_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_OFFER_LEASE_MS = 500;
const DEFAULT_RECONNECT_DELAY_MS = 100;
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
const PLACEMENT_FORMAT_VERSION = 1;
const REQUEST_LEDGER_FORMAT_VERSION = 1;
const MIN_TOKEN_BYTES = 32;
const MAX_BODY_BYTES = 1024 * 1024;

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
  constructor(status, message, code = "invalid_request") {
    super(message);
    this.name = "ProtocolInputError";
    this.status = status;
    this.code = code;
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

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ProtocolInputError(413, "请求体过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProtocolInputError(400, "请求体必须是 JSON");
  }
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
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`RemoteRunner.${label} 必须是正整数`);
      }
    }
    if (maxEventsPerRequest < 2) {
      throw new TypeError("RemoteRunner.maxEventsPerRequest 必须至少为 2");
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
      nextSequence: 1,
      listeners: new Map(),
      terminal: false,
      completedAt: 0,
      cancelOperation: null,
    };
    this.requests.set(request.requestId, record);
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
    const deferred = createDeferred();
    const control = {
      controlId: randomUUID(),
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

    const deferred = createDeferred();
    const control = {
      controlId: randomUUID(),
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
      record.eventDigests.set(event.sequence, fingerprint(event));
      record.events.push(event);
      record.nextSequence++;
    }
    this.archiveTerminalRecord(
      record,
      error.code === RUNNER_ERROR_CODES.CANCELLED ? "cancelled" : "failed",
      undefined,
      error,
    );
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
    this.trimCompletedRequests();
    this.wakePollers();
  }

  trimCompletedRequests() {
    let completed = [...this.requests.values()].filter(
      (record) => record.terminal,
    ).length;
    if (completed <= this.maxCompletedRequests) return;
    for (const [requestId, record] of this.requests) {
      if (!record.terminal) continue;
      this.requests.delete(requestId);
      completed--;
      if (completed <= this.maxCompletedRequests) break;
    }
  }

  archiveTerminalRecord(record, state, result, error) {
    this.requestLedger.put({
      requestId: record.request.requestId,
      fingerprint: record.fingerprint,
      state,
      events: record.events,
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
        control.state = "offered";
        control.delivery++;
        control.leaseId = randomUUID();
        control.leaseUntil = now + this.offerLeaseMs;
        const work = Object.freeze(
          control.kind === "reset-session"
            ? {
                kind: control.kind,
                controlId: control.controlId,
                scope: control.scope,
                delivery: control.delivery,
                leaseId: control.leaseId,
              }
            : {
                kind: control.kind,
                controlId: control.controlId,
                requestId: control.requestId,
                delivery: control.delivery,
                leaseId: control.leaseId,
              },
        );
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
        record.state = "offered";
        record.delivery++;
        record.leaseId = randomUUID();
        record.leaseUntil = now + this.offerLeaseMs;
        const work = Object.freeze({
          kind: "dispatch",
          request: record.request,
          delivery: record.delivery,
          leaseId: record.leaseId,
        });
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
    const immediate = this.claim(hostId, capabilities);
    if (immediate || this.closed) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      const poller = {
        hostId,
        capabilities,
        finish: (work) => {
          clearTimeout(poller.timer);
          signal?.removeEventListener("abort", poller.abort);
          this.pollers.delete(poller);
          resolve(work);
        },
      };
      poller.abort = () => poller.finish(null);
      poller.timer = setTimeout(() => poller.finish(null), this.pollTimeoutMs);
      signal?.addEventListener("abort", poller.abort, { once: true });
      this.pollers.add(poller);
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
    const digest = fingerprint(event);
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
    record.leaseUntil = Date.now() + this.leaseMs;
    record.eventDigests.set(event.sequence, digest);
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
    if (result.sessionId) this.placementStore.set(record.request, hostId);
    else this.placementStore.delete(record.request);
    this.archiveTerminalRecord(record, "completed", result);
    record.terminal = true;
    record.state = "completed";
    record.result = result;
    record.completedAt = Date.now();
    record.listeners.clear();
    record.deferred.resolve(result);
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
    this.archiveTerminalRecord(
      record,
      error.code === RUNNER_ERROR_CODES.CANCELLED ? "cancelled" : "failed",
      undefined,
      error,
    );
    record.terminal = true;
    record.state = error.code === RUNNER_ERROR_CODES.CANCELLED ? "cancelled" : "failed";
    record.error = error;
    record.completedAt = Date.now();
    record.listeners.clear();
    record.deferred.reject(new RunnerDispatchError(error));
    this.trimCompletedRequests();
    this.wakePollers();
    return false;
  }

  acceptControl(hostId, controlId, delivery, leaseId, ok, resultValue, errorValue) {
    const control = this.controls.get(controlId);
    const digest = fingerprint(
      ok === true ? { ok, result: resultValue } : { ok, error: errorValue },
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
      jsonResponse(response, 401, { error: "unauthorized" });
      return true;
    }
    if (request.method !== "POST") {
      jsonResponse(response, 405, { error: "method_not_allowed" });
      return true;
    }

    try {
      const body = await readJson(request);
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
        request.once("aborted", () => controller.abort());
        response.once("close", () => controller.abort());
        const work = await this.waitForWork(
          hostId,
          {
            acceptDispatch: body.acceptDispatch,
            acceptControl: body.acceptControl,
          },
          controller.signal,
        );
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
      const status = error instanceof ProtocolInputError ? error.status : 500;
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

function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      signal?.removeEventListener("abort", finish);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function responseBody(response) {
  const text = await response.text();
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

async function settleWithin(promise, timeoutMs) {
  let timer;
  await Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
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
    maxCompleted = 1000,
    maxConcurrentDispatches = DEFAULT_MAX_CONCURRENT_DISPATCHES,
    maxConcurrentControls = DEFAULT_MAX_CONCURRENT_CONTROLS,
    maxEventsPerExecution = DEFAULT_MAX_EVENTS_PER_REQUEST,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    onState,
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
    for (const [label, value] of [
      ["maxCompleted", maxCompleted],
      ["maxConcurrentDispatches", maxConcurrentDispatches],
      ["maxConcurrentControls", maxConcurrentControls],
      ["maxEventsPerExecution", maxEventsPerExecution],
      ["stopTimeoutMs", stopTimeoutMs],
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`RemoteRunnerWorker.${label} 必须是正整数`);
      }
    }
    if (maxEventsPerExecution < 2) {
      throw new TypeError("RemoteRunnerWorker.maxEventsPerExecution 必须至少为 2");
    }
    if (
      !nonEmptyString(pathPrefix) ||
      !pathPrefix.startsWith("/") ||
      pathPrefix === "/"
    ) {
      throw new TypeError("RemoteRunnerWorker.pathPrefix 必须是绝对 URL path");
    }

    this.baseUrl = baseUrl;
    this.token = token;
    this.hostId = hostId;
    this.runner = runner;
    this.pathPrefix = pathPrefix.replace(/\/$/, "");
    this.reconnectDelayMs = reconnectDelayMs;
    this.maxCompleted = maxCompleted;
    this.maxConcurrentDispatches = maxConcurrentDispatches;
    this.maxConcurrentControls = maxConcurrentControls;
    this.maxEventsPerExecution = maxEventsPerExecution;
    this.stopTimeoutMs = stopTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.onState = onState ?? (() => {});
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
    signal?.addEventListener("abort", abort, { once: true });
    let response;
    try {
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
    } finally {
      signal?.removeEventListener("abort", abort);
      this.requestControllers.delete(requestController);
    }
    if (response.status === 401 || response.status === 403) {
      throw new RemoteAuthenticationError();
    }
    if (response.status >= 500) {
      throw new Error(`Hub 暂时不可用：HTTP ${response.status}`);
    }
    const parsed = await responseBody(response);
    if (!response.ok) {
      throw new RemoteProtocolError(
        response.status,
        nonEmptyString(parsed?.message)
          ? parsed.message
          : `Hub 拒绝请求：HTTP ${response.status}`,
        nonEmptyString(parsed?.error) ? parsed.error : "protocol_error",
      );
    }
    return { status: response.status, body: parsed };
  }

  async sendWithReconnect(path, body, signal) {
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
        await abortableDelay(this.reconnectDelayMs, signal);
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

  trimExecutions() {
    if (this.executions.size <= this.maxCompleted) return;
    for (const [requestId, entry] of this.executions) {
      if (entry.settled) this.executions.delete(requestId);
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
    signal.addEventListener("abort", abort, { once: true });
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
    const onEvent = (event) => {
      if (entry.overflowed) return;
      const terminal = event.kind === "completed" || event.kind === "failed";
      const limit = terminal
        ? this.maxEventsPerExecution
        : this.maxEventsPerExecution - 1;
      if (entry.events.length >= limit) {
        entry.overflowed = true;
        entry.error = runnerError({
          requestId: request.requestId,
          code: RUNNER_ERROR_CODES.INTERNAL,
          message: "Remote Runner Worker event cache 超出限制",
          retryable: false,
        });
        const failed = runnerLifecycleEvent(
          request.requestId,
          entry.events.length + 1,
          "failed",
          entry.error,
        );
        entry.events.push(failed);
        deliveries = deliveries.then(() =>
          this.transmit(entry, leaseId, () =>
            this.postEvent(request.requestId, delivery, leaseId, failed, signal),
          ),
        );
        void deliveries.catch(() => {});
        void Promise.resolve()
          .then(() => this.runner.cancel(request.requestId))
          .catch(() => {});
        return;
      }
      entry.events.push(event);
      deliveries = deliveries.then(() =>
        this.transmit(entry, leaseId, () =>
          this.postEvent(request.requestId, delivery, leaseId, event, signal),
        ),
      );
      void deliveries.catch(() => {});
    };
    try {
      const result = await this.runner.dispatch(request, { onEvent });
      if (!entry.overflowed) entry.result = result;
    } catch (error) {
      if (!entry.overflowed) {
        entry.error =
          error instanceof RunnerDispatchError
            ? error.error
            : runnerError({
                requestId: request.requestId,
                code: RUNNER_ERROR_CODES.INTERNAL,
                message: error instanceof Error ? error.message : String(error),
                retryable: false,
              });
      }
      if (entry.events.at(-1)?.kind !== "failed") {
        const failed = runnerLifecycleEvent(
          request.requestId,
          entry.events.length + 1,
          "failed",
          entry.error,
        );
        entry.events.push(failed);
        deliveries = deliveries.then(() =>
          this.transmit(entry, leaseId, () =>
            this.postEvent(request.requestId, delivery, leaseId, failed, signal),
          ),
        );
        void deliveries.catch(() => {});
      }
    }
    entry.settled = true;
    await deliveries;
    await this.transmit(entry, leaseId, () =>
      this.postOutcome(entry, delivery, leaseId, signal),
    );
    this.trimExecutions();
  }

  async handleDispatch(work, leaseMs, signal) {
    const request = work.request;
    const digest = fingerprint(request);
    const found = this.executions.get(request.requestId);
    if (found) {
      if (found.fingerprint !== digest) {
        throw new RemoteProtocolError(409, "Hub 对同一 requestId 投递了不同 request");
      }
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
        await stopHeartbeat();
      }
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
    };
    this.executions.set(request.requestId, entry);
    const stopHeartbeat = this.startHeartbeat(work, leaseMs, signal, () =>
      this.markOrphaned(entry, work.leaseId),
    );
    try {
      entry.execution = this.execute(request, entry, work.delivery, work.leaseId, signal);
      await entry.execution;
    } finally {
      await stopHeartbeat();
    }
  }

  trimCompletedControlExecutions() {
    while (this.completedControls.size > this.maxCompleted) {
      this.completedControls.delete(this.completedControls.keys().next().value);
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
    const digest = fingerprint(
      work.kind === "cancel"
        ? { kind: work.kind, requestId: work.requestId }
        : { kind: work.kind, scope: work.scope },
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
      })();
    }
    const stopHeartbeat = this.startHeartbeat(work, leaseMs, signal, () =>
      this.markOrphaned(entry, work.leaseId),
    );
    try {
      await entry.execution;
      await this.transmit(entry, work.leaseId, () =>
        this.postControl(entry, work.delivery, work.leaseId, signal),
      );
      this.trimCompletedControlExecutions();
    } finally {
      await stopHeartbeat();
    }
  }

  launch(factory, signal, kind) {
    if (kind === "dispatch") this.activeDispatches++;
    else this.activeControls++;
    const tracked = Promise.resolve()
      .then(factory)
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
    try {
      while (!signal.aborted) {
        try {
          const work = await this.poll(signal);
          if (signal.aborted) break;
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
          await abortableDelay(this.reconnectDelayMs, signal);
        }
      }
    } finally {
      // Closing the execution runner must precede waiting on operations: a
      // blocked adapter can only settle after close/cancel tears it down.
      await settleWithin(this.closeRunner(), this.stopTimeoutMs);
      await settleWithin(
        Promise.allSettled([...this.activeOperations]),
        this.stopTimeoutMs,
      );
      this.emitState("stopped");
    }
    if (this.fatalError) throw this.fatalError;
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopController?.abort();
      for (const controller of this.requestControllers) controller.abort();
      const closePromise = this.closeRunner();
      const completion = Promise.allSettled([
        closePromise,
        ...(this.loopPromise ? [this.loopPromise] : []),
      ]);
      await settleWithin(completion, this.stopTimeoutMs);
    })();
    return this.stopPromise;
  }
}
