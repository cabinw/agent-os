import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import {
  SubprocessAdapter,
  childProcessEnv,
} from "../apps/chat-spike/src/adapters/base.mjs";

const SERVER = resolve("apps/chat-spike/src/server.mjs");
const WORKER_ENTRY = resolve("apps/chat-spike/src/runner-worker.mjs");
const FIXTURE_WORKER_ENTRY = fileURLToPath(
  new URL("./fixtures/runner-worker-entry.mjs", import.meta.url),
);
const ENV_FIXTURE = fileURLToPath(new URL("./fixtures/runner-env.mjs", import.meta.url));
const HOST_ID = "remote-server-fixture";
const HUMAN_TOKEN = "human_remote_integration_abcdefghijklmnopqrstuvwxyz";
const RUNNER_TOKEN = "runner_remote_integration_abcdefghijklmnopqrstuvwxyz";
const AGENT_TOKENS = Object.freeze({
  claude: "claude_remote_integration_abcdefghijklmnopqrstuvwxyz",
  codex: "codex_remote_integration_abcdefghijklmnopqrstuvwxyz_1",
  grok: "grok_remote_integration_abcdefghijklmnopqrstuvwxyz_12",
  kimi: "kimi_remote_integration_abcdefghijklmnopqrstuvwxyz_12",
});

type FixtureLine = {
  type: "delta" | "progress" | "usage" | "result";
  text?: string;
  label?: string;
  input?: number;
  output?: number;
  total?: number;
  sessionId?: string;
};

type StoredEvent = {
  type: string;
  actor?: { kind: string; id: string };
  payload?: Record<string, unknown>;
};

class ChildEnvFixtureAdapter extends SubprocessAdapter {
  static id = "env-fixture";
  static label = "Child env fixture";
  static capabilities = {
    streaming: false,
    thoughts: false,
    session: true,
    usage: false,
  };

  buildCommand() {
    return { cmd: process.execPath, args: [ENV_FIXTURE] };
  }

  handleLine(line: FixtureLine) {
    return { text: line.text, sessionId: line.sessionId };
  }
}

function isolatedEnvironment(overrides: Record<string, string>) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        name !== "HOST" &&
        name !== "PORT" &&
        name !== "LOG_PATH" &&
        name !== "SESSION_PATH" &&
        name !== "AGENT_CWD" &&
        !name.startsWith("AGENT_OS_"),
    ),
  );
  return { ...env, ...overrides };
}

function spawnProgram(program: string, environment: Record<string, string>) {
  const child = spawn(process.execPath, [program], {
    cwd: resolve("."),
    env: isolatedEnvironment(environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const captured = { output: "" };
  child.stdout.on("data", (chunk) => {
    captured.output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    captured.output += chunk.toString();
  });
  return { child, captured };
}

function spawnServer(environment: Record<string, string>) {
  return spawnProgram(SERVER, environment);
}

async function waitForExit(
  child: ReturnType<typeof spawnServer>["child"],
  timeoutMs = 5_000,
) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      };
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        reject(new Error("等待 server 子进程退出超时"));
      }, timeoutMs);
      timer.unref?.();
      child.once("exit", onExit);
    },
  );
}

async function waitForReady(server: ReturnType<typeof spawnServer>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = server.captured.output.match(
      /agent hub\s+→\s+http:\/\/127\.0\.0\.1:(\d+)/,
    );
    if (match) return `http://127.0.0.1:${match[1]}`;
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(
        `Hub exited before ready (${server.child.exitCode ?? server.child.signalCode}):\n${server.captured.output}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Hub did not start:\n${server.captured.output}`);
}

