import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import { escapeHtml } from "../apps/chat-spike/src/html.mjs";
// @ts-expect-error
import {
  DEFAULT_HOST,
  createCredentialStore,
  parseAgentTokens,
} from "../apps/chat-spike/src/http-security.mjs";
// @ts-expect-error
import { mountMcp } from "../apps/chat-spike/src/mcp-mount.mjs";

const HUMAN_TOKEN = "human_abcdefghijklmnopqrstuvwxyz_1234567890";
const CLAUDE_TOKEN = "claude_abcdefghijklmnopqrstuvwxyz_12345678";

let child: ChildProcessWithoutNullStreams;
let scratch: string;
let logPath: string;
let baseUrl: string;
let output = "";

function authorized(token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(baseUrl, { ...init, headers });
}

function at(path: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "agent-os-hub-security-"));
  logPath = join(scratch, "events.jsonl");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "HOST"),
  );
  Object.assign(env, {
    PORT: "0",
    LOG_PATH: logPath,
    AGENT_CWD: join(scratch, "workspace"),
    AGENT_OS_HUMAN_TOKEN: HUMAN_TOKEN,
    AGENT_OS_AGENT_TOKENS: JSON.stringify({ claude: CLAUDE_TOKEN }),
  });

  child = spawn(process.execPath, [resolve("apps/chat-spike/src/server.mjs")], {
    cwd: resolve("."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Hub did not start:\n${output}`)),
      10_000,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/agent hub\s+→\s+http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      baseUrl = `http://127.0.0.1:${match[1]}`;
      resolveReady();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Hub exited before ready (${code}):\n${output}`));
    });
  });
});

afterAll(async () => {
  if (child?.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("Hub bearer trust boundary", () => {
  it("binds to loopback by default", () => {
    expect(DEFAULT_HOST).toBe("127.0.0.1");
    expect(output).toMatch(/agent hub\s+→\s+http:\/\/127\.0\.0\.1:/);
  });

  it("rejects anonymous access on every HTTP and SSE surface, including 404", async () => {
    const requests: Array<Promise<Response>> = [
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/src/thread.mjs`),
      fetch(`${baseUrl}/src/html.mjs`),
      fetch(`${baseUrl}/events`),
      fetch(`${baseUrl}/mcp/tools`),
      fetch(`${baseUrl}/mcp/call`, { method: "POST" }),
      fetch(`${baseUrl}/say`, { method: "POST" }),
      fetch(`${baseUrl}/task`, { method: "POST" }),
      fetch(`${baseUrl}/accept`, { method: "POST" }),
      fetch(`${baseUrl}/reset`, { method: "POST" }),
      fetch(`${baseUrl}/not-a-route`),
    ];

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("keeps the browser session authenticated without query tokens or cookies", async () => {
    const page = await authorized(HUMAN_TOKEN);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(page.headers.get("set-cookie")).toBeNull();
    const html = await page.text();
    const match = html.match(/__AGENT_OS_BEARER__="([A-Za-z0-9_-]+)"/);
    expect(match?.[1]).toBeTruthy();
    expect(match?.[1]).not.toBe(HUMAN_TOKEN);
    expect(html).not.toContain('import { reduce } from "/src/thread.mjs"');

    const module = await at("/src/html.mjs", match?.[1] ?? "");
    expect(module.status).toBe(200);

    const controller = new AbortController();
    const events = await at("/events", match?.[1] ?? "", { signal: controller.signal });
    expect(events.status).toBe(200);
    const first = await events.body?.getReader().read();
    controller.abort();
    expect(new TextDecoder().decode(first?.value)).toContain('"type":"hello"');
  });

  it("separates human-only controls from agent-only MCP routes", async () => {
    const humanMcp = await at("/mcp/tools", HUMAN_TOKEN);
    expect(humanMcp.status).toBe(403);

    const agentAccept = await at("/accept", CLAUDE_TOKEN, { method: "POST" });
    expect(agentAccept.status).toBe(403);

    const humanAccept = await at("/accept", HUMAN_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "TASK-does-not-exist", ok: true }),
    });
    expect(humanAccept.status).toBe(400);
  });

  it("derives caller from the token and ignores a forged body caller", async () => {
    const accepted = await at("/mcp/call", CLAUDE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "send_message",
        arguments: {
          from: "claude",
          to: "you",
          type: "answer",
          content: "transport identity proof",
        },
        caller: "grok",
      }),
    });
    expect(accepted.status).toBe(200);

    const forged = await at("/mcp/call", CLAUDE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "send_message",
        arguments: {
          from: "grok",
          to: "you",
          type: "answer",
          content: "forged",
        },
        caller: "grok",
      }),
    });
    expect(forged.status).toBe(400);
    expect(await forged.text()).toMatch(/调用方注册为.*claude/);

    const registerOther = await at("/mcp/call", CLAUDE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "register_agent",
        arguments: { id: "grok", name: "Grok" },
      }),
    });
    expect(registerOther.status).toBe(400);

    const stored = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((event) => event.payload?.content === "transport identity proof");
    expect(stored.actor).toEqual({ kind: "agent", id: "claude" });
  });

  it("rejects untrusted origins and never uses wildcard CORS", async () => {
    const denied = await at("/", HUMAN_TOKEN, {
      headers: { origin: "https://attacker.example" },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();

    const allowed = await at("/not-a-route", HUMAN_TOKEN, {
      headers: { origin: baseUrl },
    });
    expect(allowed.status).toBe(404);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(baseUrl);
  });
});

describe("credential, HTML and local execution hardening", () => {
  it("rejects short, malformed and duplicate bearer configuration", () => {
    expect(() => createCredentialStore({ humanToken: "short" })).toThrow(/at least 32/);
    expect(() => parseAgentTokens("[]")).toThrow(/JSON object/);
    expect(() =>
      createCredentialStore({
        humanToken: HUMAN_TOKEN,
        agentTokens: { claude: HUMAN_TOKEN },
      }),
    ).toThrow(/duplicates/);
  });

  it("escapes both quote characters in HTML attributes", () => {
    expect(escapeHtml(`x'\"<>&`)).toBe("x&#39;&quot;&lt;&gt;&amp;");
  });

  it("gives Grok only the Agent OS MCP surface and protects its credential file", async () => {
    const dir = join(scratch, "grok-policy");
    const mounted = mountMcp("grok", {
      dir,
      url: baseUrl,
      token: CLAUDE_TOKEN,
    });
    expect(mounted.args).toContain("dontAsk");
    expect(mounted.args).toContain("MCPTool(agent-os__*)");
    expect(mounted.args).toContain("todo_write");
    expect(mounted.args).toContain("workspace");
    expect(mounted.args).not.toContain("--always-approve");
    expect(mounted.args).toContain("--no-subagents");
    expect(mounted.args).toContain("--disable-web-search");

    const configPath = join(dir, ".grok", "config.toml");
    const config = await readFile(configPath, "utf8");
    expect(config).toContain(`AGENT_OS_TOKEN = "${CLAUDE_TOKEN}"`);
    expect(config).not.toContain("AGENT_OS_CALLER");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });
});
