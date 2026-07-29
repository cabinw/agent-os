#!/usr/bin/env node
/**
 * Chat spike — the dispatch path, across four vendors.
 *
 *   browser ──POST /send──▶ this server ──▶ Adapter ──▶ vendor CLI
 *      ▲                                                    │
 *      └──────────GET /events (SSE)◀── normalised events ────┘
 *
 * Switching provider keeps the transcript but drops the vendor session, which
 * is the cheapest possible demonstration of why context has to live in the log
 * rather than inside an agent.
 *
 * Deliberately absent: the event log, our own MCP server, tasks, memory.
 */

import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeAdapters, getAdapter } from "./adapters/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, "../public");
const PORT = Number(process.env.PORT ?? 4173);
const AGENT_CWD = process.env.AGENT_CWD ?? resolve(HERE, "../workspace");

/** `DUMP_EVENTS=path` records raw vendor traffic — how these schemas were learned. */
const DUMP = process.env.DUMP_EVENTS;

/** In-memory only at stage 0; stage 1 replaces this with a replayable log. */
const messages = [];
const clients = new Set();
let seq = 0;

let providerId = process.env.PROVIDER ?? "codex";
let adapter = null;

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

function currentAdapter() {
  if (adapter) return adapter;
  const Cls = getAdapter(providerId);
  if (!Cls) throw new Error(`未知 provider：${providerId}`);
  adapter = new Cls({
    cwd: AGENT_CWD,
    onEvent: (e) => {
      if (DUMP) appendFileSync(DUMP, `${JSON.stringify({ providerId, ...e })}\n`);
      if (e.kind === "delta") broadcast("delta", { text: e.text });
      else if (e.kind === "thought") broadcast("thought", { text: e.text });
      else if (e.kind === "usage") broadcast("usage", e);
      else broadcast("progress", { kind: e.label ?? "event" });
    },
  });
  return adapter;
}

function providerState() {
  const Cls = getAdapter(providerId);
  return {
    id: providerId,
    label: Cls?.label ?? providerId,
    capabilities: Cls?.capabilities ?? {},
    hasSession: adapter?.hasSession ?? false,
  };
}

/** One turn at a time; a message sent mid-turn queues behind it. */
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
    const a = currentAdapter();
    const reply = await a.send(text);
    // Streamed deltas were a preview; this is the authoritative message.
    record("agent", reply.text || "（空回复）", {
      ms: reply.ms,
      fresh: reply.fresh,
      provider: providerId,
      providerLabel: getAdapter(providerId)?.label,
    });
  } finally {
    broadcast("status", { state: "idle" });
    broadcast("provider", providerState());
  }
}

async function switchProvider(id) {
  if (!getAdapter(id)) throw new Error(`未知 provider：${id}`);
  if (id === providerId) return;

  const from = getAdapter(providerId)?.label ?? providerId;
  await adapter?.close().catch(() => {});
  adapter = null;
  providerId = id;

  const to = getAdapter(id).label;
  // The transcript survives; the vendor session does not. Say so plainly —
  // this is the point of the switcher, not a side effect.
  record(
    "system",
    `已切换 ${from} → ${to}。对话记录保留，但 vendor 会话不可转移——${to} 对之前的内容一无所知。`,
  );
  broadcast("provider", providerState());
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
    res.write(
      `data: ${JSON.stringify({
        type: "hello",
        messages,
        providers: describeAdapters(),
        provider: providerState(),
      })}\n\n`,
    );
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

  if (req.method === "POST" && url.pathname === "/provider") {
    const body = await readBody(req);
    try {
      await switchProvider(String(body?.id ?? ""));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (req.method === "POST" && url.pathname === "/reset") {
    adapter?.resetSession();
    record("system", "会话已重置——下一轮冷启动，无历史上下文");
    broadcast("provider", providerState());
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
  console.log(
    `providers   →  ${describeAdapters()
      .map((p) => p.id)
      .join(", ")}（当前 ${providerId}）`,
  );
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await adapter?.close().catch(() => {});
    process.exit(0);
  });
}
