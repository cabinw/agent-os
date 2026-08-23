import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  RUNNER_CANCEL_OUTCOMES,
  RUNNER_ERROR_CODES,
  RunnerDispatchError,
  normalizeAdapterEvent,
  normalizeRunnerError,
  normalizeRunnerResult,
  runnerError,
  runnerLifecycleEvent,
  validateDispatchRequest,
} from "./contract.mjs";
import { RequestStore } from "./request-store.mjs";
import { sessionKey } from "./session-store.mjs";

function dispatchError(requestId, code, message, cause, retryable = false) {
  return new RunnerDispatchError(
    runnerError({ requestId, code, message, retryable }),
    cause,
  );
}

function containedBy(root, target) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function requestFingerprint(request) {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function cancelResult(requestId, outcome) {
  return Object.freeze({ requestId, outcome });
}

/**
 * Same-host implementation of the shared Runner contract.
 *
 * It serializes work per logical `(user, project, agent)` session, keeps the
 * adapter process warm when possible, and persists only the opaque vendor
 * session id. Project truth remains in the Hub event log.
 */
export class LocalRunner {
  constructor({
    workspaceRoot,
    sessionStore,
    getAdapter,
    hostId = "local",
    mcpFor,
    requestStore,
  }) {
    if (typeof getAdapter !== "function") {
      throw new TypeError("LocalRunner.getAdapter 必须是函数");
    }
    if (
      !sessionStore ||
      typeof sessionStore.get !== "function" ||
      typeof sessionStore.set !== "function" ||
      typeof sessionStore.delete !== "function"
    ) {
      throw new TypeError("LocalRunner.sessionStore 必须实现 get / set / delete");
    }
    if (typeof hostId !== "string" || hostId.trim() === "") {
      throw new TypeError("LocalRunner.hostId 必须是非空字符串");
    }

    try {
      this.workspaceRoot = realpathSync(workspaceRoot);
      if (!statSync(this.workspaceRoot).isDirectory()) throw new Error("不是目录");
    } catch (error) {
      throw new TypeError(`LocalRunner.workspaceRoot 不可用：${workspaceRoot}`, {
        cause: error,
      });
    }

    this.sessionStore = sessionStore;
    this.getAdapter = getAdapter;
    this.hostId = hostId;
    this.mcpFor = mcpFor ?? (() => null);
    this.requestStore =
      requestStore ??
      (typeof sessionStore.path === "string"
        ? new RequestStore(`${sessionStore.path}.requests.json`)
        : null);
    if (
      !this.requestStore ||
      typeof this.requestStore.entries !== "function" ||
      typeof this.requestStore.create !== "function" ||
      typeof this.requestStore.put !== "function"
    ) {
      throw new TypeError(
        "LocalRunner.requestStore 必须实现 entries / create / put，或 sessionStore 暴露 path",
      );
    }
    this.adapters = new Map();
    this.queues = new Map();
    this.requests = new Map();
    this.closed = false;
    this.closePromise = null;
    this.restoreRequestLedger();
  }

  restoreRequestLedger() {
    for (const savedValue of this.requestStore.entries()) {
      const saved = { ...savedValue, events: [...savedValue.events] };
      if (saved.state === "queued" || saved.state === "running") {
        const error = runnerError({
          requestId: saved.requestId,
          code: RUNNER_ERROR_CODES.UNAVAILABLE,
          message: "Runner 在请求执行期间重启，结果不可判定；请用新 requestId 重试",
          retryable: true,
        });
        saved.state = "unavailable";
        saved.error = error;
        saved.events.push(
          runnerLifecycleEvent(saved.requestId, saved.events.length + 1, "failed", error),
        );
        this.requestStore.put(saved);
      }

      const deferred = createDeferred();
      const record = {
        request: null,
        requestId: saved.requestId,
        fingerprint: saved.fingerprint,
        state: saved.state,
        events: [...saved.events],
        listeners: new Map(),
        sequence: saved.events.length,
        terminal: true,
        result: saved.result,
        error: saved.error,
        deferred,
        promise: deferred.promise,
        execution: Promise.resolve(),
        abortController: null,
        adapterEntry: null,
        adapterKey: null,
        cancelCleanup: Promise.resolve(),
      };
      if (saved.state === "completed") deferred.resolve(saved.result);
      else deferred.reject(new RunnerDispatchError(saved.error));
      this.requests.set(saved.requestId, record);
    }
  }

  persistedRecord(record, changes = {}) {
    const state = changes.state ?? record.state;
    const events = changes.events ?? record.events;
    const result = Object.hasOwn(changes, "result") ? changes.result : record.result;
    const error = Object.hasOwn(changes, "error") ? changes.error : record.error;
    return {
      requestId: record.requestId,
      fingerprint: record.fingerprint,
      state,
      events,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    };
  }

  commitRecord(record, changes = {}) {
    const event = changes.event;
    const events = event ? [...record.events, event] : record.events;
    const state = changes.state ?? record.state;
    const result = Object.hasOwn(changes, "result") ? changes.result : record.result;
    const error = Object.hasOwn(changes, "error") ? changes.error : record.error;
    try {
      this.requestStore.put(
        this.persistedRecord(record, { state, events, result, error }),
      );
    } catch (cause) {
      throw dispatchError(
        record.requestId,
        RUNNER_ERROR_CODES.UNAVAILABLE,
        "Runner request ledger 不可用",
        cause,
        true,
      );
    }
    record.state = state;
    record.result = result;
    record.error = error;
    record.terminal = ["completed", "failed", "cancelled", "unavailable"].includes(state);
    if (event) {
      record.events.push(event);
      record.sequence = event.sequence;
      for (const listener of [...record.listeners.keys()]) {
        this.deliver(record, listener, event);
      }
    }
  }

  resolveWorkspace(request) {
    const lexical = resolve(this.workspaceRoot, request.workspace);
    if (!containedBy(this.workspaceRoot, lexical)) {
      throw dispatchError(
        request.requestId,
        RUNNER_ERROR_CODES.WORKSPACE_NOT_ALLOWED,
        `workspace 不在配置 root 内：${request.workspace}`,
      );
    }

    let canonical;
    try {
      canonical = realpathSync(lexical);
      if (!statSync(canonical).isDirectory()) throw new Error("不是目录");
    } catch (error) {
      throw dispatchError(
        request.requestId,
        RUNNER_ERROR_CODES.WORKSPACE_NOT_FOUND,
        `workspace 不存在或不是目录：${request.workspace}`,
        error,
      );
    }

    if (!containedBy(this.workspaceRoot, canonical)) {
      throw dispatchError(
        request.requestId,
        RUNNER_ERROR_CODES.WORKSPACE_NOT_ALLOWED,
        `workspace 通过符号链接越过配置 root：${request.workspace}`,
      );
    }
    return canonical;
  }

  async adapterFor(request, workspace, publishAdapterEvent) {
    const scope = {
      user: request.user,
      project: request.project,
      agent: request.agent,
    };
    const key = sessionKey(scope);
    const fingerprint = JSON.stringify([
      request.adapter,
      request.model ?? null,
      workspace,
    ]);
    let entry = this.adapters.get(key);
    if (entry && entry.fingerprint !== fingerprint) {
      await entry.adapter.close?.().catch(() => {});
      this.adapters.delete(key);
      entry = null;
    }

    if (!entry) {
      const AdapterClass = this.getAdapter(request.adapter);
      if (typeof AdapterClass !== "function") {
        throw dispatchError(
          request.requestId,
          RUNNER_ERROR_CODES.ADAPTER_NOT_FOUND,
          `Runner 上没有 adapter：${request.adapter}`,
        );
      }

      const holder = { publish: publishAdapterEvent };
      let mcp;
      try {
        mcp = await this.mcpFor(request, workspace);
      } catch (error) {
        throw dispatchError(
          request.requestId,
          RUNNER_ERROR_CODES.UNAVAILABLE,
          "无法为 adapter 建立 MCP 参与通道",
          error,
          true,
        );
      }

      let adapter;
      try {
        adapter = new AdapterClass({
          cwd: workspace,
          model: request.model,
          mcp,
          onEvent: (event) => holder.publish(event),
        });
      } catch (error) {
        throw dispatchError(
          request.requestId,
          RUNNER_ERROR_CODES.ADAPTER_FAILURE,
          `无法初始化 adapter：${request.adapter}`,
          error,
        );
      }
      if (!adapter || typeof adapter.send !== "function") {
        throw dispatchError(
          request.requestId,
          RUNNER_ERROR_CODES.ADAPTER_FAILURE,
          `adapter ${request.adapter} 未实现 send`,
        );
      }

      const saved = this.sessionStore.get(scope);
      const resumable =
        saved &&
        saved.adapter === request.adapter &&
        saved.hostId === this.hostId &&
        saved.workspace === workspace;
      if (saved && !resumable) this.sessionStore.delete(scope);
      if (resumable) {
        if (typeof adapter.restoreSession !== "function") {
          throw dispatchError(
            request.requestId,
            RUNNER_ERROR_CODES.ADAPTER_FAILURE,
            `adapter ${request.adapter} 不支持受控 session 恢复`,
          );
        }
        adapter.restoreSession(saved.sessionId);
      }

      entry = { adapter, fingerprint, holder };
      this.adapters.set(key, entry);
    }

    entry.holder.publish = publishAdapterEvent;
    return { entry, scope, key };
  }

  dispatch(value, { onEvent } = {}) {
    const request = validateDispatchRequest(value);
    const fingerprint = requestFingerprint(request);
    const known = this.requests.get(request.requestId);
    if (known) {
      if (known.fingerprint !== fingerprint) {
        throw dispatchError(
          request.requestId,
          RUNNER_ERROR_CODES.INVALID_REQUEST,
          `requestId 已用于不同 dispatch：${request.requestId}`,
        );
      }
      this.subscribe(known, onEvent);
      return known.promise;
    }
    if (this.closed) {
      return Promise.reject(
        dispatchError(
          request.requestId,
          RUNNER_ERROR_CODES.UNAVAILABLE,
          "Local Runner 已关闭",
          undefined,
          true,
        ),
      );
    }

    const deferred = createDeferred();
    const record = {
      request,
      requestId: request.requestId,
      fingerprint,
      state: "queued",
      events: [],
      listeners: new Map(),
      sequence: 0,
      terminal: false,
      result: undefined,
      error: undefined,
      deferred,
      promise: deferred.promise,
      execution: null,
      abortController: null,
      adapterEntry: null,
      adapterKey: null,
      cancelCleanup: Promise.resolve(),
    };
    try {
      this.requestStore.create(request.requestId, fingerprint);
    } catch (error) {
      throw dispatchError(
        request.requestId,
        RUNNER_ERROR_CODES.UNAVAILABLE,
        "无法持久化 Runner request ledger",
        error,
        true,
      );
    }
    this.requests.set(request.requestId, record);
    this.subscribe(record, onEvent);

    const key = sessionKey(request);
    const prior = this.queues.get(key) ?? Promise.resolve();
    const execution = prior
      .catch(() => {})
      .then(() => this.executeRecord(record))
      .catch((error) => this.failRecord(record, error));
    record.execution = execution;
    const tail = execution.finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    this.queues.set(key, tail);
    return record.promise;
  }

  publishTo(listener, event) {
    try {
      listener?.(event);
    } catch {
      // Observability must never be able to abort execution.
    }
  }

  deliver(record, listener, event) {
    const delivered = record.listeners.get(listener);
    if (delivered === undefined || delivered >= event.sequence) return;
    record.listeners.set(listener, event.sequence);
    this.publishTo(listener, event);
  }

  subscribe(record, listener) {
    if (typeof listener !== "function") return;
    if (!record.listeners.has(listener)) record.listeners.set(listener, 0);
    for (const event of record.events) this.deliver(record, listener, event);
    if (record.terminal) record.listeners.delete(listener);
  }

  publishRecord(record, event) {
    this.commitRecord(record, { event });
  }

  lifecycle(record, kind, value) {
    const event = runnerLifecycleEvent(
      record.requestId,
      record.sequence + 1,
      kind,
      value,
    );
    this.publishRecord(record, event);
    return event;
  }

  adapterEvent(record, value) {
    if (record.terminal) return;
    const event = normalizeAdapterEvent(record.requestId, record.sequence + 1, value);
    if (!event) return;
    try {
      this.publishRecord(record, event);
    } catch (error) {
      this.failRecord(record, error, RUNNER_ERROR_CODES.UNAVAILABLE);
    }
  }

  completeRecord(record, result) {
    if (record.terminal) return;
    const event = runnerLifecycleEvent(
      record.requestId,
      record.sequence + 1,
      "completed",
      result,
    );
    this.commitRecord(record, {
      state: "completed",
      result,
      error: undefined,
      event,
    });
    record.deferred.resolve(result);
    record.listeners.clear();
  }

  failRecord(record, error, fallbackCode = RUNNER_ERROR_CODES.ADAPTER_FAILURE) {
    if (record.terminal) return;
    const normalized = normalizeRunnerError(error, record.requestId, fallbackCode);
    const state =
      normalized.code === RUNNER_ERROR_CODES.CANCELLED
        ? "cancelled"
        : normalized.code === RUNNER_ERROR_CODES.UNAVAILABLE
          ? "unavailable"
          : "failed";
    const failure =
      error instanceof RunnerDispatchError
        ? new RunnerDispatchError(normalized, error.cause)
        : new RunnerDispatchError(normalized, error);
    const event = runnerLifecycleEvent(
      record.requestId,
      record.sequence + 1,
      "failed",
      normalized,
    );
    try {
      this.commitRecord(record, {
        state,
        result: undefined,
        error: normalized,
        event,
      });
    } catch (persistError) {
      return this.failWithoutPersistence(record, persistError);
    }
    record.deferred.reject(failure);
    record.listeners.clear();
    if (
      normalized.code === RUNNER_ERROR_CODES.TIMEOUT ||
      normalized.code === RUNNER_ERROR_CODES.UNAVAILABLE
    ) {
      record.cancelCleanup = this.stopRecordAdapter(
        record,
        failure,
        Boolean(record.adapterEntry),
      );
    }
    return failure;
  }

  failWithoutPersistence(record, cause) {
    if (record.terminal) {
      return new RunnerDispatchError(record.error, cause);
    }
    const error = runnerError({
      requestId: record.requestId,
      code: RUNNER_ERROR_CODES.UNAVAILABLE,
      message: "Runner request ledger 不可用，执行结果未持久化",
      retryable: true,
    });
    const failure = new RunnerDispatchError(error, cause);
    record.state = "unavailable";
    record.terminal = true;
    record.result = undefined;
    record.error = error;
    const event = runnerLifecycleEvent(
      record.requestId,
      record.sequence + 1,
      "failed",
      error,
    );
    record.events.push(event);
    record.sequence = event.sequence;
    for (const listener of [...record.listeners.keys()]) {
      this.deliver(record, listener, event);
    }
    record.deferred.reject(failure);
    record.listeners.clear();
    record.cancelCleanup = this.stopRecordAdapter(
      record,
      failure,
      Boolean(record.adapterEntry),
    );
    return failure;
  }

  stopRecordAdapter(record, failure, waitForExecution) {
    const entry = record.adapterEntry;
    if (entry) entry.holder.publish = () => {};
    record.abortController?.abort(failure);
    if (record.adapterKey && this.adapters.get(record.adapterKey) === entry) {
      this.adapters.delete(record.adapterKey);
    }
    if (record.request) {
      try {
        this.sessionStore.delete(record.request);
      } catch {}
    }
    const adapterCleanup = Promise.resolve()
      .then(() => entry?.adapter.cancel?.(failure))
      .catch(() => {})
      .then(() => Promise.resolve(entry?.adapter.close?.()).catch(() => {}));
    return Promise.all([
      adapterCleanup,
      waitForExecution && record.execution
        ? record.execution.catch(() => {})
        : Promise.resolve(),
    ]).then(() => undefined);
  }

  cancel(requestId) {
    if (typeof requestId !== "string" || requestId.trim() === "") {
      return Promise.reject(
        dispatchError(
          "unknown",
          RUNNER_ERROR_CODES.INVALID_REQUEST,
          "cancel.requestId 必须是非空字符串",
        ),
      );
    }
    const record = this.requests.get(requestId);
    if (!record) {
      return Promise.resolve(cancelResult(requestId, RUNNER_CANCEL_OUTCOMES.NOT_FOUND));
    }
    if (record.state === "cancelled") {
      return record.cancelCleanup.then(() =>
        cancelResult(requestId, RUNNER_CANCEL_OUTCOMES.CANCELLED),
      );
    }
    if (record.terminal) {
      return Promise.resolve(
        cancelResult(requestId, RUNNER_CANCEL_OUTCOMES.ALREADY_TERMINAL),
      );
    }

    const wasRunning = record.state === "running";
    const error = runnerError({
      requestId,
      code: RUNNER_ERROR_CODES.CANCELLED,
      message: "Runner request 已取消",
      retryable: false,
    });
    const failure = new RunnerDispatchError(error);
    const cleanupDeferred = createDeferred();
    record.cancelCleanup = cleanupDeferred.promise;
    const event = runnerLifecycleEvent(
      record.requestId,
      record.sequence + 1,
      "failed",
      error,
    );
    try {
      this.commitRecord(record, {
        state: "cancelled",
        result: undefined,
        error,
        event,
      });
      record.deferred.reject(failure);
      record.listeners.clear();
    } catch (persistError) {
      const persistFailure = this.failWithoutPersistence(record, persistError);
      return record.cancelCleanup.then(() => Promise.reject(persistFailure));
    }

    this.stopRecordAdapter(record, failure, wasRunning).then(
      cleanupDeferred.resolve,
      cleanupDeferred.resolve,
    );
    return record.cancelCleanup.then(() =>
      cancelResult(requestId, RUNNER_CANCEL_OUTCOMES.CANCELLED),
    );
  }

  health() {
    let inflight = 0;
    let queued = 0;
    for (const record of this.requests.values()) {
      if (record.state === "running") inflight++;
      if (record.state === "queued") queued++;
    }
    return Object.freeze({
      ready: !this.closed,
      hostId: this.hostId,
      inflight,
      queued,
    });
  }

  hasSession(scope) {
    const key = sessionKey(scope);
    return (
      this.adapters.get(key)?.adapter?.hasSession === true ||
      Boolean(this.sessionStore.get(scope))
    );
  }

  resetSession(scope) {
    const key = sessionKey(scope);
    const prior = this.queues.get(key) ?? Promise.resolve();
    const operation = prior
      .catch(() => {})
      .then(() => {
        this.adapters.get(key)?.adapter?.resetSession?.();
        this.sessionStore.delete(scope);
      });
    const tail = operation.finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    this.queues.set(key, tail);
    return operation;
  }

  async executeRecord(record) {
    if (record.terminal) return;
    const request = record.request;
    this.commitRecord(record, { state: "running" });
    const abortController = new AbortController();
    record.abortController = abortController;
    let entry;
    try {
      const workspace = this.resolveWorkspace(request);
      const resolved = await this.adapterFor(request, workspace, (value) =>
        this.adapterEvent(record, value),
      );
      entry = resolved.entry;
      record.adapterEntry = entry;
      record.adapterKey = resolved.key;
      if (record.terminal) {
        await this.stopRecordAdapter(
          record,
          new RunnerDispatchError(record.error),
          false,
        );
        return;
      }
      this.lifecycle(record, "started", { fresh: !entry.adapter.hasSession });
      if (record.terminal) return;

      const result = normalizeRunnerResult(
        request.requestId,
        await entry.adapter.send(request.prompt, { signal: abortController.signal }),
      );
      if (record.terminal) return;
      if (result.sessionId) {
        this.sessionStore.set(resolved.scope, {
          sessionId: result.sessionId,
          adapter: request.adapter,
          hostId: this.hostId,
          workspace,
        });
      } else {
        this.sessionStore.delete(resolved.scope);
      }
      this.completeRecord(record, result);
    } catch (error) {
      this.failRecord(record, error);
    } finally {
      if (entry) entry.holder.publish = () => {};
      record.abortController = null;
      record.adapterEntry = null;
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const active = [...this.requests.values()].filter((record) => !record.terminal);
    this.closePromise = (async () => {
      await Promise.all(
        active.map((record) => this.cancel(record.requestId).catch(() => {})),
      );
      await Promise.all([...this.queues.values()].map((queue) => queue.catch(() => {})));
      await Promise.all(
        [...this.requests.values()].map((record) => record.cancelCleanup.catch(() => {})),
      );
      const entries = [...this.adapters.values()];
      this.adapters.clear();
      await Promise.all(entries.map((entry) => entry.adapter.close?.().catch(() => {})));
    })();
    return this.closePromise;
  }
}
