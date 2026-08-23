/**
 * The adapter contract, extracted from four real integrations rather than
 * designed up front. See apps/chat-spike/FINDINGS.md for the measurements it
 * came from.
 *
 * Every adapter normalises a vendor into:
 *
 *   send(prompt, { signal }) → { text, sessionId, ms, fresh }
 *   onEvent(evt) where evt.kind ∈ delta | thought | progress | usage
 *
 * and declares what it can actually do. Capabilities are declared, not assumed:
 * Kimi has no token streaming and Grok is the only one that streams reasoning,
 * so a UI that assumes either would be wrong three times out of four.
 */

import { spawn } from "node:child_process";
import {
  RUNNER_ERROR_CODES,
  RunnerDispatchError,
  runnerError,
} from "../runners/contract.mjs";

function abortReason(signal, fallback = "Adapter 已取消") {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

/**
 * @typedef {object} Capabilities
 * @property {boolean} streaming  emits `delta` events as the answer is produced
 * @property {boolean} thoughts   emits `thought` events (reasoning traces)
 * @property {boolean} session    can continue a prior turn by id
 * @property {boolean} usage      reports token counts
 */

export class Adapter {
  /** @type {string} */ static id = "abstract";
  /** @type {string} */ static label = "Abstract";
  /** @type {Capabilities} */ static capabilities = {
    streaming: false,
    thoughts: false,
    session: false,
    usage: false,
  };

  _sessionId = null;

  /**
   * `mcp` is the connection to Agent OS itself, from src/mcp-mount.mjs. When it
   * is present the agent can call our tools *during its own turn* — that is the
   * participate channel opening inside a wake. Null means the vendor will not,
   * and the adapter speaks for it instead.
   *
   * @param {{ cwd: string, model?: string, onEvent?: (e: object) => void,
   *           mcp?: {args: string[], env: Record<string,string>} | null }} opts
   */
  constructor({ cwd, model, onEvent, mcp }) {
    this.cwd = cwd;
    this.model = model;
    this.onEvent = onEvent ?? (() => {});
    this.mcp = mcp ?? null;
  }

  get sessionId() {
    return this._sessionId;
  }

  get hasSession() {
    return this._sessionId !== null;
  }

  /**
   * Forget the vendor session so the next turn starts cold. This is the lever
   * for the memory-first experiment — with no session, context has to come from
   * the event log instead of from the vendor's own history.
   */
  resetSession() {
    this._sessionId = null;
  }

  /**
   * Restore an opaque vendor session previously persisted by a Runner. Keeping
   * this operation on the adapter boundary avoids callers mutating protected
   * state or inventing a provider-specific resume path.
   */
  restoreSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      throw new TypeError("sessionId 必须是非空字符串");
    }
    if (!this.constructor.capabilities?.session) {
      throw new TypeError(`${this.constructor.label} 不支持 session 恢复`);
    }
    this._sessionId = sessionId;
  }

  /**
   * @param {string} _prompt
   * @param {{signal?: AbortSignal}} [_options]
   * @returns {Promise<{text: string, sessionId: string|null, ms: number, fresh: boolean}>}
   */
  async send(_prompt, _options = {}) {
    throw new Error("not implemented");
  }

  /** Stop the active vendor operation. Subclasses with resources override it. */
  async cancel(_reason) {}

  async close() {}
}

/**
 * Three of the four vendors are "spawn a process, read JSONL from stdout".
 * Only the per-line interpretation differs, so that is all a subclass supplies.
 */
export class SubprocessAdapter extends Adapter {
  /** A hung agent must surface as a failed turn, never a silently open session. */
  static timeoutMs = 180_000;

  /** @returns {{cmd: string, args: string[]}} */
  buildCommand(_prompt, _resume) {
    throw new Error("not implemented");
  }

  /**
   * Interpret one parsed JSONL line.
   * @returns {{text?: string, sessionId?: string} | undefined} partial result
   */
  handleLine(_obj) {
    return undefined;
  }

  _activeCancel = null;
  _activeClose = Promise.resolve();

  async send(prompt, { signal } = {}) {
    if (signal?.aborted) throw abortReason(signal);
    const fresh = !this.hasSession;
    const started = Date.now();
    const built = this.buildCommand(prompt, this._sessionId);
    const cmd = built.cmd;
    // Appended, never woven in: two vendors are sensitive to argument order and
    // the trailing position is the one that behaves the same everywhere.
    const args = [...built.args, ...(this.mcp?.args ?? [])];

    const collected = { text: "", sessionId: this._sessionId };

    await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: this.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(this.mcp?.env ?? {}) },
      });
      let closeResolve = () => {};
      const childClosed = new Promise((closed) => {
        closeResolve = closed;
      });
      this._activeClose = childClosed;

      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        if (this._activeCancel === cancelChild) this._activeCancel = null;
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const cancelChild = (reason) => {
        try {
          child.kill("SIGKILL");
        } finally {
          fail(reason instanceof Error ? reason : new Error("Adapter 已取消"));
        }
      };
      const onAbort = () => cancelChild(abortReason(signal));

      const timeoutMs = this.constructor.timeoutMs;
      const timer = setTimeout(() => {
        const error = new RunnerDispatchError(
          runnerError({
            requestId: "unknown",
            code: RUNNER_ERROR_CODES.TIMEOUT,
            message: `${this.constructor.label} 超时（${timeoutMs / 1000}s）`,
            retryable: true,
          }),
        );
        cancelChild(error);
      }, timeoutMs);

      let buf = "";
      let stderr = "";

      const onStdout = (d) => {
        buf += d.toString();
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          const partial = this.handleLine(obj);
          if (partial?.text) collected.text += partial.text;
          if (partial?.sessionId) collected.sessionId = partial.sessionId;
        }
      };

      const onStderr = (d) => {
        stderr += d.toString();
      };

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      this._activeCancel = cancelChild;
      signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (e) => {
        closeResolve();
        fail(e);
      });

      child.on("close", (code) => {
        closeResolve();
        if (code === 0) return succeed();
        fail(
          new Error(
            `${this.constructor.label} 退出码 ${code}${stderr ? `：${stderr.trim().slice(0, 200)}` : ""}`,
          ),
        );
      });
    });

    if (collected.sessionId) this._sessionId = collected.sessionId;

    return {
      text: collected.text.trim(),
      sessionId: this._sessionId,
      ms: Date.now() - started,
      fresh,
    };
  }

  async cancel(reason) {
    const childClosed = this._activeClose;
    this._activeCancel?.(reason);
    await childClosed;
  }
}
