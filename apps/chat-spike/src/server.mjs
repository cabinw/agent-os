#!/usr/bin/env node
/**
 * Chat spike — stage 2: the participation channel.
 *
 *   browser ──POST /send──▶ append(message.sent) ──▶ Adapter ──▶ vendor CLI
 *      ▲                          │                                 │
 *      │                          ▼                                 │
 *      └── GET /events (SSE) ── thread reducer ◀── append(message.sent) ◀┘
 *
 * The rule this stage exists to enforce: **the server never sends the UI a
 * message it did not first write to the log.** Rendering happens off the
 * reducer's projection, so a restart reproduces the conversation exactly
 * (ADR-005). Live-only signals — token deltas, reasoning, progress — bypass the
 * log on purpose; they are previews, not facts.
 *
 * Agents reach the log only through the MCP tools (src/mcp-tools.mjs), which
 * validate and authorize. Still absent: tasks, memory, approvals.
 */

import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeAdapters, getAdapter } from "./adapters/index.mjs";
import { makeEvent } from "./events.mjs";
import { EventLog } from "./log.mjs";
import { createToolRouter } from "./mcp-tools.mjs";
import { project } from "./thread.mjs";
import { ValidationError } from "./validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, "../public");
const PORT = Number(process.env.PORT ?? 4173);
const AGENT_CWD = process.env.AGENT_CWD ?? resolve(HERE, "../workspace");
const LOG_PATH = process.env.LOG_PATH ?? resolve(HERE, "../data/events.jsonl");

/** `DUMP_EVENTS=path` records raw vendor traffic — how these schemas were learned. */
const DUMP = process.env.DUMP_EVENTS;

/** One project, one thread — the spike has no tasks (ADR-006). */
const PROJECT = "proj_spike";
const HUMAN = { kind: "human", id: "you" };

const log = new EventLog(LOG_PATH);
const clients = new Set();
const registered = new Set();

let providerId = process.env.PROVIDER ?? "codex";
let adapter = null;
/** Id of the human message the current turn is answering, for `causedBy`. */
let answering = null;

function broadcast(type, data) {
  const frame = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of clients) res.write(frame);
}

/** The only way anything reaches the UI as a fact. */
function emit(event) {
  const stored = log.append(event);
  broadcast("event", { event: stored });
  return stored;
}

/**
 * The runtime behind the MCP tools. Agents request; this decides and emits.
 * Note every handler builds the envelope itself — no caller-supplied field ever
 * reaches `actor`, `seq`, `id` or `at`.
 */
const runtime = {
  registeredIds: () => registered,

  registerAgent(p) {
    registered.add(p.id);
    const evt = emit(
      makeEvent({
        type: "agent.registered",
        project: PROJECT,
        actor: { kind: "system", id: "runtime" },
        subject: { kind: "agent", id: p.id },
        payload: {
          id: p.id,
          name: p.name,
          provider: p.provider ?? p.id,
          role: p.role,
          // Task capability is unknown in a chat spike; integration capability
          // is measured. Two axes — docs/protocol/agent-schema.md.
          capabilities: p.capabilities ?? [],
          integration: getAdapter(p.id)?.capabilities,
        },
      }),
    );
    return { registered: p.id, seq: evt.seq };
  },

  sendMessage(p) {
    const evt = emit(
      makeEvent({
        type: "message.sent",
        project: PROJECT,
        actor: { kind: "agent", id: p.from },
        subject: { kind: "project", id: PROJECT },
        causedBy: p.replyTo ?? answering ?? undefined,
        payload: {
          from: p.from,
          to: p.to,
          type: p.type,
          content: p.content,
          ...(p.attachments ? { attachments: p.attachments } : {}),
        },
      }),
    );
    return { id: evt.id, seq: evt.seq };
  },

  /**
   * The memory-first mechanism. An agent woken with no vendor session gets its
   * context from here — from the log, not from its own history.
   */
  getContext(p) {
    const thread = project(log.replay());
    const limit = p.limit ?? 50;
    return {
      project: PROJECT,
      messages: thread.items
        .filter((i) => i.kind === "message")
        .slice(-limit)
        .map((i) => ({
          from: i.from,
          to: i.to,
          type: i.messageType,
          content: i.text,
          at: i.at,
        })),
      agents: Object.values(thread.agents).map((a) => ({ id: a.id, name: a.name })),
    };
  },
};

