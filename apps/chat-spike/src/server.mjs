#!/usr/bin/env node
/**
 * Stage 0 of the chat spike: prove the dispatch path end to end.
 *
 *   browser ──POST /send──▶ this server ──▶ CodexAdapter ──▶ codex mcp-server
 *      ▲                                                          │
 *      └────────────GET /events (SSE)◀── codex/event progress ─────┘
 *
 * Deliberately absent: the event log, our own MCP server, tasks, memory.
 * Those are stages 1 and 2. See README.md.
 */

import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAdapter } from "./codex-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, "../public");
const PORT = Number(process.env.PORT ?? 4173);

/** Where the agent is allowed to look. Read-only, but keep it off the repo. */
const AGENT_CWD = process.env.AGENT_CWD ?? resolve(HERE, "../workspace");

/** In-memory only at stage 0 — stage 1 replaces this with a replayable log. */
const messages = [];
const clients = new Set();
let seq = 0;

function broadcast(type, data) {
  const frame = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of clients) res.write(frame);
}

function record(role, text, meta = {}) {
  const msg = { seq: ++seq, role, text, at: new Date().toISOString(), ...meta };
  messages.push(msg);
  broadcast("message", { message: msg });
  return msg;
}

/** `DUMP_EVENTS=path` writes raw codex/event payloads — the only way to learn
 *  this vendor schema, since it is undocumented. */
const DUMP = process.env.DUMP_EVENTS;

/**
 * Schema learned by dumping real traffic (see DUMP_EVENTS above) — Codex does
 * not document it. Envelope is `{_meta:{threadId}, msg:{type, …}}`.
 */
const adapter = new CodexAdapter({
  cwd: AGENT_CWD,
  onProgress: (evt) => {
    if (DUMP) appendFileSync(DUMP, `${JSON.stringify(evt)}\n`);
    const msg = evt?.msg;
    if (!msg?.type) return;

    switch (msg.type) {
      // Token-level streaming. This is what makes a 14-second turn feel alive
      // instead of frozen.
      case "agent_message_content_delta":
        if (msg.delta) broadcast("delta", { text: msg.delta });
        break;

      case "token_count": {
        const u = msg.info?.total_token_usage;
        if (u) {
          broadcast("usage", {
            input: u.input_tokens,
            output: u.output_tokens,
            total: u.total_tokens,
            window: msg.info?.model_context_window,
          });
        }
        break;
      }

      // Everything else is a coarse status line.
      default:
        broadcast("progress", { kind: msg.type, detail: summarize(msg) });
    }
  },
});

function summarize(msg) {
  for (const key of ["message", "text", "command", "reason"]) {
    const v = msg[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
  }
  return "";
}

/** One turn at a time. A second message while the agent is thinking queues. */
let turn = Promise.resolve();

function enqueue(text) {
  turn = turn
    .then(() => runTurn(text))
    .catch((err) => {
      record("system", `派发失败：${err?.message ?? err}`, { error: true });
    });
  return turn;
}

async function runTurn(text) {
  broadcast("status", { state: "thinking" });
  try {
    const reply = await adapter.send(text);
    // The streamed deltas were a preview; this is the authoritative message.
    // The client discards its buffer and renders this instead.
    record("agent", reply.text || "（空回复）", {
      ms: reply.ms,
      fresh: reply.fresh,
      threadId: reply.threadId,
    });
  } finally {
    broadcast("status", { state: "idle" });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    const html = await readFile(join(PUBLIC, "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "hello", messages })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return undefined;
  }

  if (req.method === "POST" && url.pathname === "/send") {
    const body = await readBody(req);
    const text = String(body?.text ?? "").trim();
    if (!text) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "empty" }));
    }
    record("human", text);
    enqueue(text);
    res.writeHead(202, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === "POST" && url.pathname === "/reset") {
    adapter.resetSession();
    record("system", "会话已重置——下一轮将是冷启动，无历史上下文");
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  res.writeHead(404);
  return res.end("not found");
});

function readBody(req) {
  return new Promise((resolveBody) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(raw || "{}"));
      } catch {
        resolveBody({});
      }
    });
  });
}

server.listen(PORT, () => {
  console.log(`chat-spike  →  http://localhost:${PORT}`);
  console.log(`agent cwd   →  ${AGENT_CWD}`);
  console.log("首轮约 20s（含冷启动），续话约 7s。");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await adapter.close();
    process.exit(0);
  });
}
