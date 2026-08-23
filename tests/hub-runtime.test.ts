import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { type Server, createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import { Hub } from "../apps/chat-spike/src/hub.mjs";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import {
  HUB_REQUEST_BODY_LIMIT_BYTES,
  readHubJsonBody,
} from "../apps/chat-spike/src/server-body.mjs";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import {
  SHUTDOWN_FAILURE_MESSAGE,
  ShutdownError,
  createServerLifecycle,
  shouldPrintGeneratedHumanToken,
} from "../apps/chat-spike/src/server-lifecycle.mjs";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import {
  MAX_SSE_BUFFER_BYTES,
  MAX_SSE_CLIENTS,
  createSseClientRegistry,
} from "../apps/chat-spike/src/server-sse.mjs";

const SERVER = resolve("apps/chat-spike/src/server.mjs");
const SHUTDOWN_FIXTURE = fileURLToPath(
  new URL("./fixtures/hub-shutdown-entry.mjs", import.meta.url),
);
const HUMAN_TOKEN = "human_hub_runtime_abcdefghijklmnopqrstuvwxyz";
const RUNNER_TOKEN = "runner_hub_runtime_abcdefghijklmnopqrstuvwxyz";
const WRONG_RUNNER_TOKEN = "wrong_runner_hub_runtime_abcdefghijklmnopqrstuvwxyz";
const HOST_ID = "hub-runtime-fixture";
const AGENT_TOKENS = Object.freeze({
  claude: "claude_hub_runtime_abcdefghijklmnopqrstuvwxyz",
  codex: "codex_hub_runtime_abcdefghijklmnopqrstuvwxyz_1",
  grok: "grok_hub_runtime_abcdefghijklmnopqrstuvwxyz_12",
  kimi: "kimi_hub_runtime_abcdefghijklmnopqrstuvwxyz_12",
});

type SpawnedServer = {
  child: ChildProcessWithoutNullStreams;
  output: { value: string };
};

type EventStreamClient = {
  controller: AbortController;
  response: Response;
};

class FakeSseResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  acceptsWrites = true;
  writes: string[] = [];
  writeHead = vi.fn();
  end = vi.fn(() => {
    this.writableEnded = true;
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
  write = vi.fn((frame: string) => {
    this.writes.push(frame);
    return this.acceptsWrites;
  });
}

function controlledIntervals() {
  const callbacks = new Map<object, () => void>();
  return {
    api: {
      setInterval(callback: () => void) {
        const handle = Object.freeze({ interval: callbacks.size + 1 });
        callbacks.set(handle, callback);
        return handle;
      },
      clearInterval(handle: object) {
        callbacks.delete(handle);
      },
    },
    fireAll() {
      for (const callback of [...callbacks.values()]) callback();
    },
    get size() {
      return callbacks.size;
    },
  };
}

function controlledTimeout() {
  const handle = Object.freeze({ timer: "controlled" });
  let callback: () => void = () => {};
  const setTimer = vi.fn((next: () => void, _ms: number) => {
    callback = next;
    return handle;
  });
  const clearTimer = vi.fn();
  return {
    api: { setTimeout: setTimer, clearTimeout: clearTimer },
    clearTimer,
    fire: () => callback(),
    handle,
    setTimer,
  };
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

function spawnServer(environment: Record<string, string>): SpawnedServer {
  return spawnNode(SERVER, environment);
}

function spawnNode(program: string, environment: Record<string, string>): SpawnedServer {
  const child = spawn(process.execPath, [program], {
    cwd: resolve("."),
    env: isolatedEnvironment(environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { value: "" };
  child.stdout.on("data", (chunk) => {
    output.value += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output.value += chunk.toString();
  });
  return { child, output };
}

async function waitForOutput(server: SpawnedServer, value: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (server.output.value.includes(value)) return;
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error("Child exited before expected output");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Child did not emit expected output");
}

async function waitForReady(server: SpawnedServer) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const match = server.output.value.match(
      /agent hub\s+→\s+http:\/\/127\.0\.0\.1:(\d+)/,
    );
    if (match) return `http://127.0.0.1:${match[1]}`;
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(
        `Hub exited before ready (${server.child.exitCode ?? server.child.signalCode})`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Hub did not become ready");
}

async function waitForExit(server: SpawnedServer, timeoutMs = 3_000) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      };
      const timer = setTimeout(() => {
        server.child.off("exit", onExit);
        reject(new Error("Hub shutdown timed out"));
      }, timeoutMs);
      timer.unref?.();
      server.child.once("exit", onExit);
      if (server.child.exitCode !== null || server.child.signalCode !== null) {
        server.child.off("exit", onExit);
        clearTimeout(timer);
        resolveExit({ code: server.child.exitCode, signal: server.child.signalCode });
      }
    },
  );
}

function authenticated(
  baseUrl: string,
  path: string,
  token: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(3_000),
    ...init,
    headers,
  });
}

