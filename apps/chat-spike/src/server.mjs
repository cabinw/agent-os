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

import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeAdapters, getAdapter } from "./adapters/index.mjs";
import {
  DEFAULT_HOST,
  MIN_TOKEN_LENGTH,
  allowedOrigins,
  applySecurityHeaders,
  createCredentialStore,
  parseAgentTokens,
  requestOrigin,
} from "./http-security.mjs";
import { Hub } from "./hub.mjs";
import { EventLog } from "./log.mjs";
import { mountMcp } from "./mcp-mount.mjs";
import { HUMAN_ID } from "./mcp-tools.mjs";
import { LocalRunner } from "./runners/local.mjs";
import { RemotePlacementStore, RemoteRunner } from "./runners/remote.mjs";
import { SessionStore } from "./runners/session-store.mjs";
import { RequestBodyError, readHubJsonBody } from "./server-body.mjs";
import {
  createServerLifecycle,
  installShutdownSignalHandlers,
  shouldPrintGeneratedHumanToken,
} from "./server-lifecycle.mjs";
import { createSseClientRegistry } from "./server-sse.mjs";
import { project } from "./thread.mjs";
import { ValidationError } from "./validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, "../public");
const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? DEFAULT_HOST;
const WORKSPACE = process.env.AGENT_CWD ?? resolve(HERE, "../workspace");
const LOG_PATH = process.env.LOG_PATH ?? resolve(HERE, "../data/events.jsonl");
const SESSION_PATH = process.env.SESSION_PATH ?? join(dirname(LOG_PATH), "sessions.json");
const REMOTE_STATE_PATH =
  process.env.AGENT_OS_REMOTE_STATE_PATH ??
  join(dirname(LOG_PATH), "remote-placement.json");
const RUNNER_MODE = process.env.AGENT_OS_RUNNER_MODE ?? "local";
const PROJECT = "proj_hub";
const HUB_URL = `http://localhost:${PORT}`;
if (!new Set(["local", "remote"]).has(RUNNER_MODE)) {
  throw new Error(
    `AGENT_OS_RUNNER_MODE must be "local" or "remote", received ${JSON.stringify(RUNNER_MODE)}`,
  );
}

