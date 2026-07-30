#!/usr/bin/env node
/**
 * Agent Hub — a human plays Supervisor, agents delegate to each other.
 *
 *   browser ──POST /say──▶ Hub.say ──▶ event log ──▶ route ──▶ wake agent
 *      ▲                                  │                       │
 *      └── GET /events (SSE) ◀── thread reducer ◀── send_message ◀─┘
 *                                         ▲
 *   any agent ──MCP/stdio──▶ bin/agent-os-mcp.mjs ──▶ POST /mcp/call
 *
 * This process is thin on purpose: HTTP in, HTTP out, and every decision in
 * src/hub.mjs. The rule inherited from stage 1 still holds — **nothing reaches
 * the UI that was not written to the log first.** Deltas, reasoning and progress
 * bypass the log deliberately; they are previews, not facts.
 *
 * Absent by choice: approvals (a human message is guidance, never a grant —
 * rule 5), tasks, memory.
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeAdapters, getAdapter } from "./adapters/index.mjs";
import { Hub } from "./hub.mjs";
import { EventLog } from "./log.mjs";
import { HUMAN_ID } from "./mcp-tools.mjs";
import { project } from "./thread.mjs";
import { ValidationError } from "./validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, "../public");
const PORT = Number(process.env.PORT ?? 4173);
const WORKSPACE = process.env.AGENT_CWD ?? resolve(HERE, "../workspace");
const LOG_PATH = process.env.LOG_PATH ?? resolve(HERE, "../data/events.jsonl");
const PROJECT = "proj_hub";

/** Claude Code is the default coordinator: measured to participate, and holding
 *  one vendor fixed keeps "how a coordinator behaves" from being a moving part. */
const ROSTER = [
  {
    id: "claude",
    role: "coordinator",
    capabilities: ["architecture", "coding", "review"],
  },
  { id: "grok", role: "worker", capabilities: ["research", "coding"] },
  { id: "kimi", role: "worker", capabilities: ["research", "writing"] },
  { id: "codex", role: "worker", capabilities: ["coding", "testing"] },
];

const log = new EventLog(LOG_PATH);
const clients = new Set();

function broadcast(type, data) {
  const frame = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of clients) res.write(frame);
}

const hub = new Hub({
  log,
  projectId: PROJECT,
  broadcast,
  getAdapter,
  workspace: WORKSPACE,
  url: `http://localhost:${PORT}`,
  budget: Number(process.env.HOP_BUDGET ?? 6),
});

for (const a of ROSTER) {
  if (getAdapter(a.id)) hub.register(a.id, a);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && url.pathname === "/") {
    const html = await readFile(join(PUBLIC, "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  // The browser imports the reducer rather than reimplementing it — one rule,
  // one module, two consumers.
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
        agents: hub.roster(),
        tasks: hub.tasks(),
        providers: describeAdapters(),
        budget: hub.budget,
        human: HUMAN_ID,
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

  if (req.method === "POST" && url.pathname === "/say") {
    const body = await readBody(req);
    const text = String(body?.text ?? "").trim();
    const to = String(body?.to ?? "");
    if (!text) return json(400, { error: "empty" });
    if (!hub.agents.has(to)) return json(400, { error: `未知收件人 ${to}` });
    hub.say(text, to);
    return json(202, { ok: true });
  }

  // The participation channel. bin/agent-os-mcp.mjs is a stdio↔HTTP bridge onto
  // exactly these two routes, and holds no state of its own.
  if (req.method === "GET" && url.pathname === "/mcp/tools") {
    return json(200, { tools: hub.tools.list() });
  }

  if (req.method === "POST" && url.pathname === "/mcp/call") {
    const body = await readBody(req);
    try {
      const result = await hub.tools.call(
        body?.name,
        body?.arguments,
        body?.caller ?? null,
      );
      // Which tools an agent actually reaches for is the observation B.3 turns
      // on — whether a model cooperates with "ask by capability, don't name
      // names" is not something the schema can enforce.
      console.log(`  tool  ${(body?.caller ?? "?").padEnd(7)} ${body?.name}`);
      return json(200, { result });
    } catch (e) {
      // A rejected call is a normal outcome at a trust boundary, not a crash.
      return json(e instanceof ValidationError ? 400 : 500, { error: e.message });
    }
  }

  /**
   * Acceptance has no MCP tool and never will: rule 5 says a message in a thread
   * is guidance, never a grant. It lives here, on the human's surface only.
   */
  if (req.method === "POST" && url.pathname === "/accept") {
    const body = await readBody(req);
    try {
      hub.accept(String(body?.task ?? ""), body?.ok !== false);
      return json(200, { ok: true });
    } catch (e) {
      return json(400, { error: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/task") {
    const body = await readBody(req);
    try {
      const made = await hub.tools.call("create_task", {
        title: String(body?.title ?? ""),
        requires: body?.requires ?? [],
      });
      if (body?.assign !== false)
        await hub.tools.call("assign_task", { task: made.task });
      return json(202, made);
    } catch (e) {
      return json(400, { error: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/reset") {
    const body = await readBody(req);
    const entry = hub.agents.get(String(body?.agent ?? ""));
    if (!entry) return json(400, { error: "未知 agent" });
    entry.adapter?.resetSession();
    broadcast("roster", { agents: hub.roster() });
    broadcast("notice", {
      text: `${entry.label} 的 vendor 会话已丢弃——下一轮冷启动。日志不受影响。`,
    });
    return json(200, { ok: true });
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
  console.log(`agent hub  →  http://localhost:${PORT}`);
  console.log(`日志       →  ${LOG_PATH}（已有 ${log.size} 条，seq ${log.seq}）`);
  for (const a of hub.roster()) {
    const mark = a.integration.participates ? "会调工具" : "需适配器翻译";
    console.log(
      `  · ${a.id.padEnd(7)} ${a.role.padEnd(12)} ${mark}  [${a.capabilities.join(", ")}]`,
    );
  }
  console.log(`回环预算   →  ${hub.budget} 跳`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await hub.close();
    process.exit(0);
  });
}