async function openEventStream(baseUrl: string): Promise<EventStreamClient> {
  const controller = new AbortController();
  try {
    const response = await authenticated(baseUrl, "/events", HUMAN_TOKEN, {
      signal: controller.signal,
    });
    return { controller, response };
  } catch (error) {
    controller.abort();
    throw error;
  }
}

async function closeEventStream(client: EventStreamClient) {
  try {
    await client.response.body?.cancel();
  } catch {
    // An already-closed stream releases the same server-side slot.
  } finally {
    client.controller.abort();
  }
}

async function listenHttp(server: Server) {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test HTTP server did not listen on TCP");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeHttp(server: Server) {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function partialBodyRequest(baseUrl: string) {
  const url = new URL(baseUrl);
  return new Promise<string>((resolveResponse, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    let response = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error);
      else resolveResponse(response);
    };
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("Timed request did not close the connection"));
    }, 4_500);
    deadline.unref?.();
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        [
          "POST /accept HTTP/1.1",
          `Host: ${url.host}`,
          `Authorization: Bearer ${HUMAN_TOKEN}`,
          "Content-Type: application/json",
          "Content-Length: 100",
          "Connection: keep-alive",
          "",
          "{",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => finish());
    socket.on("close", () => finish());
    socket.on("error", (error) => finish(error));
  });
}

