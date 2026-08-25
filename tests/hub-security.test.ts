import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error
import { childProcessEnv } from "../apps/chat-spike/src/adapters/base.mjs";
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

function at(path: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "agent-os-hub-security-")));
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

  it("serves an anonymous inert root shell with fragment/password bootstrap only", async () => {
    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("www-authenticate")).toBeNull();
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const html = await page.text();
    expect(html).toContain('type="password"');
    expect(html).toContain('params.get("token")');
    expect(html).toContain("history.replaceState");
    expect(html.indexOf("history.replaceState")).toBeLessThan(html.indexOf("fetch(path"));
    expect(html).not.toContain(HUMAN_TOKEN);
    expect(html).not.toContain(CLAUDE_TOKEN);
    expect(html).not.toContain("__AGENT_OS_BEARER__");
    expect(html).not.toMatch(/localStorage|document\.cookie/);
    expect(html).not.toContain('import { reduce } from "/src/thread.mjs"');

    // URL fragments are removed by the client and never cross the HTTP boundary.
    const withFragment = await fetch(`${baseUrl}/#token=${HUMAN_TOKEN}`);
    expect(withFragment.status).toBe(200);
    expect(await withFragment.text()).not.toContain(HUMAN_TOKEN);
  });

  it("rejects anonymous access on every HTTP and SSE surface, including 404", async () => {
    const requests: Array<Promise<Response>> = [
      fetch(`${baseUrl}/src/thread.mjs`),
      fetch(`${baseUrl}/src/html.mjs`),
      fetch(`${baseUrl}/events`),
      fetch(`${baseUrl}/events?token=${HUMAN_TOKEN}`),
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

  it("accepts the human bearer for modules, SSE and controls", async () => {
    const module = await at("/src/html.mjs", HUMAN_TOKEN);
    expect(module.status).toBe(200);

    const controller = new AbortController();
    const events = await at("/events", HUMAN_TOKEN, { signal: controller.signal });
    expect(events.status).toBe(200);
    const first = await events.body?.getReader().read();
    controller.abort();
    expect(new TextDecoder().decode(first?.value)).toContain('"type":"hello"');

    const reset = await at("/reset", HUMAN_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "codex" }),
    });
    expect(reset.status).toBe(200);
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
    const publicShell = await fetch(`${baseUrl}/`, {
      headers: { origin: "https://attacker.example" },
    });
    expect(publicShell.status).toBe(200);
    expect(publicShell.headers.get("access-control-allow-origin")).toBeNull();

    const denied = await at("/not-a-route", HUMAN_TOKEN, {
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
    const credentialDir = join(scratch, "credentials", "grok-policy");
    const mounted = mountMcp("grok", {
      dir,
      credentialDir,
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
    expect(childProcessEnv(mounted.env).GROK_FOLDER_TRUST).toBe("false");

    const configPath = join(dir, ".grok", "config.toml");
    const config = await readFile(configPath, "utf8");
    expect(config).not.toContain(CLAUDE_TOKEN);
    expect(config).not.toContain("AGENT_OS_TOKEN");
    expect(config).toContain("AGENT_OS_SECRET_FILE");
    expect(config).not.toContain("AGENT_OS_CALLER");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    const secretPath = join(credentialDir, "mcp-secret.json");
    expect(await readFile(secretPath, "utf8")).toContain(CLAUDE_TOKEN);
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
  });

  it("refuses credential reparse points, hard links and workspace config links", async () => {
    const target = join(scratch, "credential-link-target");
    const workspace = join(scratch, "credential-link-workspace");
    await mkdir(target, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const linkedRoot = join(scratch, "credential-root-link");
    await symlink(target, linkedRoot, "dir");
    expect(() =>
      mountMcp("claude", {
        dir: workspace,
        credentialDir: linkedRoot,
        url: baseUrl,
        token: CLAUDE_TOKEN,
      }),
    ).toThrow(/fixed non-link directory/);

    const hardlinkRoot = join(scratch, "credential-hardlink-root");
    await mkdir(hardlinkRoot, { recursive: true });
    const protectedFile = join(scratch, "credential-hardlink-protected");
    await writeFile(protectedFile, JSON.stringify({ token: CLAUDE_TOKEN }), {
      mode: 0o600,
    });
    await link(protectedFile, join(hardlinkRoot, "mcp-secret.json"));
    expect(() =>
      mountMcp("claude", {
        dir: workspace,
        credentialDir: hardlinkRoot,
        url: baseUrl,
        token: CLAUDE_TOKEN,
      }),
    ).toThrow(/private non-link regular file/);

    const safeRoot = join(scratch, "credential-safe-root");
    const configTarget = join(scratch, "workspace-config-target");
    await writeFile(configTarget, "do-not-overwrite", { mode: 0o600 });
    await symlink(configTarget, join(workspace, "mcp.json"));
    expect(() =>
      mountMcp("claude", {
        dir: workspace,
        credentialDir: safeRoot,
        url: baseUrl,
        token: CLAUDE_TOKEN,
      }),
    ).toThrow(/private non-link regular file/);
    expect(await readFile(configTarget, "utf8")).toBe("do-not-overwrite");
  });

  it("loads the scoped bearer through the private secret file, not ambient env", async () => {
    const workspace = join(scratch, "bridge-secret-workspace");
    const credentialDir = join(scratch, "bridge-secret-root");
    await mkdir(workspace, { recursive: true });
    mountMcp("claude", {
      dir: workspace,
      credentialDir,
      url: baseUrl,
      token: CLAUDE_TOKEN,
    });
    const bridge = spawn(
      process.execPath,
      [resolve("apps/chat-spike/bin/agent-os-mcp.mjs")],
      {
        env: {
          ...process.env,
          AGENT_OS_URL: baseUrl,
          AGENT_OS_TOKEN: "wrong_ambient_token_that_must_be_ignored",
          AGENT_OS_SECRET_FILE: join(credentialDir, "mcp-secret.json"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    try {
      const response = await new Promise<Record<string, unknown>>((accept, reject) => {
        const timer = setTimeout(
          () => reject(new Error("MCP bridge response timeout")),
          2000,
        );
        let buffer = "";
        bridge.stdout.on("data", (chunk) => {
          buffer += chunk.toString();
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          clearTimeout(timer);
          accept(JSON.parse(buffer.slice(0, newline)));
        });
        bridge.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`MCP bridge exited before response: ${code}`));
        });
        bridge.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
        );
      });
      expect(response.error).toBeUndefined();
      expect(response.result).toMatchObject({ tools: expect.any(Array) });
    } finally {
      bridge.kill("SIGKILL");
    }
  });
});