const tools = createToolRouter(runtime);

function ensureRegistered(id) {
  if (registered.has(id)) return;
  const Cls = getAdapter(id);
  if (!Cls) return;
  tools.call("register_agent", {
    id,
    name: Cls.label,
    provider: id,
    role: "assistant",
    capabilities: [],
  });
}

function currentAdapter() {
  if (adapter) return adapter;
  const Cls = getAdapter(providerId);
  if (!Cls) throw new Error(`未知 provider：${providerId}`);
  adapter = new Cls({
    cwd: AGENT_CWD,
    onEvent: (e) => {
      if (DUMP) appendFileSync(DUMP, `${JSON.stringify({ providerId, ...e })}\n`);
      // Deliberately not logged: previews and telemetry, not project facts.
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

function enqueue(causeId, text) {
  turn = turn
    .then(() => runTurn(causeId, text))
    .catch((err) => {
      broadcast("error", { message: String(err?.message ?? err) });
    });
  return turn;
}

async function runTurn(causeId, text) {
  broadcast("status", { state: "thinking" });
  answering = causeId;
  try {
    ensureRegistered(providerId);
    const reply = await currentAdapter().send(text);
    // The adapter translates a vendor reply into a `send_message` request. It
    // does not write the event — it asks, exactly as an external agent would.
    // Codex will not call our tools itself (FINDINGS.md), so the adapter speaks
    // the protocol on its behalf; the trust boundary is unchanged.
    await tools.call(
      "send_message",
      {
        from: providerId,
        to: HUMAN.id,
        type: "answer",
        content: reply.text || "（空回复）",
        replyTo: causeId,
      },
      providerId,
    );
    // Cold-start is adapter state, not project state — live signal only.
    broadcast("turn", { fresh: reply.fresh, ms: reply.ms });
  } finally {
    answering = null;
    broadcast("status", { state: "idle" });
    broadcast("provider", providerState());
  }
}

async function switchProvider(id) {
  if (!getAdapter(id)) throw new Error(`未知 provider：${id}`);
  if (id === providerId) return;

  await adapter?.close().catch(() => {});
  adapter = null;
  providerId = id;
  ensureRegistered(id);
  broadcast("provider", providerState());
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    const html = await readFile(join(PUBLIC, "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  // The browser imports the reducer rather than reimplementing it. Serving the
  // module is the cheapest way to keep one rule in one place.
  if (req.method === "GET" && url.pathname === "/src/thread.mjs") {
    const js = await readFile(join(HERE, "thread.mjs"), "utf8");
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    return res.end(js);
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // The whole thread, rebuilt from seq 0 on every connect. No cache to go stale.
    res.write(
      `data: ${JSON.stringify({
        type: "hello",
        thread: project(log.replay()),
        providers: describeAdapters(),
        provider: providerState(),
        logged: log.size,
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
    ensureRegistered(providerId);
    const stored = emit(
      makeEvent({
        type: "message.sent",
        project: PROJECT,
        actor: HUMAN,
        subject: { kind: "project", id: PROJECT },
        payload: { from: HUMAN.id, to: providerId, type: "instruction", content: text },
      }),
    );
    enqueue(stored.id, text);
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

  // The participation channel, reachable by any external agent. bin/agent-os-mcp.mjs
  // is a thin stdio↔HTTP bridge onto exactly these two routes.
  if (req.method === "GET" && url.pathname === "/mcp/tools") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ tools: tools.list() }));
  }

  if (req.method === "POST" && url.pathname === "/mcp/call") {
    const body = await readBody(req);
    try {
      const result = await tools.call(body?.name, body?.arguments, body?.caller ?? null);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ result }));
    } catch (e) {
      // A rejected call is a normal outcome at a trust boundary, not a crash.
      const status = e instanceof ValidationError ? 400 : 500;
      res.writeHead(status, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (req.method === "POST" && url.pathname === "/reset") {
    adapter?.resetSession();
    broadcast("provider", providerState());
    broadcast("notice", { text: "vendor 会话已丢弃——下一轮冷启动。日志不受影响。" });
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
  console.log(`日志        →  ${LOG_PATH}（已有 ${log.size} 条，seq ${log.seq}）`);
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
