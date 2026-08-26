/** Agent OS MCP stdio bridge shared by the standalone CLI and Worker bundle. */

import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";

function loadToken(environment) {
  const path = environment.AGENT_OS_SECRET_FILE;
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

export function runMcpBridge({
  input = process.stdin,
  output = process.stdout,
  environment = process.env,
  fetchImpl = fetch,
} = {}) {
  const base = environment.AGENT_OS_URL ?? "http://127.0.0.1:4173";
  const token = loadToken(environment);
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  async function http(path, init) {
    if (!token) throw new Error("AGENT_OS_TOKEN 未配置");
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    const response = await fetchImpl(`${base}${path}`, { ...init, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body;
  }

  async function handle(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    switch (message.method) {
      case "initialize":
        return reply(message.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-os", title: "Agent OS", version: "0.0.0" },
        });
      case "notifications/initialized":
        return undefined;
      case "tools/list":
        try {
          const { tools } = await http("/mcp/tools");
          return reply(message.id, { tools });
        } catch (error) {
          return fail(message.id, -32603, `Agent OS 不可达：${error.message}`);
        }
      case "tools/call":
        try {
          const { result } = await http("/mcp/call", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: message.params?.name,
              arguments: message.params?.arguments ?? {},
            }),
          });
          return reply(message.id, {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          });
        } catch (error) {
          return reply(message.id, {
            content: [{ type: "text", text: error.message }],
            isError: true,
          });
        }
      default:
        if (message.id !== undefined) {
          return fail(message.id, -32601, `未实现：${message.method}`);
        }
        return undefined;
    }
  }

  let buffer = "";
  input.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) void handle(line);
    }
  });
}