async function earlyRejectHalfBody(
  baseUrl: string,
  {
    path,
    token,
    method = "POST",
    origin,
    timeoutMs = 1_500,
  }: {
    path: string;
    token: string;
    method?: string;
    origin?: string;
    timeoutMs?: number;
  },
) {
  const url = new URL(baseUrl);
  return new Promise<string>((resolveResponse, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    let response = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error);
      else resolveResponse(response);
    };
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("Early reject did not close the connection"));
    }, timeoutMs);
    deadline.unref?.();
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(
        [
          `${method} ${path} HTTP/1.1`,
          `Host: ${url.host}`,
          `Authorization: Bearer ${token}`,
          ...(origin ? [`Origin: ${origin}`] : []),
          "Content-Type: application/json",
          "Content-Length: 100000000",
          "Connection: keep-alive",
          "",
          "{",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => finish());
    socket.once("close", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

async function abortPartialBody(baseUrl: string) {
  const url = new URL(baseUrl);
  await new Promise<void>((resolveAbort, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    const deadline = setTimeout(() => {
      socket.destroy();
      reject(new Error("Aborted request did not close"));
    }, 1_000);
    socket.once("connect", () => {
      const request = [
        "POST /accept HTTP/1.1",
        `Host: ${url.host}`,
        `Authorization: Bearer ${HUMAN_TOKEN}`,
        "Content-Type: application/json",
        "Content-Length: 100",
        "",
        "{",
      ].join("\r\n");
      socket.write(request, () => {
        setTimeout(() => socket.destroy(), 10);
      });
    });
    socket.once("close", () => {
      clearTimeout(deadline);
      resolveAbort();
    });
    socket.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
  });
}

async function withRemoteServer(
  run: (fixture: {
    baseUrl: string;
    logPath: string;
    server: SpawnedServer;
  }) => Promise<void>,
) {
  const scratch = await mkdtemp(join(tmpdir(), "agent-os-hub-runtime-"));
  const logPath = join(scratch, "events.jsonl");
  const server = spawnServer({
    PORT: "0",
    LOG_PATH: logPath,
    AGENT_OS_REMOTE_STATE_PATH: join(scratch, "remote-placement.json"),
    AGENT_OS_RUNNER_MODE: "remote",
    AGENT_OS_RUNNER_ID: HOST_ID,
    AGENT_OS_RUNNER_TOKEN: RUNNER_TOKEN,
    AGENT_OS_HUMAN_TOKEN: HUMAN_TOKEN,
    AGENT_OS_AGENT_TOKENS: JSON.stringify(AGENT_TOKENS),
  });

  try {
    await run({ baseUrl: await waitForReady(server), logPath, server });
  } finally {
    if (server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill("SIGKILL");
      await waitForExit(server);
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

describe("Hub runtime hardening", () => {
  it("raw half-body helper rejects a partial response that never closes", async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-length": "100" });
      response.write("{");
    });
    const baseUrl = await listenHttp(server);
    try {
      await expect(
        earlyRejectHalfBody(baseUrl, {
          path: "/partial",
          token: HUMAN_TOKEN,
          timeoutMs: 30,
        }),
      ).rejects.toThrow("Early reject did not close the connection");
    } finally {
      await closeHttp(server);
    }
  });

  it("Hub body reader 在 success / timeout / abort / error / CL fast reject 后清掉 timer 与 listeners", async () => {
    const observedListeners = ["data", "end", "aborted", "error"] as const;
    const listenerCounts = (request: PassThrough) =>
      Object.fromEntries(
        observedListeners.map((event) => [event, request.listenerCount(event)]),
      );
    const requestStream = (headers: Record<string, string> = {}) =>
      Object.assign(new PassThrough(), { headers });
    const streams: PassThrough[] = [];
    expect(typeof globalThis.clearTimeout).toBe("function");
    try {
      const success = requestStream();
      streams.push(success);
      const successListeners = listenerCounts(success);
      const successTimer = controlledTimeout();
      const successRead = readHubJsonBody(success, {
        timeoutMs: 25,
        timerApi: successTimer.api,
      });
      expect(successTimer.setTimer).toHaveBeenCalledWith(expect.any(Function), 25);
      success.end('{"ok":true}');
      await expect(successRead).resolves.toEqual({ ok: true });
      expect(listenerCounts(success)).toEqual(successListeners);
      expect(successTimer.clearTimer).toHaveBeenCalledWith(successTimer.handle);

      const timedOut = requestStream();
      streams.push(timedOut);
      const timeoutListeners = listenerCounts(timedOut);
      const timeoutTimer = controlledTimeout();
      const timeoutRead = readHubJsonBody(timedOut, {
        timeoutMs: 25,
        timerApi: timeoutTimer.api,
      }).catch((error: unknown) => error);
      timeoutTimer.fire();
      await expect(timeoutRead).resolves.toMatchObject({
        status: 408,
        message: "request body timed out",
        closeConnection: true,
      });
      expect(listenerCounts(timedOut)).toEqual(timeoutListeners);
      expect(timeoutTimer.clearTimer).toHaveBeenCalledWith(timeoutTimer.handle);

      for (const event of ["aborted", "error"] as const) {
        const interrupted = requestStream();
        streams.push(interrupted);
        const interruptedListeners = listenerCounts(interrupted);
        const interruptedTimer = controlledTimeout();
        const interruptedRead = readHubJsonBody(interrupted, {
          timeoutMs: 25,
          timerApi: interruptedTimer.api,
        }).catch((error: unknown) => error);
        if (event === "aborted") interrupted.emit(event);
        else interrupted.emit(event, new Error("raw request error must not escape"));
        await expect(interruptedRead).resolves.toMatchObject({
          status: 400,
          message: "request body unavailable",
        });
        expect(listenerCounts(interrupted)).toEqual(interruptedListeners);
        expect(interruptedTimer.clearTimer).toHaveBeenCalledWith(interruptedTimer.handle);
      }

      const tooLarge = requestStream({
        "content-length": String(HUB_REQUEST_BODY_LIMIT_BYTES + 1),
      });
      streams.push(tooLarge);
      const tooLargeListeners = listenerCounts(tooLarge);
      const resume = vi.spyOn(tooLarge, "resume");
      const tooLargeTimer = controlledTimeout();
      await expect(
        readHubJsonBody(tooLarge, {
          timeoutMs: 25,
          timerApi: tooLargeTimer.api,
        }),
      ).rejects.toMatchObject({
        status: 413,
        message: "request body too large",
        closeConnection: true,
      });
      expect(resume).toHaveBeenCalled();
      expect(listenerCounts(tooLarge)).toEqual(tooLargeListeners);
      expect(tooLargeTimer.clearTimer).toHaveBeenCalledWith(tooLargeTimer.handle);
    } finally {
      for (const stream of streams) stream.destroy();
      expect(typeof globalThis.clearTimeout).toBe("function");
    }
  });

  it("SSE admission 在饱和时不构建 replay、不注册 response，释放后恢复", () => {
    expect(MAX_SSE_CLIENTS).toBe(64);
    const intervals = controlledIntervals();
    const registry = createSseClientRegistry({
      maxClients: 1,
      maxBufferedBytes: 128,
      timerApi: intervals.api,
    });
    const first = new FakeSseResponse();
    const firstReplay = vi.fn(() => "data: first\n\n");
    expect(registry.admit(first, firstReplay)).toMatchObject({ accepted: true });
    expect(firstReplay).toHaveBeenCalledOnce();
    expect(registry.size).toBe(1);

    const saturated = new FakeSseResponse();
    const forbiddenReplay = vi.fn(() => "data: forbidden\n\n");
    expect(registry.admit(saturated, forbiddenReplay)).toEqual({
      accepted: false,
      reason: "capacity",
    });
    expect(forbiddenReplay).not.toHaveBeenCalled();
    expect(saturated.writeHead).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);

    first.emit("close");
    expect(registry.size).toBe(0);
    const recovered = new FakeSseResponse();
    expect(registry.admit(recovered, () => "data: recovered\n\n")).toMatchObject({
      accepted: true,
    });
    expect(registry.size).toBe(1);
    registry.closeAll();
  });

  it("SSE broadcast 与 ping 立即淘汰 backpressure/超缓冲客户端且不影响其他连接", () => {
    expect(MAX_SSE_BUFFER_BYTES).toBeGreaterThan(0);
    const intervals = controlledIntervals();
    const registry = createSseClientRegistry({
      maxClients: 3,
      maxBufferedBytes: 64,
      timerApi: intervals.api,
    });
    const slow = new FakeSseResponse();
    const buffered = new FakeSseResponse();
    const healthy = new FakeSseResponse();
    for (const response of [slow, buffered, healthy]) {
      expect(registry.admit(response, () => "data: hello\n\n")).toMatchObject({
        accepted: true,
      });
    }

    slow.acceptsWrites = false;
    buffered.writableLength = 60;
    registry.broadcast("data: update\n\n");
    expect(slow.destroyed).toBe(true);
    expect(buffered.destroyed).toBe(true);
    expect(healthy.destroyed).toBe(false);
    expect(healthy.writes).toContain("data: update\n\n");
    expect(registry.size).toBe(1);

    const pingBackpressured = new FakeSseResponse();
    expect(
      registry.admit(pingBackpressured, () => "data: ping-client\n\n"),
    ).toMatchObject({ accepted: true });
    pingBackpressured.acceptsWrites = false;
    intervals.fireAll();
    expect(pingBackpressured.destroyed).toBe(true);
    expect(healthy.destroyed).toBe(false);
    expect(registry.size).toBe(1);

    const replacementA = new FakeSseResponse();
    const replacementB = new FakeSseResponse();
    expect(registry.admit(replacementA, () => "data: a\n\n")).toMatchObject({
      accepted: true,
    });
    expect(registry.admit(replacementB, () => "data: b\n\n")).toMatchObject({
      accepted: true,
    });
    expect(registry.size).toBe(3);
    registry.closeAll();
  });

  it("SSE initial write 同步 close 不遗留 client 或 ping timer", () => {
    const intervals = controlledIntervals();
    const registry = createSseClientRegistry({
      maxClients: 1,
      maxBufferedBytes: 64,
      timerApi: intervals.api,
    });
    const response = new FakeSseResponse();
    response.write.mockImplementation((frame: string) => {
      response.writes.push(frame);
      response.emit("close");
      return true;
    });

    expect(registry.admit(response, () => "data: initial\n\n")).toEqual({
      accepted: true,
      closed: true,
    });
    expect(registry.size).toBe(0);
    expect(intervals.size).toBe(0);

    const recovered = new FakeSseResponse();
    expect(registry.admit(recovered, () => "data: recovered\n\n")).toMatchObject({
      accepted: true,
    });
    registry.closeAll();
  });

  it("propagates Runner close failure", async () => {
    const closeFailure = new Error("runner close fixture failure");
    const runner = {
      dispatch: vi.fn(),
      cancel: vi.fn(),
      health: vi.fn(() => ({ ready: true, hostId: "fixture", inflight: 0, queued: 0 })),
      hasSession: vi.fn(() => false),
      resetSession: vi.fn(),
      close: vi.fn(async () => {
        throw closeFailure;
      }),
    };
    const hub = new Hub({
      log: { replay: () => [] },
      projectId: "proj_runtime_close",
      broadcast: () => {},
      getAdapter: () => null,
      runner,
    });

    await expect(hub.close()).rejects.toBe(closeFailure);
    expect(runner.close).toHaveBeenCalledOnce();
  });

  it("marks stopping and stops HTTP accepts before closing the Runner", async () => {
    const order: string[] = [];
    const server = {
      close(callback: (error?: Error) => void) {
        order.push("server.close");
        queueMicrotask(() => callback());
      },
      closeIdleConnections() {
        order.push("server.closeIdleConnections");
      },
    };
    const lifecycle = createServerLifecycle({
      server,
      closeClients: () => order.push("clients.close"),
      closeRunner: () => {
        expect(lifecycle.stopping).toBe(true);
        order.push("runner.close");
      },
      timeoutMs: 100,
    });

    const shutdown = lifecycle.shutdown();
    expect(lifecycle.stopping).toBe(true);
    expect(lifecycle.shutdown()).toBe(shutdown);
    await shutdown;
    expect(order[0]).toBe("server.close");
    expect(order.indexOf("server.close")).toBeLessThan(order.indexOf("runner.close"));
  });

  it("turns a close rejection into a fixed sanitized lifecycle error", async () => {
    const secret = "secret-from-persistence-error";
    const lifecycle = createServerLifecycle({
      server: {
        close(callback: (error?: Error) => void) {
          queueMicrotask(() => callback());
        },
      },
      closeRunner: async () => {
        throw new Error(`persistence failed with ${secret}`);
      },
      timeoutMs: 100,
    });

    const failure = await lifecycle.shutdown().catch((error) => error);
    expect(failure).toBeInstanceOf(ShutdownError);
    expect(failure).toMatchObject({
      code: "close_failed",
      message: SHUTDOWN_FAILURE_MESSAGE,
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it("enforces one total shutdown deadline and force-closes HTTP connections", async () => {
    const closeAllConnections = vi.fn();
    const lifecycle = createServerLifecycle({
      server: {
        close() {},
        closeAllConnections,
      },
      closeRunner: () => new Promise(() => {}),
      timeoutMs: 20,
    });

    await expect(lifecycle.shutdown()).rejects.toMatchObject({
      code: "deadline_exceeded",
      message: SHUTDOWN_FAILURE_MESSAGE,
    });
    expect(closeAllConnections).toHaveBeenCalledOnce();
  });

  it("exits non-zero and logs no close-error secret when signal shutdown fails", async () => {
    const secret = "shutdown-fixture-secret-must-not-leak";
    const fixture = spawnNode(SHUTDOWN_FIXTURE, { SHUTDOWN_FIXTURE_SECRET: secret });
    try {
      await waitForOutput(fixture, "shutdown fixture ready");
      fixture.child.kill("SIGTERM");
      expect(await waitForExit(fixture)).toEqual({ code: 1, signal: null });
      expect(fixture.output.value).toContain(SHUTDOWN_FAILURE_MESSAGE);
      expect(fixture.output.value).not.toContain(secret);
    } finally {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
        fixture.child.kill("SIGKILL");
        await waitForExit(fixture);
      }
    }
  });

  it("exposes only inert liveness/readiness and keeps bad Worker auth offline", () =>
    withRemoteServer(async ({ baseUrl, logPath }) => {
      const before = await readFile(logPath, "utf8");
      const live = await fetch(`${baseUrl}/health/live`, {
        signal: AbortSignal.timeout(3_000),
      });
      expect(live.status).toBe(200);
      expect(live.headers.get("cache-control")).toBe("no-store");
      expect(await live.json()).toEqual({ status: "ok" });

      const ready = await fetch(`${baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(3_000),
      });
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: "not_ready" });
      for (const path of ["/health", "/healthz", "/health/live/", "/health/ready/"]) {
        const other = await fetch(`${baseUrl}${path}`, {
          signal: AbortSignal.timeout(3_000),
        });
        expect(other.status).toBe(401);
      }

      const wrongWorker = await authenticated(
        baseUrl,
        "/runner/v1/poll",
        WRONG_RUNNER_TOKEN,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            hostId: HOST_ID,
            acceptDispatch: true,
            acceptControl: true,
          }),
        },
      );
      expect(wrongWorker.status).toBe(401);
      const stillOffline = await fetch(`${baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(3_000),
      });
      expect(stillOffline.status).toBe(503);
      expect(await readFile(logPath, "utf8")).toBe(before);
    }));

  it("通用 early rejects 对半包统一 fail-and-close，SIGTERM 不再等待 keep-alive", () =>
    withRemoteServer(async ({ baseUrl, server }) => {
      const probes = [
        {
          request: { path: "/accept", token: WRONG_RUNNER_TOKEN },
          status: 401,
        },
        {
          request: {
            path: "/accept",
            token: HUMAN_TOKEN,
            origin: "https://forbidden.example",
          },
          status: 403,
        },
        {
          request: { path: "/accept", token: AGENT_TOKENS.codex },
          status: 403,
        },
        {
          request: { path: "/missing", token: HUMAN_TOKEN },
          status: 404,
        },
        {
          request: { path: "/say", token: HUMAN_TOKEN },
          status: 503,
        },
      ];
      for (const probe of probes) {
        const response = await earlyRejectHalfBody(baseUrl, probe.request);
        expect(response).toContain(` ${probe.status} `);
        expect(response.toLowerCase()).toContain("connection: close");
      }

      const bodylessSuccesses = [
        { path: "/", token: WRONG_RUNNER_TOKEN, method: "GET", status: 200 },
        {
          path: "/health/live",
          token: WRONG_RUNNER_TOKEN,
          method: "GET",
          status: 200,
        },
        {
          path: "/src/thread.mjs",
          token: HUMAN_TOKEN,
          method: "GET",
          status: 200,
        },
        {
          path: "/mcp/tools",
          token: AGENT_TOKENS.codex,
          method: "GET",
          status: 200,
        },
        {
          path: "/missing",
          token: HUMAN_TOKEN,
          method: "OPTIONS",
          status: 204,
        },
      ];
      for (const probe of bodylessSuccesses) {
        const response = await earlyRejectHalfBody(baseUrl, probe);
        expect(response).toContain(` ${probe.status} `);
        expect(response.toLowerCase()).toContain("connection: close");
      }

      const startedAt = Date.now();
      server.child.kill("SIGTERM");
      expect(await waitForExit(server)).toEqual({ code: 0, signal: null });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    }));

  it("caps SSE clients before replay and restores one released slot", () =>
    withRemoteServer(async ({ baseUrl, logPath }) => {
      const before = await readFile(logPath, "utf8");
      const clients: EventStreamClient[] = [];
      const maxSseClients = 64;
      try {
        clients.push(
          ...(await Promise.all(
            Array.from({ length: maxSseClients }, () => openEventStream(baseUrl)),
          )),
        );
        expect(clients.every(({ response }) => response.status === 200)).toBe(true);

        const saturated = await authenticated(baseUrl, "/events", HUMAN_TOKEN);
        expect(saturated.status).toBe(503);
        expect(saturated.headers.get("cache-control")).toBe("no-store");
        expect(saturated.headers.get("retry-after")).toBe("1");
        expect(saturated.headers.get("connection")).toBe("close");
        expect(await saturated.json()).toEqual({ error: "event stream unavailable" });

        const released = clients.shift();
        expect(released).toBeDefined();
        await closeEventStream(released as EventStreamClient);

        let recovered: EventStreamClient | undefined;
        const deadline = Date.now() + 1_000;
        while (!recovered && Date.now() < deadline) {
          const candidate = await openEventStream(baseUrl);
          if (candidate.response.status === 200) {
            recovered = candidate;
            break;
          }
          expect(candidate.response.status).toBe(503);
          expect(await candidate.response.json()).toEqual({
            error: "event stream unavailable",
          });
          await closeEventStream(candidate);
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
        expect(recovered?.response.status).toBe(200);
        clients.push(recovered as EventStreamClient);

        const fullAgain = await authenticated(baseUrl, "/events", HUMAN_TOKEN);
        expect(fullAgain.status).toBe(503);
        expect(await fullAgain.json()).toEqual({ error: "event stream unavailable" });
        expect(await readFile(logPath, "utf8")).toBe(before);
      } finally {
        await Promise.allSettled(clients.map((client) => closeEventStream(client)));
      }
    }));

  it("accepts the exact body boundary and rejects one byte over it", () =>
    withRemoteServer(async ({ baseUrl, logPath }) => {
      const before = await readFile(logPath, "utf8");
      const prefix = '{"padding":"';
      const suffix = '"}';
      const exact = `${prefix}${"x".repeat(1024 * 1024 - prefix.length - suffix.length)}${suffix}`;
      expect(Buffer.byteLength(exact)).toBe(1024 * 1024);

      const acceptedBoundary = await authenticated(baseUrl, "/accept", HUMAN_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: exact,
      });
      expect(acceptedBoundary.status).toBe(400);
      expect(await acceptedBoundary.text()).not.toContain("request body too large");

      const oversized = await authenticated(baseUrl, "/accept", HUMAN_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `${exact} `,
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toEqual({ error: "request body too large" });
      expect(await readFile(logPath, "utf8")).toBe(before);
    }));

  it("rejects malformed JSON with a fixed error and no mutation", () =>
    withRemoteServer(async ({ baseUrl, logPath }) => {
      const before = await readFile(logPath, "utf8");
      const malformed = await authenticated(baseUrl, "/accept", HUMAN_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: "invalid JSON request body" });
      expect(await readFile(logPath, "utf8")).toBe(before);
    }));

  it("times out an incomplete body with a fixed error", () =>
    withRemoteServer(async ({ baseUrl, logPath }) => {
      const before = await readFile(logPath, "utf8");
      const timedOut = await partialBodyRequest(baseUrl);
      expect(timedOut).toContain(" 408 ");
      expect(timedOut).toContain('{"error":"request body timed out"}');
      expect(await readFile(logPath, "utf8")).toBe(before);
    }));

  it("cleans up an aborted body and remains live", () =>
    withRemoteServer(async ({ baseUrl, logPath }) => {
      const before = await readFile(logPath, "utf8");
      await abortPartialBody(baseUrl);
      const afterAbort = await fetch(`${baseUrl}/health/live`, {
        signal: AbortSignal.timeout(3_000),
      });
      expect(afterAbort.status).toBe(200);
      expect(await readFile(logPath, "utf8")).toBe(before);
    }));

  it("handles SIGTERM with a clean, secret-free exit", () =>
    withRemoteServer(async ({ server }) => {
      server.child.kill("SIGTERM");
      expect(await waitForExit(server)).toEqual({ code: 0, signal: null });
      for (const secret of [HUMAN_TOKEN, RUNNER_TOKEN, ...Object.values(AGENT_TOKENS)]) {
        expect(server.output.value).not.toContain(secret);
      }
    }));

  it("non-interactive production local mode never prints its generated human bearer", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "agent-os-hub-local-log-"));
    const server = spawnServer({
      PORT: "0",
      LOG_PATH: join(scratch, "events.jsonl"),
      SESSION_PATH: join(scratch, "sessions.json"),
      AGENT_CWD: join(scratch, "workspace"),
      AGENT_OS_RUNNER_MODE: "local",
      NODE_ENV: "production",
    });
    try {
      await waitForReady(server);
      expect(server.output.value).not.toContain("human token →");
      server.child.kill("SIGTERM");
      expect(await waitForExit(server)).toEqual({ code: 0, signal: null });
      expect(server.output.value).not.toContain("human token →");
    } finally {
      if (server.child.exitCode === null && server.child.signalCode === null) {
        server.child.kill("SIGKILL");
        await waitForExit(server);
      }
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("generated human token logging requires local development and an interactive TTY", () => {
    const base = {
      runnerMode: "local",
      configuredHumanToken: undefined,
      nodeEnv: "development",
      isTty: true,
    };
    expect(shouldPrintGeneratedHumanToken(base)).toBe(true);
    expect(shouldPrintGeneratedHumanToken({ ...base, nodeEnv: "production" })).toBe(
      false,
    );
    expect(shouldPrintGeneratedHumanToken({ ...base, isTty: false })).toBe(false);
    expect(
      shouldPrintGeneratedHumanToken({
        ...base,
        configuredHumanToken: "configured-token",
      }),
    ).toBe(false);
    expect(shouldPrintGeneratedHumanToken({ ...base, runnerMode: "remote" })).toBe(false);
  });
});