function requiredRemoteSetting(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required when AGENT_OS_RUNNER_MODE=remote`);
  }
  return value;
}

const runnerHostId =
  RUNNER_MODE === "remote"
    ? requiredRemoteSetting("AGENT_OS_RUNNER_ID")
    : (process.env.AGENT_OS_RUNNER_ID ?? "local");
const runnerToken =
  RUNNER_MODE === "remote" ? requiredRemoteSetting("AGENT_OS_RUNNER_TOKEN") : null;
const humanToken =
  RUNNER_MODE === "remote"
    ? requiredRemoteSetting("AGENT_OS_HUMAN_TOKEN")
    : process.env.AGENT_OS_HUMAN_TOKEN;
if (
  runnerToken !== null &&
  (runnerToken.length < MIN_TOKEN_LENGTH || /\s/.test(runnerToken))
) {
  throw new Error(
    `AGENT_OS_RUNNER_TOKEN must be at least ${MIN_TOKEN_LENGTH} non-whitespace characters`,
  );
}

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

const configuredAgentTokens = parseAgentTokens(process.env.AGENT_OS_AGENT_TOKENS);
if (RUNNER_MODE === "remote") {
  const missingAgentTokens = ROSTER.map((agent) => agent.id).filter(
    (agentId) => !Object.hasOwn(configuredAgentTokens, agentId),
  );
  if (missingAgentTokens.length > 0) {
    throw new Error(
      `AGENT_OS_AGENT_TOKENS must explicitly configure remote Worker principals: ${missingAgentTokens.join(", ")}`,
    );
  }
}

const credentials = createCredentialStore({
  humanToken,
  agentTokens: configuredAgentTokens,
  agentIds: ROSTER.map((agent) => agent.id),
});
if (runnerToken !== null && credentials.authenticate(`Bearer ${runnerToken}`) !== null) {
  throw new Error(
    "AGENT_OS_RUNNER_TOKEN must be independent from human and agent credentials",
  );
}
let origins = allowedOrigins({
  host: HOST,
  port: PORT,
  configured: process.env.AGENT_OS_ALLOWED_ORIGINS,
});

const log = new EventLog(LOG_PATH);
const sseClients = createSseClientRegistry();

function broadcast(type, data) {
  const frame = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  sseClients.broadcast(frame);
}

// The composition root selects one shared Runner contract. Remote mode owns no
// adapter, working copy or vendor session; those stay on the outbound Worker.
let runner;
if (RUNNER_MODE === "local") {
  mkdirSync(WORKSPACE, { recursive: true, mode: 0o700 });
  for (const agent of ROSTER) {
    mkdirSync(join(WORKSPACE, agent.id), { recursive: true, mode: 0o700 });
  }
  runner = new LocalRunner({
    workspaceRoot: WORKSPACE,
    sessionStore: new SessionStore(SESSION_PATH),
    getAdapter,
    hostId: runnerHostId,
    mcpFor: (request, workspace) =>
      mountMcp(request.adapter, {
        dir: workspace,
        url: HUB_URL,
        token: credentials.tokenForAgent(request.agent),
      }),
  });
} else {
  runner = new RemoteRunner({
    token: runnerToken,
    hostId: runnerHostId,
    placementStore: new RemotePlacementStore({ filePath: REMOTE_STATE_PATH }),
  });
}

const hub = new Hub({
  log,
  projectId: PROJECT,
  broadcast,
  getAdapter,
  budget: Number(process.env.HOP_BUDGET ?? 6),
  runner,
  userId: HUMAN_ID,
});

for (const a of ROSTER) {
  if (getAdapter(a.id)) hub.register(a.id, a);
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    if (res.headersSent) return res.destroy();
    if (req.aborted || res.destroyed) return undefined;
    applySecurityHeaders(res);
    const knownInputError = error instanceof RequestBodyError;
    if (knownInputError && error.closeConnection) {
      res.setHeader("connection", "close");
      res.once("finish", () => req.destroy());
    }
    res.writeHead(knownInputError ? error.status : 500, {
      "content-type": "application/json",
    });
    return res.end(
      JSON.stringify({
        error: knownInputError ? error.message : "internal server error",
      }),
    );
  });
});

function isLoopbackRequest(req) {
  const address = req.socket.remoteAddress ?? "";
  return (
    address === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(address) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/i.test(address)
  );
}

async function handleRequest(req, res) {
  // The Host header is attacker-controlled. Only the path is needed here, so a
  // fixed base avoids turning it into URL or origin authority.
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const closeAfterResponse = () => {
    res.setHeader("connection", "close");
    res.once("finish", () => req.destroy());
    req.resume();
  };
  const rejectAndClose = (code, body) => {
    closeAfterResponse();
    return json(code, body);
  };

  if (lifecycle.stopping) {
    applySecurityHeaders(res);
    return rejectAndClose(503, { error: "service unavailable" });
  }

  // Runner transport has an independent host principal. It is deliberately
  // mounted before human/agent auth, and only for this versioned namespace.
  if (
    RUNNER_MODE === "remote" &&
    (url.pathname === "/runner/v1" || url.pathname.startsWith("/runner/v1/"))
  ) {
    applySecurityHeaders(res);
    await runner.handleHttp(req, res);
    return undefined;
  }

  // These deliberately tiny probes are reachable only over the Hub's loopback
  // socket. They expose no principal, host identity, counts or configuration
  // and never touch the event log.
  if (
    req.method === "GET" &&
    isLoopbackRequest(req) &&
    (url.pathname === "/health/live" || url.pathname === "/health/ready")
  ) {
    applySecurityHeaders(res);
    res.setHeader("cache-control", "no-store");
    closeAfterResponse();
    if (url.pathname === "/health/live") return json(200, { status: "ok" });

    let ready = false;
    try {
      ready = (await runner.health())?.ready === true;
    } catch {
      // Readiness is fail-closed and its response never reflects internal errors.
    }
    return json(ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
  }

  // Public, inert bootstrap only. It contains no project state, roster, token
  // or capability data. The fragment credential is handled entirely in the
  // browser and is never part of this request.
  if (req.method === "GET" && url.pathname === "/") {
    applySecurityHeaders(res);
    closeAfterResponse();
    const [source, reducerSource, htmlSource] = await Promise.all([
      readFile(join(PUBLIC, "index.html"), "utf8"),
      readFile(join(HERE, "thread.mjs"), "utf8"),
      readFile(join(HERE, "html.mjs"), "utf8"),
    ]);
    // Module requests cannot attach an Authorization header. Inline the two
    // pure browser modules into this no-data shell; the authenticated SSE is
    // still the only source of project state.
    const html = source
      .replace(
        'import { reduce } from "/src/thread.mjs";',
        reducerSource.replace(/^export /gm, ""),
      )
      .replace(
        'import { escapeHtml as esc } from "/src/html.mjs";',
        `${htmlSource.replace(/^export /gm, "")}\nconst esc = escapeHtml;`,
      );
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  const principal = credentials.authenticate(req.headers.authorization);
  if (!principal) {
    applySecurityHeaders(res);
    res.setHeader("www-authenticate", 'Bearer realm="agent-os"');
    return rejectAndClose(401, { error: "bearer token required" });
  }

  const cors = requestOrigin(req, origins);
  applySecurityHeaders(res, cors.origin);
  if (!cors.ok) return rejectAndClose(403, { error: "cross-origin request denied" });

  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    closeAfterResponse();
    return res.writeHead(204).end();
  }

  const requireKind = (kind) => {
    if (principal.kind === kind) return true;
    rejectAndClose(403, { error: `${kind} credential required` });
    return false;
  };

  const requireRunnerReady = async () => {
    if (RUNNER_MODE === "local" || (await runner.health()).ready) return true;
    // Reject before reading or emitting anything: an offline Worker cannot
    // leave a message/task recorded as if execution had started.
    res.setHeader("retry-after", "1");
    rejectAndClose(503, { error: "remote runner unavailable" });
    return false;
  };

  // The browser imports the reducer rather than reimplementing it — one rule,
  // one module, two consumers.
  if (req.method === "GET" && url.pathname === "/src/thread.mjs") {
    if (!requireKind("human")) return undefined;
    closeAfterResponse();
    const js = await readFile(join(HERE, "thread.mjs"), "utf8");
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    return res.end(js);
  }

  if (req.method === "GET" && url.pathname === "/src/html.mjs") {
    if (!requireKind("human")) return undefined;
    closeAfterResponse();
    const js = await readFile(join(HERE, "html.mjs"), "utf8");
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    return res.end(js);
  }

  if (req.method === "GET" && url.pathname === "/events") {
    if (!requireKind("human")) return undefined;
    const admission = sseClients.admit(
      res,
      () =>
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
    if (!admission.accepted) {
      res.setHeader("cache-control", "no-store");
      res.setHeader("retry-after", "1");
      return rejectAndClose(503, { error: "event stream unavailable" });
    }
    return undefined;
  }

  if (req.method === "POST" && url.pathname === "/say") {
    if (!requireKind("human")) return undefined;
    if (!(await requireRunnerReady())) return undefined;
    const body = await readHubJsonBody(req);
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
    if (!requireKind("agent")) return undefined;
    closeAfterResponse();
    return json(200, { tools: hub.tools.list() });
  }

  if (req.method === "POST" && url.pathname === "/mcp/call") {
    if (!requireKind("agent")) return undefined;
    const body = await readHubJsonBody(req);
    try {
      if (body?.name === "register_agent" && body?.arguments?.id !== principal.id) {
        throw new ValidationError(
          `token for "${principal.id}" cannot register "${body?.arguments?.id ?? ""}"`,
        );
      }
      const result = await hub.tools.call(body?.name, body?.arguments, principal.id);
      // Which tools an agent actually reaches for is the observation B.3 turns
      // on — whether a model cooperates with "ask by capability, don't name
      // names" is not something the schema can enforce.
      console.log(`  tool  ${principal.id.padEnd(7)} ${body?.name}`);
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
    if (!requireKind("human")) return undefined;
    const body = await readHubJsonBody(req);
    try {
      hub.accept(String(body?.task ?? ""), body?.ok !== false);
      return json(200, { ok: true });
    } catch (e) {
      return json(400, { error: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/task") {
    if (!requireKind("human")) return undefined;
    if (!(await requireRunnerReady())) return undefined;
    const body = await readHubJsonBody(req);
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
    if (!requireKind("human")) return undefined;
    const body = await readHubJsonBody(req);
    const agentId = String(body?.agent ?? "");
    const entry = hub.agents.get(agentId);
    if (!entry) return json(400, { error: "未知 agent" });
    await hub.resetSession(agentId);
    broadcast("roster", { agents: hub.roster() });
    broadcast("notice", {
      text: `${entry.label} 的 vendor 会话已丢弃——下一轮冷启动。日志不受影响。`,
    });
    return json(200, { ok: true });
  }

  return rejectAndClose(404, { error: "not found" });
}

const lifecycle = createServerLifecycle({
  server,
  closeRunner: () => hub.close(),
  closeClients: () => sseClients.closeAll(),
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : PORT;
  if (!process.env.AGENT_OS_ALLOWED_ORIGINS && listeningPort !== PORT) {
    origins = allowedOrigins({ host: HOST, port: listeningPort });
  }
  const callbackHost = ["0.0.0.0", "::"].includes(HOST) ? "127.0.0.1" : HOST;
  hub.url = `http://${callbackHost}:${listeningPort}`;
  console.log(`agent hub  →  http://${HOST}:${listeningPort}`);
  if (
    shouldPrintGeneratedHumanToken({
      runnerMode: RUNNER_MODE,
      configuredHumanToken: process.env.AGENT_OS_HUMAN_TOKEN,
      nodeEnv: process.env.NODE_ENV,
      isTty: process.stdout.isTTY === true,
    })
  ) {
    console.log(`human token →  ${credentials.humanToken}`);
  }
  console.log(`日志       →  ${LOG_PATH}（已有 ${log.size} 条，seq ${log.seq}）`);
  for (const a of hub.roster()) {
    const mark = a.integration.participates ? "会调工具" : "需适配器翻译";
    console.log(
      `  · ${a.id.padEnd(7)} ${a.role.padEnd(12)} ${mark}  [${a.capabilities.join(", ")}]`,
    );
  }
  console.log(`回环预算   →  ${hub.budget} 跳`);
});

installShutdownSignalHandlers({ shutdown: lifecycle.shutdown });