async function waitForOutput(process: ReturnType<typeof spawnProgram>, pattern: RegExp) {
  await waitFor(() => {
    if (pattern.test(process.captured.output)) return true;
    if (process.child.exitCode !== null || process.child.signalCode !== null) {
      throw new Error(
        `子进程在输出就绪标记前退出 (${process.child.exitCode ?? process.child.signalCode}):\n${process.captured.output}`,
      );
    }
    return false;
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("等待远程集成状态超时");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function authenticated(
  baseUrl: string,
  path: string,
  token: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

async function replay(path: string): Promise<StoredEvent[]> {
  try {
    const content = await readFile(path, "utf8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function terminate(server: ReturnType<typeof spawnServer>) {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill("SIGTERM");
  }
  return waitForExit(server.child, 10_000);
}

describe("Remote Runner production composition", () => {
  it("removes control credentials from a real vendor child", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "agent-os-child-env-"));
    const controlled = {
      AGENT_OS_RUNNER_TOKEN: RUNNER_TOKEN,
      AGENT_OS_HUMAN_TOKEN: HUMAN_TOKEN,
      AGENT_OS_AGENT_TOKENS: JSON.stringify(AGENT_TOKENS),
      AGENT_OS_RUNNER_ID: HOST_ID,
      agent_os_runner_token: "lowercase_control_token_must_be_removed",
      AGENT_OS_TOKEN: "ambient_token_that_must_be_replaced",
      AGENT_OS_URL: "https://ambient.invalid",
    };
    const previous = new Map(
      Object.keys(controlled).map((name) => [name, process.env[name]]),
    );

    try {
      Object.assign(process.env, controlled);
      const adapter = new ChildEnvFixtureAdapter({
        cwd: scratch,
        mcp: {
          args: [],
          env: {
            AGENT_OS_TOKEN: AGENT_TOKENS.claude,
            AGENT_OS_URL: "https://hub.example",
          },
        },
      });
      const result = await adapter.send("inspect env");
      expect(JSON.parse(result.text)).toEqual({
        runnerToken: null,
        humanToken: null,
        agentTokenMap: null,
        runnerId: null,
        lowercaseRunnerToken: null,
        scopedToken: AGENT_TOKENS.claude,
        scopedUrl: "https://hub.example",
      });
      expect(() => childProcessEnv({ AGENT_OS_RUNNER_TOKEN: RUNNER_TOKEN })).toThrow(
        /不允许注入控制面变量/,
      );
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("fails closed on invalid outbound Worker configuration", async () => {
    const valid = {
      AGENT_OS_URL: "http://127.0.0.1:4173",
      AGENT_OS_RUNNER_TOKEN: RUNNER_TOKEN,
      AGENT_OS_RUNNER_ID: HOST_ID,
      AGENT_OS_AGENT_TOKENS: JSON.stringify(AGENT_TOKENS),
    };
    const duplicateAgentTokens = {
      ...AGENT_TOKENS,
      grok: AGENT_TOKENS.claude,
    };
    const cases = [
      { env: {}, message: /AGENT_OS_URL is required/ },
      {
        env: { AGENT_OS_URL: valid.AGENT_OS_URL },
        message: /AGENT_OS_RUNNER_TOKEN is required/,
      },
      {
        env: { ...valid, AGENT_OS_URL: "http://worker.example" },
        message: /must use HTTPS.*loopback/,
      },
      {
        env: { ...valid, AGENT_OS_URL: "https://user:secret@worker.example" },
        message: /must not contain credentials/,
      },
      {
        env: { ...valid, AGENT_OS_RUNNER_TOKEN: "short" },
        message: /RUNNER_TOKEN must be at least/,
      },
      {
        env: {
          ...valid,
          AGENT_OS_AGENT_TOKENS: JSON.stringify({
            ...AGENT_TOKENS,
            claude: "short",
          }),
        },
        message: /token for agent claude must be at least/,
      },
      {
        env: { ...valid, AGENT_OS_RUNNER_ID: "" },
        message: /AGENT_OS_RUNNER_ID is required/,
      },
      {
        env: {
          ...valid,
          AGENT_OS_AGENT_TOKENS: JSON.stringify({ claude: AGENT_TOKENS.claude }),
        },
        message: /must explicitly configure Worker principals/,
      },
      {
        env: { ...valid, AGENT_OS_RUNNER_TOKEN: AGENT_TOKENS.claude },
        message: /RUNNER_TOKEN must be independent/,
      },
      {
        env: {
          ...valid,
          AGENT_OS_AGENT_TOKENS: JSON.stringify(duplicateAgentTokens),
        },
        message: /duplicates another agent credential/,
      },
    ];

    for (const testCase of cases) {
      const worker = spawnProgram(WORKER_ENTRY, testCase.env);
      try {
        const exited = await waitForExit(worker.child);
        expect(exited.code).not.toBe(0);
        expect(worker.captured.output).toMatch(testCase.message);
        expect(worker.captured.output).not.toContain(RUNNER_TOKEN);
      } finally {
        if (worker.child.exitCode === null && worker.child.signalCode === null) {
          worker.child.kill("SIGKILL");
          await waitForExit(worker.child);
        }
      }
    }
  });

  it("fails closed for unknown mode and incomplete remote credentials", async () => {
    const cases = [
      {
        env: { AGENT_OS_RUNNER_MODE: "hybrid" },
        message: /AGENT_OS_RUNNER_MODE must be "local" or "remote"/,
      },
      {
        env: { AGENT_OS_RUNNER_MODE: "remote" },
        message: /AGENT_OS_RUNNER_ID is required/,
      },
      {
        env: {
          AGENT_OS_RUNNER_MODE: "remote",
          AGENT_OS_RUNNER_ID: HOST_ID,
        },
        message: /AGENT_OS_RUNNER_TOKEN is required/,
      },
      {
        env: {
          AGENT_OS_RUNNER_MODE: "remote",
          AGENT_OS_RUNNER_ID: HOST_ID,
          AGENT_OS_RUNNER_TOKEN: RUNNER_TOKEN,
          AGENT_OS_AGENT_TOKENS: JSON.stringify(AGENT_TOKENS),
        },
        message: /AGENT_OS_HUMAN_TOKEN is required/,
      },
      {
        env: {
          AGENT_OS_RUNNER_MODE: "remote",
          AGENT_OS_RUNNER_ID: HOST_ID,
          AGENT_OS_RUNNER_TOKEN: RUNNER_TOKEN,
          AGENT_OS_HUMAN_TOKEN: HUMAN_TOKEN,
        },
        message: /AGENT_OS_AGENT_TOKENS must explicitly configure/,
      },
      {
        env: {
          AGENT_OS_RUNNER_MODE: "remote",
          AGENT_OS_RUNNER_ID: HOST_ID,
          AGENT_OS_RUNNER_TOKEN: HUMAN_TOKEN,
          AGENT_OS_HUMAN_TOKEN: HUMAN_TOKEN,
          AGENT_OS_AGENT_TOKENS: JSON.stringify(AGENT_TOKENS),
        },
        message: /RUNNER_TOKEN must be independent/,
      },
    ];

    for (const testCase of cases) {
      const server = spawnServer(testCase.env);
      try {
        const exited = await waitForExit(server.child);
        expect(exited.code).not.toBe(0);
        expect(server.captured.output).toMatch(testCase.message);
      } finally {
        if (server.child.exitCode === null && server.child.signalCode === null) {
          server.child.kill("SIGKILL");
          await waitForExit(server.child);
        }
      }
    }
  });

  it("mounts isolated Runner auth and completes Hub → Remote → Local task", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "agent-os-remote-server-"));
    const logPath = join(scratch, "hub", "events.jsonl");
    const placementPath = join(scratch, "hub", "remote-placement.json");
    const hubWorkspace = join(scratch, "hub-must-not-own-workspace");
    const workerWorkspace = join(scratch, "worker", "workspaces");
    const workerSessionPath = join(scratch, "worker", "sessions.json");

    const server = spawnServer({
      PORT: "0",
      LOG_PATH: logPath,
      AGENT_CWD: hubWorkspace,
      AGENT_OS_RUNNER_MODE: "remote",
      AGENT_OS_RUNNER_ID: HOST_ID,
      AGENT_OS_RUNNER_TOKEN: RUNNER_TOKEN,
      AGENT_OS_HUMAN_TOKEN: HUMAN_TOKEN,
      AGENT_OS_AGENT_TOKENS: JSON.stringify(AGENT_TOKENS),
      AGENT_OS_REMOTE_STATE_PATH: placementPath,
    });
    let productionWorker: ReturnType<typeof spawnProgram> | null = null;
    let taskWorker: ReturnType<typeof spawnProgram> | null = null;

    try {
      const baseUrl = await waitForReady(server);
      expect(await exists(hubWorkspace)).toBe(false);
      expect(server.captured.output).not.toContain("human token");

      const anonymousRunner = await fetch(`${baseUrl}/runner/v1/poll`);
      expect(anonymousRunner.status).toBe(401);
      expect(anonymousRunner.headers.get("www-authenticate")).toContain(
        "agent-os-runner",
      );

      for (const principalToken of [HUMAN_TOKEN, AGENT_TOKENS.claude]) {
        const rejected = await authenticated(baseUrl, "/runner/v1/poll", principalToken);
        expect(rejected.status).toBe(401);
        expect(rejected.headers.get("www-authenticate")).toContain("agent-os-runner");
      }

      const mounted = await authenticated(baseUrl, "/runner/v1/poll", RUNNER_TOKEN);
      expect(mounted.status).toBe(405);

      for (const applicationPath of ["/events", "/mcp/tools"]) {
        const rejected = await authenticated(baseUrl, applicationPath, RUNNER_TOKEN);
        expect(rejected.status).toBe(401);
        expect(rejected.headers.get("www-authenticate")).toContain('realm="agent-os"');
      }

      const offlineTask = await authenticated(baseUrl, "/task", HUMAN_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "must not be recorded", requires: ["coding"] }),
      });
      expect(offlineTask.status).toBe(503);
      expect(offlineTask.headers.get("retry-after")).toBe("1");
      const offlineSay = await authenticated(baseUrl, "/say", HUMAN_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "must not be recorded", to: "claude" }),
      });
      expect(offlineSay.status).toBe(503);
      const offlineAgentMessage = await authenticated(
        baseUrl,
        "/mcp/call",
        AGENT_TOKENS.claude,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "send_message",
            arguments: {
              from: "claude",
              to: "grok",
              type: "instruction",
              content: "offline agent wake must not be recorded",
            },
          }),
        },
      );
      expect(offlineAgentMessage.status).toBe(400);
      expect(await offlineAgentMessage.text()).toContain("Runner 尚未就绪");
      const offlineEvents = await replay(logPath);
      expect(
        offlineEvents.some((event) =>
          ["task.created", "task.started"].includes(event.type),
        ),
      ).toBe(false);
      expect(
        offlineEvents.some((event) =>
          String(event.payload?.content ?? "").includes("must not be recorded"),
        ),
      ).toBe(false);

      const entryWorkspace = join(scratch, "entry-worker", "workspaces");
      productionWorker = spawnProgram(WORKER_ENTRY, {
        AGENT_OS_URL: baseUrl,
        AGENT_OS_RUNNER_ID: HOST_ID,
        AGENT_OS_RUNNER_TOKEN: RUNNER_TOKEN,
        AGENT_OS_AGENT_TOKENS: JSON.stringify(AGENT_TOKENS),
        AGENT_CWD: entryWorkspace,
        SESSION_PATH: join(scratch, "entry-worker", "sessions.json"),
      });
      await waitForOutput(productionWorker, /remote runner worker\s+→/);
      expect(await exists(join(entryWorkspace, "claude"))).toBe(true);
      await waitFor(async () => {
        const probe = await authenticated(baseUrl, "/task", HUMAN_TOKEN, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "" }),
        });
        await probe.text();
        if (probe.status === 503) return false;
        expect(probe.status).toBe(400);
        return true;
      });
      productionWorker.child.kill("SIGTERM");
      expect(await waitForExit(productionWorker.child, 10_000)).toEqual({
        code: 0,
        signal: null,
      });
      for (const secret of [RUNNER_TOKEN, ...Object.values(AGENT_TOKENS)]) {
        expect(productionWorker.captured.output).not.toContain(secret);
      }
      productionWorker = null;

      // This second executable uses the production composition factory and
      // replaces only the paid vendor class with a real subprocess fixture.
      taskWorker = spawnProgram(FIXTURE_WORKER_ENTRY, {
        AGENT_OS_URL: baseUrl,
        AGENT_OS_RUNNER_ID: HOST_ID,
        AGENT_OS_RUNNER_TOKEN: RUNNER_TOKEN,
        AGENT_OS_AGENT_TOKENS: JSON.stringify(AGENT_TOKENS),
        AGENT_CWD: workerWorkspace,
        SESSION_PATH: workerSessionPath,
      });
      await waitForOutput(taskWorker, /remote runner worker\s+→/);

      const taskResponse = await authenticated(baseUrl, "/task", HUMAN_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "remote integration task", requires: ["coding"] }),
      });
      expect(taskResponse.status).toBe(202);
      const task = (await taskResponse.json()) as { task: string };

      await waitFor(async () =>
        (await replay(logPath)).some(
          (event) =>
            event.type === "task.review.requested" && event.payload?.task === task.task,
        ),
      );
      await waitFor(async () => {
        if (!(await exists(placementPath))) return false;
        return (await readFile(placementPath, "utf8")).includes(HOST_ID);
      });

      const events = await replay(logPath);
      const lifecycle = events
        .filter((event) => event.payload?.task === task.task)
        .map((event) => event.type);
      expect(lifecycle).toEqual([
        "task.created",
        "task.assigned",
        "task.started",
        "task.review.requested",
      ]);
      expect(
        events.find((event) => event.type === "task.review.requested"),
      ).toMatchObject({
        actor: { kind: "agent", id: "claude" },
        payload: { summary: "remote fixture delivered" },
      });

      const controller = new AbortController();
      const eventStream = await authenticated(baseUrl, "/events", HUMAN_TOKEN, {
        signal: controller.signal,
      });
      const firstFrame = await eventStream.body?.getReader().read();
      controller.abort();
      const hello = JSON.parse(
        new TextDecoder()
          .decode(firstFrame?.value)
          .trim()
          .replace(/^data:\s*/, ""),
      );
      expect(
        hello.agents.find((agent: { id: string }) => agent.id === "claude"),
      ).toMatchObject({ hasSession: true });

      taskWorker.child.kill("SIGTERM");
      expect(await waitForExit(taskWorker.child, 10_000)).toEqual({
        code: 0,
        signal: null,
      });
      for (const secret of [RUNNER_TOKEN, ...Object.values(AGENT_TOKENS)]) {
        expect(taskWorker.captured.output).not.toContain(secret);
      }
      taskWorker = null;
      const exited = await terminate(server);
      expect(exited).toEqual({ code: 0, signal: null });

      const placement = await readFile(placementPath, "utf8");
      expect((await stat(placementPath)).mode & 0o777).toBe(0o600);
      for (const secret of [HUMAN_TOKEN, RUNNER_TOKEN, ...Object.values(AGENT_TOKENS)]) {
        expect(server.captured.output).not.toContain(secret);
        expect(placement).not.toContain(secret);
      }
    } finally {
      if (
        taskWorker &&
        taskWorker.child.exitCode === null &&
        taskWorker.child.signalCode === null
      ) {
        taskWorker.child.kill("SIGTERM");
        await waitForExit(taskWorker.child, 10_000);
      }
      if (
        productionWorker &&
        productionWorker.child.exitCode === null &&
        productionWorker.child.signalCode === null
      ) {
        productionWorker.child.kill("SIGTERM");
        await waitForExit(productionWorker.child, 10_000);
      }
      if (server.child.exitCode === null && server.child.signalCode === null) {
        await terminate(server);
      }
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
