import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  RUNNER_ERROR_CODES,
  RunnerDispatchError,
  normalizeAdapterEvent,
  normalizeRunnerError,
  normalizeRunnerResult,
  runnerError,
  runnerLifecycleEvent,
  validateDispatchRequest,
} from "./contract.mjs";
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

/**
 * Same-host implementation of the shared Runner contract.
 *
 * It serializes work per logical `(user, project, agent)` session, keeps the
 * adapter process warm when possible, and persists only the opaque vendor
 * session id. Project truth remains in the Hub event log.
 */
export class LocalRunner {
  constructor({ workspaceRoot, sessionStore, getAdapter, hostId = "local", mcpFor }) {
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
    this.adapters = new Map();
    this.queues = new Map();
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
          RUNNER_ERROR_CODES.ADAPTER_FAILURE,
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
          true,
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
    return { entry, scope };
  }

  dispatch(value, { onEvent } = {}) {
    const request = validateDispatchRequest(value);
    const key = sessionKey(request);
    const prior = this.queues.get(key) ?? Promise.resolve();
    const running = prior.catch(() => {}).then(() => this.run(request, onEvent));
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    const tail = settled.finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    this.queues.set(key, tail);
    return running;
  }

  hasSession(scope) {
    const key = sessionKey(scope);
    return (
      this.adapters.get(key)?.adapter?.hasSession === true ||
      Boolean(this.sessionStore.get(scope))
    );
  }

  async resetSession(scope) {
    const key = sessionKey(scope);
    await (this.queues.get(key) ?? Promise.resolve()).catch(() => {});
    this.adapters.get(key)?.adapter?.resetSession?.();
    this.sessionStore.delete(scope);
  }

  async run(request, onEvent) {
    let sequence = 0;
    const publish = (event) => {
      try {
        onEvent?.(event);
      } catch {
        // Observability must never be able to abort execution.
      }
    };
    const lifecycle = (kind, value) => {
      const event = runnerLifecycleEvent(request.requestId, ++sequence, kind, value);
      publish(event);
      return event;
    };
    const publishAdapterEvent = (value) => {
      const event = normalizeAdapterEvent(request.requestId, sequence + 1, value);
      if (!event) return;
      sequence++;
      publish(event);
    };

    let entry;
    try {
      const workspace = this.resolveWorkspace(request);
      const resolved = await this.adapterFor(request, workspace, publishAdapterEvent);
      entry = resolved.entry;
      lifecycle("started", { fresh: !entry.adapter.hasSession });

      const result = normalizeRunnerResult(
        request.requestId,
        await entry.adapter.send(request.prompt),
      );
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
      lifecycle("completed", result);
      return result;
    } catch (error) {
      const normalized = normalizeRunnerError(
        error,
        request.requestId,
        RUNNER_ERROR_CODES.ADAPTER_FAILURE,
      );
      lifecycle("failed", normalized);
      throw error instanceof RunnerDispatchError
        ? new RunnerDispatchError(normalized, error.cause)
        : new RunnerDispatchError(normalized, error);
    } finally {
      if (entry) entry.holder.publish = () => {};
    }
  }

  async close() {
    const entries = [...this.adapters.values()];
    this.adapters.clear();
    await Promise.all(entries.map((entry) => entry.adapter.close?.().catch(() => {})));
  }
}
