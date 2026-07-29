/**
 * The wake channel: Agent OS → Codex.
 *
 * Agent OS is the MCP *client* here. This is what the specs call an adapter —
 * the one place a vendor name is allowed to appear (ADR-004). Everything above
 * it deals in messages, not in Codex.
 *
 * Verified against codex-cli 0.142.5 (`codex mcp-server`), which exposes:
 *   codex(prompt, …)               → { threadId, content }   start a session
 *   codex-reply(threadId, prompt)  → { threadId, content }   continue it
 * and streams progress as `codex/event` notifications.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Two 4-minute hangs showed up while probing this server. A stuck agent must
 * surface as a failed turn, never as a silently open session.
 */
const CALL_TIMEOUT_MS = 120_000;

export class CodexAdapter {
  #client = null;
  #threadId = null;
  #onProgress;
  #cwd;
  #model;

  /**
   * @param {object} opts
   * @param {(evt: unknown) => void} opts.onProgress  receives raw `codex/event` params
   * @param {string} opts.cwd     working directory handed to the agent
   * @param {string} [opts.model] optional model override
   */
  constructor({ onProgress, cwd, model }) {
    this.#onProgress = onProgress;
    this.#cwd = cwd;
    this.#model = model;
  }

  async connect() {
    if (this.#client) return;

    const transport = new StdioClientTransport({
      command: "codex",
      args: ["mcp-server"],
      stderr: "ignore",
    });

    const client = new Client(
      { name: "agent-os-chat-spike", version: "0.0.0" },
      { capabilities: {} },
    );

    // `codex/event` is a vendor notification, not an MCP standard method, so it
    // arrives on the fallback handler rather than a typed one.
    client.fallbackNotificationHandler = async (n) => {
      if (n?.method === "codex/event") this.#onProgress(n.params);
    };

    await client.connect(transport);
    this.#client = client;
  }

  /** True once a session exists, i.e. subsequent turns can continue it. */
  get hasSession() {
    return this.#threadId !== null;
  }

  get threadId() {
    return this.#threadId;
  }

  /**
   * Drop the session so the next turn starts cold. This is the lever for the
   * memory-first experiment: with no session, context has to come from the log
   * instead of from the agent's own history.
   */
  resetSession() {
    this.#threadId = null;
  }

  /**
   * Send a turn and wait for the agent's reply.
   * @param {string} prompt
   * @param {{ developerInstructions?: string }} [opts]
   * @returns {Promise<{ text: string, threadId: string, ms: number, fresh: boolean }>}
   */
  async send(prompt, opts = {}) {
    if (!this.#client) await this.connect();

    const fresh = !this.hasSession;
    const started = Date.now();

    const { name, args } = fresh
      ? {
          name: "codex",
          args: {
            prompt,
            cwd: this.#cwd,
            sandbox: "read-only",
            "approval-policy": "never",
            ...(this.#model ? { model: this.#model } : {}),
            ...(opts.developerInstructions
              ? { "developer-instructions": opts.developerInstructions }
              : {}),
          },
        }
      : { name: "codex-reply", args: { threadId: this.#threadId, prompt } };

    const res = await this.#client.callTool({ name, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
      maxTotalTimeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    });

    const structured = res?.structuredContent ?? {};
    const text =
      structured.content ??
      (Array.isArray(res?.content)
        ? res.content.map((c) => c?.text ?? "").join("")
        : "") ??
      "";

    if (structured.threadId) this.#threadId = structured.threadId;

    return {
      text: String(text).trim(),
      threadId: this.#threadId,
      ms: Date.now() - started,
      fresh,
    };
  }

  async close() {
    await this.#client?.close().catch(() => {});
    this.#client = null;
  }
}
