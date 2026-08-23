import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RUNNER_ERROR_CODES, RunnerDispatchError, runnerError } from "./contract.mjs";

const FORMAT_VERSION = 1;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function scopeKey({ user, project, agent }) {
  if (![user, project, agent].every(nonEmptyString)) {
    throw new TypeError("session scope 必须包含非空 user / project / agent");
  }
  return JSON.stringify([user, project, agent]);
}

function sessionFailure(message, cause) {
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

function validRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [
      value.user,
      value.project,
      value.agent,
      value.sessionId,
      value.adapter,
      value.hostId,
      value.workspace,
      value.updatedAt,
    ].every(nonEmptyString)
  );
}

/**
 * Small durable store for the spike. One atomic JSON snapshot is enough for a
 * single Local Runner; the formal Hub store remains a later SQLite boundary.
 */
export class SessionStore {
  constructor(path) {
    if (!nonEmptyString(path)) throw new TypeError("SessionStore path 必须是非空字符串");
    this.path = path;
    this.sessions = new Map();

    try {
      mkdirSync(dirname(path), { recursive: true });
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      if (
        parsed?.version !== FORMAT_VERSION ||
        parsed.sessions === null ||
        typeof parsed.sessions !== "object" ||
        Array.isArray(parsed.sessions)
      ) {
        throw new Error("未知 session store 格式");
      }
      for (const [key, record] of Object.entries(parsed.sessions)) {
        if (!validRecord(record) || key !== scopeKey(record)) {
          throw new Error(`损坏的 session 记录：${key}`);
        }
        this.sessions.set(key, Object.freeze({ ...record }));
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw sessionFailure(`无法读取 session store：${path}`, error);
    }
  }

  get(scope) {
    const value = this.sessions.get(scopeKey(scope));
    return value ? { ...value } : null;
  }

  set(scope, value) {
    const key = scopeKey(scope);
    if (
      !value ||
      ![value.sessionId, value.adapter, value.hostId, value.workspace].every(
        nonEmptyString,
      )
    ) {
      throw new TypeError(
        "session record 必须包含非空 sessionId / adapter / hostId / workspace",
      );
    }

    const record = Object.freeze({
      user: scope.user,
      project: scope.project,
      agent: scope.agent,
      sessionId: value.sessionId,
      adapter: value.adapter,
      hostId: value.hostId,
      workspace: value.workspace,
      updatedAt: new Date().toISOString(),
    });
    this.sessions.set(key, record);
    this.persist();
    return { ...record };
  }

  delete(scope) {
    const changed = this.sessions.delete(scopeKey(scope));
    if (changed) this.persist();
    return changed;
  }

  persist() {
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify(
      {
        version: FORMAT_VERSION,
        sessions: Object.fromEntries(this.sessions),
      },
      null,
      2,
    )}\n`;
    try {
      writeFileSync(temp, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temp, this.path);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {}
      throw sessionFailure(`无法写入 session store：${this.path}`, error);
    }
  }
}

export const sessionKey = scopeKey;
