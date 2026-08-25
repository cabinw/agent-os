import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RUNNER_ERROR_CODES, RUNNER_EVENT_KINDS } from "./contract.mjs";
import { publishDurableFile, readDurableFile } from "./durable-file.mjs";

const FORMAT_VERSION = 1;
const STATES = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "unavailable",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
  );
}

function validError(value, requestId) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    exactKeys(value, ["requestId", "code", "message", "retryable"]) &&
    value.requestId === requestId &&
    Object.values(RUNNER_ERROR_CODES).includes(value.code) &&
    nonEmptyString(value.message) &&
    typeof value.retryable === "boolean"
  );
}

function validResult(value, requestId) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    exactKeys(value, ["requestId", "text", "sessionId", "ms", "fresh"]) &&
    value.requestId === requestId &&
    typeof value.text === "string" &&
    (value.sessionId === null || nonEmptyString(value.sessionId)) &&
    Number.isFinite(value.ms) &&
    value.ms >= 0 &&
    typeof value.fresh === "boolean"
  );
}

function validEvent(event, requestId, sequence) {
  if (
    event === null ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    event.requestId !== requestId ||
    event.sequence !== sequence ||
    !RUNNER_EVENT_KINDS.includes(event.kind) ||
    !nonEmptyString(event.at) ||
    !Number.isFinite(Date.parse(event.at))
  ) {
    return false;
  }
  if (event.kind === "started") return typeof event.fresh === "boolean";
  if (event.kind === "delta" || event.kind === "thought") {
    return typeof event.text === "string" && event.text.length > 0;
  }
  if (event.kind === "progress") return nonEmptyString(event.label);
  if (event.kind === "usage") {
    return ["input", "output", "total", "window", "costUsd"].every(
      (field) =>
        event[field] === undefined ||
        (Number.isFinite(event[field]) && event[field] >= 0),
    );
  }
  if (event.kind === "completed") return validResult(event.result, requestId);
  return validError(event.error, requestId);
}

function validRecord(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !nonEmptyString(value.requestId) ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    !STATES.has(value.state) ||
    !Array.isArray(value.events) ||
    !nonEmptyString(value.updatedAt)
  ) {
    return false;
  }

  const terminal = ["completed", "failed", "cancelled", "unavailable"].includes(
    value.state,
  );
  const expected = ["requestId", "fingerprint", "state", "events", "updatedAt"];
  if (value.state === "completed") expected.push("result");
  else if (terminal) expected.push("error");
  if (!exactKeys(value, expected)) return false;

  if (
    value.events.some((event, index) => !validEvent(event, value.requestId, index + 1))
  ) {
    return false;
  }

  if (value.state === "completed") {
    return (
      validResult(value.result, value.requestId) &&
      value.error === undefined &&
      value.events.at(-1)?.kind === "completed"
    );
  }
  if (["failed", "cancelled", "unavailable"].includes(value.state)) {
    return (
      validError(value.error, value.requestId) &&
      value.result === undefined &&
      value.events.at(-1)?.kind === "failed"
    );
  }
  return (
    value.result === undefined &&
    value.error === undefined &&
    !["completed", "failed"].includes(value.events.at(-1)?.kind)
  );
}

/**
 * Durable at-most-once ledger. It stores no request payload: only the request
 * id, a SHA-256 fingerprint, normalized observations and the terminal value.
 */
export class RequestStore {
  constructor(path, { publish = publishDurableFile, durability } = {}) {
    if (!nonEmptyString(path)) throw new TypeError("RequestStore path 必须是非空字符串");
    this.path = path;
    this.publishFile = publish;
    this.durability = durability;
    this.records = new Map();

    try {
      mkdirSync(dirname(path), { recursive: true });
      const parsed = JSON.parse(readDurableFile(path));
      if (
        parsed?.version !== FORMAT_VERSION ||
        parsed.requests === null ||
        typeof parsed.requests !== "object" ||
        Array.isArray(parsed.requests)
      ) {
        throw new Error("未知 request store 格式");
      }
      for (const [requestId, record] of Object.entries(parsed.requests)) {
        if (!validRecord(record) || requestId !== record.requestId) {
          throw new Error(`损坏的 request 记录：${requestId}`);
        }
        this.records.set(requestId, Object.freeze(clone(record)));
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new Error(`无法读取 request store：${path}`, { cause: error });
    }
  }

  entries() {
    return [...this.records.values()].map((record) => clone(record));
  }

  create(requestId, fingerprint) {
    if (!nonEmptyString(requestId) || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new TypeError("request ledger 需要非空 requestId 与 SHA-256 fingerprint");
    }
    if (this.records.has(requestId)) throw new Error(`requestId 已存在：${requestId}`);
    return this.put({
      requestId,
      fingerprint,
      state: "queued",
      events: [],
    });
  }

  put(value) {
    const record = {
      ...clone(value),
      updatedAt: new Date().toISOString(),
    };
    if (!validRecord(record)) throw new TypeError("request ledger record 不符合格式");
    const candidate = new Map(this.records);
    candidate.set(record.requestId, Object.freeze(record));
    this.persist(candidate);
    this.records = candidate;
    return clone(record);
  }

  persist(records = this.records) {
    const body = `${JSON.stringify(
      {
        version: FORMAT_VERSION,
        requests: Object.fromEntries(records),
      },
      null,
      2,
    )}\n`;
    try {
      this.publishFile(this.path, body, this.durability);
    } catch (error) {
      throw new Error(`无法写入 request store：${this.path}`, { cause: error });
    }
  }
}
