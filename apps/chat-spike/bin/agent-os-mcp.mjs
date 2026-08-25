#!/usr/bin/env node
/**
 * Agent OS as an MCP server, over stdio.
 *
 * This is the **participation channel** an external agent connects to. It is a
 * thin bridge: the agent's MCP client spawns this process, and every tool call
 * is forwarded to the running chat-spike over HTTP, where validation,
 * authorization and event emission actually happen.
 *
 *   agent ──spawn──▶ this ──HTTP──▶ chat-spike ──▶ MCP tools ──▶ event log
 *
 * Deliberately holds no state and makes no decisions — putting either here
 * would create a second place that can write to the log.
 *
 * Attach it to Claude Code with:
 *   claude --mcp-config '{"mcpServers":{"agent-os":{"command":"node","args":["<abs path>"]}}}'
 *
 * Env: AGENT_OS_URL (default http://127.0.0.1:4173), AGENT_OS_SECRET_FILE.
 */

import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";

const BASE = process.env.AGENT_OS_URL ?? "http://127.0.0.1:4173";
function loadToken() {
  const path = process.env.AGENT_OS_SECRET_FILE;
  if (!path) return null;
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("AGENT_OS_SECRET_FILE is not a private regular file");
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
      throw new Error("AGENT_OS_SECRET_FILE identity changed while opening it");
    }
    const parsed = JSON.parse(readFileSync(fd, "utf8"));
    if (typeof parsed.token !== "string" || parsed.token.length < 32) {
      throw new Error("AGENT_OS_SECRET_FILE has an invalid credential");
    }
    return parsed.token;
  } finally {
    closeSync(fd);
  }
}

const TOKEN = loadToken();

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

async function http(path, init) {
  if (!TOKEN) throw new Error("AGENT_OS_TOKEN 未配置");
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-os", title: "Agent OS", version: "0.0.0" },
      });

    case "notifications/initialized":
      return undefined;

    case "tools/list":
      try {
        const { tools } = await http("/mcp/tools");
        return reply(msg.id, { tools });
      } catch (e) {
        return fail(msg.id, -32603, `Agent OS 不可达：${e.message}`);
      }

    case "tools/call":
      try {
        const { result } = await http("/mcp/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: msg.params?.name,
            arguments: msg.params?.arguments ?? {},
          }),
        });
        return reply(msg.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        });
      } catch (e) {
        // Surface a rejection as a tool error the model can read and correct,
        // not as a protocol fault.
        return reply(msg.id, {
          content: [{ type: "text", text: e.message }],
          isError: true,
        });
      }

    default:
      if (msg.id !== undefined) return fail(msg.id, -32601, `未实现：${msg.method}`);
      return undefined;
  }
}
