/**
 * Codex — the odd one out: it is an **MCP server**, so Agent OS connects to it
 * as an MCP client over a long-lived stdio session rather than spawning a
 * process per turn.
 *
 * Verified against codex-cli 0.142.5:
 *   codex(prompt, …)               → { threadId, content }
 *   codex-reply(threadId, prompt)  → { threadId, content }
 * with progress arriving as `codex/event` notifications. Continuation is ~4x
 * cheaper than a cold start (3.2s vs 13.8s measured), which is the sharpest
 * evidence that the memory-first rebuild has a real latency price.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Adapter } from "./base.mjs";

/** Two 4-minute hangs showed up while probing. Never leave a turn open. */
const CALL_TIMEOUT_MS = 180_000;

export class CodexAdapter extends Adapter {
  static id = "codex";
  static label = "Codex";
  static capabilities = {
    streaming: true,
    thoughts: false,
    session: true,
    usage: true,
  };

  #client = null;

  async #connect() {
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
    // lands on the fallback handler rather than a typed one.
    client.fallbackNotificationHandler = async (n) => {
      if (n?.method !== "codex/event") return;
      const msg = n.params?.msg;
      if (!msg?.type) return;

      if (msg.type === "agent_message_content_delta" && msg.delta) {
        this.onEvent({ kind: "delta", text: msg.delta });
        return;
      }
      if (msg.type === "token_count") {
        const u = msg.info?.total_token_usage;
        if (u) {
          this.onEvent({
            kind: "usage",
            input: u.input_tokens,
            output: u.output_tokens,
            total: u.total_tokens,
            window: msg.info?.model_context_window,
          });
        }
        return;
      }
      this.onEvent({ kind: "progress", label: msg.type });
    };

    await client.connect(transport);
    this.#client = client;
  }

  async send(prompt) {
    await this.#connect();

    const fresh = !this.hasSession;
    const started = Date.now();

    const call = fresh
      ? {
          name: "codex",
          arguments: {
            prompt,
            cwd: this.cwd,
            sandbox: "read-only",
            "approval-policy": "never",
            ...(this.model ? { model: this.model } : {}),
          },
        }
      : {
          name: "codex-reply",
          arguments: { threadId: this._sessionId, prompt },
        };

    const res = await this.#client.callTool(call, undefined, {
      timeout: CALL_TIMEOUT_MS,
      maxTotalTimeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    });

    const structured = res?.structuredContent ?? {};
    const text =
      structured.content ??
      (Array.isArray(res?.content) ? res.content.map((c) => c?.text ?? "").join("") : "");

    if (structured.threadId) this._sessionId = structured.threadId;

    return {
      text: String(text).trim(),
      sessionId: this._sessionId,
      ms: Date.now() - started,
      fresh,
    };
  }

  async close() {
    await this.#client?.close().catch(() => {});
    this.#client = null;
  }
}
