import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import { Adapter, SubprocessAdapter } from "../apps/chat-spike/src/adapters/base.mjs";
// @ts-expect-error
import {
  RUNNER_CANCEL_OUTCOMES,
  RUNNER_ERROR_CODES,
  RunnerDispatchError,
  runnerError,
  runnerLifecycleEvent,
} from "../apps/chat-spike/src/runners/contract.mjs";
// @ts-expect-error
import { LocalRunner } from "../apps/chat-spike/src/runners/local.mjs";
// @ts-expect-error
import {
  REMOTE_BODY_LIMIT_BYTES,
  REMOTE_BODY_TIMEOUT_MS,
  REMOTE_CACHED_PAYLOAD_LIMIT_BYTES,
  REMOTE_EVENT_LIMIT_BYTES,
  REMOTE_EXECUTION_PAYLOAD_LIMIT_BYTES,
  REMOTE_MAX_POLLERS,
  REMOTE_POLL_ENVELOPE_BYTES,
  REMOTE_POLL_RESPONSE_TIMEOUT_MS,
  REMOTE_POLL_TIMEOUT_MS,
  REMOTE_REQUEST_EVENT_LIMIT_BYTES,
  REMOTE_REQUEST_LIMIT_BYTES,
  RemoteAuthenticationError,
  RemotePlacementStore,
  RemoteRequestLedger,
  RemoteRunner,
  RemoteRunnerWorker,
  readRemoteJsonBody,
  readRemoteResponseBody,
  remotePollWorkBytes,
} from "../apps/chat-spike/src/runners/remote.mjs";
// @ts-expect-error
import { SessionStore } from "../apps/chat-spike/src/runners/session-store.mjs";
import {
  type RunnerContractHarness,
  type RunnerEvent,
  type RunnerRequest,
  defineRunnerContractSuite,
} from "./helpers/runner-contract-suite.js";

const TOKEN = "remote-runner-test-token-with-at-least-32-bytes";
const HOST = "remote-test-host";
const OTHER_HOST = "remote-other-host";
const FIXTURE = fileURLToPath(new URL("./fixtures/runner-cli.mjs", import.meta.url));
const cleanups: Array<() => void | Promise<void>> = [];

type FixtureLine = {
  type: "delta" | "progress" | "usage" | "result";
  text?: string;
  label?: string;
  input?: number;
  output?: number;
  total?: number;
  sessionId?: string;
};

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("测试 HTTP server 未监听 TCP");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function serve(remote: InstanceType<typeof RemoteRunner>) {
  const server = createServer(async (request, response) => {
    const handled = await remote.handleHttp(request, response);
    if (!handled) {
      response.writeHead(404);
      response.end();
    }
  });
  return { server, url: await listen(server) };
}

function makeRoot(prefix = "agentos-remote-runner-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workspaceRoot = join(root, "workspaces");
  mkdirSync(join(workspaceRoot, "project-a"), { recursive: true });
  return {
    root,
    workspaceRoot,
    sessionPath: join(root, "state", "sessions.json"),
    placementPath: join(root, "state", "placements.json"),
  };
}

function placementStore(environment: ReturnType<typeof makeRoot>) {
  return new RemotePlacementStore({ filePath: environment.placementPath });
}

function inertRunner() {
  return {
    dispatch: async () => {
      throw new Error("not used");
    },
    cancel: async (requestId: string) => ({ requestId, outcome: "not_found" }),
    resetSession: async () => {},
    close: async () => {},
  };
}

async function postJson(url: string, path: string, body: unknown, token = TOKEN) {
  return fetch(`${url}/runner/v1${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function rawRequest(url: string, request: string, timeoutMs = 2_000) {
  const target = new URL(url);
  return new Promise<string>((resolveResponse, reject) => {
    const socket = createConnection({
      host: target.hostname,
      port: Number(target.port),
    });
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
      reject(new Error("等待 Runner transport 连接关闭超时"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => finish());
    socket.once("close", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

function controlledOneShotTimer() {
  const handle = Object.freeze({ timer: "controlled-request" });
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

function recordingTimers() {
  const scheduled: Array<{ handle: object; ms: number }> = [];
  const clearTimeout = vi.fn();
  return {
    api: {
      setTimeout(_callback: () => void, ms: number) {
        const handle = Object.freeze({ timer: scheduled.length + 1 });
        scheduled.push({ handle, ms });
        return handle;
      },
      clearTimeout,
    },
    clearTimeout,
    scheduled,
  };
}

async function abortRawRequest(url: string, request: string) {
  const target = new URL(url);
  await new Promise<void>((resolveAbort, reject) => {
    const socket = createConnection({
      host: target.hostname,
      port: Number(target.port),
    });
    const deadline = setTimeout(() => {
      socket.destroy();
      reject(new Error("Runner transport abort 未完成"));
    }, 1_000);
    socket.once("connect", () => {
      socket.write(request, () => setTimeout(() => socket.destroy(), 10));
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

function pollHeaders(url: string, extra: string[] = []) {
  const target = new URL(url);
  return [
    "POST /runner/v1/poll HTTP/1.1",
    `Host: ${target.host}`,
    `Authorization: Bearer ${TOKEN}`,
    "Content-Type: application/json",
    ...extra,
    "",
  ];
}

async function bodyTransport() {
  const environment = makeRoot();
  const remote = new RemoteRunner({
    token: TOKEN,
    hostId: HOST,
    placementStore: placementStore(environment),
    pollTimeoutMs: 20,
  });
  const served = await serve(remote);
  cleanups.push(async () => {
    await remote.close();
    await closeServer(served.server);
    rmSync(environment.root, { recursive: true, force: true });
  });
  return { ...served, remote };
}

function baseRequest(overrides: Partial<RunnerRequest> = {}): RunnerRequest {
  return {
    requestId: "remote-default",
    user: "user-1",
    project: "project-1",
    agent: "agent-1",
    adapter: "contract",
    workspace: "project-a",
    prompt: "normal",
    taskId: "TASK-REMOTE",
    causedBy: "evt_remote",
    ...overrides,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("等待 Remote Runner 状态超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function contractAdapterFixture() {
  let executions = 0;
  let cancellations = 0;
  let blockedStartedResolve: () => void = () => {};
  const blockedStarted = new Promise<void>((resolve) => {
    blockedStartedResolve = resolve;
  });
  let blockedReleaseResolve: () => void = () => {};
  const blockedRelease = new Promise<void>((resolve) => {
    blockedReleaseResolve = resolve;
  });

  class ContractAdapter extends Adapter {
    static id = "contract";
    static label = "Remote contract fixture";
    static capabilities = {
      streaming: true,
      thoughts: true,
      session: true,
      usage: true,
    };

    async send(prompt: string, { signal }: { signal?: AbortSignal } = {}) {
      executions++;
      const fresh = !this.hasSession;
      if (prompt === "block") {
        blockedStartedResolve();
        await Promise.race([
          blockedRelease,
          new Promise<never>((_resolve, reject) => {
            const abort = () => {
              cancellations++;
              reject(signal?.reason ?? new Error("remote contract cancelled"));
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          }),
        ]);
      }
      if (prompt === "fail") throw new Error("contract adapter failure");
      if (prompt === "timeout" || prompt === "unavailable") {
        const code =
          prompt === "timeout"
            ? RUNNER_ERROR_CODES.TIMEOUT
            : RUNNER_ERROR_CODES.UNAVAILABLE;
        throw new RunnerDispatchError(
          runnerError({
            requestId: "unknown",
            code,
            message: `contract ${prompt}`,
            retryable: true,
          }),
        );
      }
      if (prompt === "invalid-result") {
        return { text: "invalid", sessionId: null, ms: Number.NaN, fresh };
      }
      if (prompt === "events") {
        this.onEvent({ kind: "delta", text: "answer chunk", vendorOnly: true });
        this.onEvent({ kind: "thought", text: "reasoning chunk", vendorOnly: true });
        this.onEvent({ kind: "vendor.phase", label: "vendor stage", vendorOnly: true });
        this.onEvent({
          kind: "usage",
          input: 3,
          output: 5,
          total: 8,
          costUsd: -1,
          vendorOnly: true,
        });
      }
      this._sessionId ??= "contract-session";
      return {
        text: "contract-result",
        sessionId: this._sessionId,
        ms: 7,
        fresh,
        vendorOnly: "must be removed",
      };
    }

    async cancel() {
      blockedReleaseResolve();
    }

    async close() {
      blockedReleaseResolve();
    }
  }

  return {
    AdapterClass: ContractAdapter,
    executionCount: () => executions,
    cancellationCount: () => cancellations,
    waitForBlockedExecution: () => blockedStarted,
    releaseBlockedExecution: () => blockedReleaseResolve(),
  };
}

defineRunnerContractSuite("RemoteRunner", async () => {
  const environment = makeRoot("agentos-remote-contract-");
  const fixture = contractAdapterFixture();
  const makeLocal = () =>
    new LocalRunner({
      workspaceRoot: environment.workspaceRoot,
      sessionStore: new SessionStore(environment.sessionPath),
      getAdapter: (id: string) => (id === "contract" ? fixture.AdapterClass : null),
      hostId: HOST,
    });
  const makeRemote = () =>
    new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 30,
      leaseMs: 100,
      livenessTimeoutMs: 100,
      closeGraceMs: 500,
    });
  let local = makeLocal();
  let remote = makeRemote();
  const server = createServer(async (request, response) => {
    const handled = await remote.handleHttp(request, response);
    if (!handled) {
      response.writeHead(404);
      response.end();
    }
  });
  const url = await listen(server);
  const startWorker = () =>
    new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: local,
      reconnectDelayMs: 5,
    }).start();
  let worker = startWorker();
  await waitFor(() => remote.health().ready);

  const harness: RunnerContractHarness = {
    runner: remote,
    request: baseRequest,
    executionCount: fixture.executionCount,
    waitForBlockedExecution: fixture.waitForBlockedExecution,
    releaseBlockedExecution: fixture.releaseBlockedExecution,
    cancellationCount: fixture.cancellationCount,
    hostId: HOST,
    restartRunner: async () => {
      await worker.stop();
      await remote.close();
      local = makeLocal();
      remote = makeRemote();
      harness.runner = remote;
      worker = startWorker();
      await waitFor(() => remote.health().ready);
    },
    dispose: async () => {
      fixture.releaseBlockedExecution();
      await worker.stop();
      await remote.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    },
  };
  return harness;
});

class CliFixtureAdapter extends SubprocessAdapter {
  static id = "fixture";
  static label = "Remote CLI fixture";
  static capabilities = {
    streaming: true,
    thoughts: false,
    session: true,
    usage: true,
  };

  buildCommand(prompt: string, resume: string | null) {
    return { cmd: process.execPath, args: [FIXTURE, prompt, resume ?? ""] };
  }

  handleLine(line: FixtureLine) {
    if (line.type === "delta") {
      this.onEvent({ kind: "delta", text: line.text });
      return undefined;
    }
    if (line.type === "progress") {
      this.onEvent({ kind: "progress", label: line.label });
      return undefined;
    }
    if (line.type === "usage") {
      this.onEvent({
        kind: "usage",
        input: line.input,
        output: line.output,
        total: line.total,
      });
      return undefined;
    }
    return { text: line.text, sessionId: line.sessionId };
  }
}

function makeCliRunner(environment: ReturnType<typeof makeRoot>, sessionPath: string) {
  return new LocalRunner({
    workspaceRoot: environment.workspaceRoot,
    sessionStore: new SessionStore(sessionPath),
    getAdapter: (id: string) => (id === "fixture" ? CliFixtureAdapter : null),
    hostId: HOST,
  });
}

function cliRequest(requestId: string, prompt: string) {
  return {
    ...baseRequest({ requestId, prompt, adapter: "fixture" }),
  };
}

function comparableEvent(event: RunnerEvent) {
  if (event.kind === "completed") {
    return {
      kind: event.kind,
      result: {
        text: event.result?.text,
        sessionId: event.result?.sessionId,
        fresh: event.result?.fresh,
      },
    };
  }
  return {
    kind: event.kind,
    ...(event.text === undefined ? {} : { text: event.text }),
    ...(event.label === undefined ? {} : { label: event.label }),
    ...(event.fresh === undefined ? {} : { fresh: event.fresh }),
    ...(event.input === undefined ? {} : { input: event.input }),
    ...(event.output === undefined ? {} : { output: event.output }),
    ...(event.total === undefined ? {} : { total: event.total }),
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Remote Runner transport body boundary", () => {
  const observedListeners = ["data", "end", "aborted", "error"] as const;
  const listenerCounts = (request: PassThrough) =>
    Object.fromEntries(
      observedListeners.map((event) => [event, request.listenerCount(event)]),
    );
  const requestStream = (headers: Record<string, string> = {}) =>
    Object.assign(new PassThrough(), { headers });
  const controlledTimer = () => {
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
  };

  it("raw request helper rejects a partial response that never closes", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-length": "100" });
      response.write("{");
    });
    const url = await listen(server);
    try {
      await expect(
        rawRequest(
          url,
          ["GET /partial HTTP/1.1", `Host: ${new URL(url).host}`, "", ""].join("\r\n"),
          30,
        ),
      ).rejects.toThrow("等待 Runner transport 连接关闭超时");
    } finally {
      await closeServer(server);
    }
  });

  it("reader 在 success / timeout / abort / error / fast reject 后清掉 timer 与 listeners", async () => {
    expect(typeof globalThis.clearTimeout).toBe("function");
    const streams: PassThrough[] = [];
    try {
      const success = requestStream();
      streams.push(success);
      const successListeners = listenerCounts(success);
      const successTimer = controlledTimer();
      const successRead = readRemoteJsonBody(success, {
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
      const timeoutTimer = controlledTimer();
      const timeoutRead = readRemoteJsonBody(timedOut, {
        timeoutMs: 25,
        timerApi: timeoutTimer.api,
      });
      const timeoutFailure = timeoutRead.catch((error: unknown) => error);
      timeoutTimer.fire();
      await expect(timeoutFailure).resolves.toMatchObject({
        status: 408,
        code: "request_timeout",
        message: "请求体读取超时",
      });
      expect(listenerCounts(timedOut)).toEqual(timeoutListeners);
      expect(timeoutTimer.clearTimer).toHaveBeenCalledWith(timeoutTimer.handle);

      for (const event of ["aborted", "error"] as const) {
        const interrupted = requestStream();
        streams.push(interrupted);
        const interruptedListeners = listenerCounts(interrupted);
        const interruptedTimer = controlledTimer();
        const interruptedRead = readRemoteJsonBody(interrupted, {
          timeoutMs: 25,
          timerApi: interruptedTimer.api,
        });
        const interruptedFailure = interruptedRead.catch((error: unknown) => error);
        if (event === "aborted") interrupted.emit(event);
        else interrupted.emit(event, new Error("raw stream secret must not escape"));
        await expect(interruptedFailure).resolves.toMatchObject({
          status: 400,
          message: "请求体不可用",
        });
        expect(listenerCounts(interrupted)).toEqual(interruptedListeners);
        expect(interruptedTimer.clearTimer).toHaveBeenCalledWith(interruptedTimer.handle);
      }

      const tooLarge = requestStream({
        "content-length": String(REMOTE_BODY_LIMIT_BYTES + 1),
      });
      streams.push(tooLarge);
      const tooLargeListeners = listenerCounts(tooLarge);
      const resume = vi.spyOn(tooLarge, "resume");
      const tooLargeTimer = controlledTimer();
      await expect(
        readRemoteJsonBody(tooLarge, {
          timeoutMs: 25,
          timerApi: tooLargeTimer.api,
        }),
      ).rejects.toMatchObject({
        status: 413,
        code: "payload_too_large",
        message: "请求体过大",
      });
      expect(resume).toHaveBeenCalled();
      expect(listenerCounts(tooLarge)).toEqual(tooLargeListeners);
      expect(tooLargeTimer.clearTimer).toHaveBeenCalledWith(tooLargeTimer.handle);
    } finally {
      for (const stream of streams) stream.destroy();
      expect(typeof globalThis.clearTimeout).toBe("function");
    }
  });

  it("真实 poll 精确允许 1MiB，CL +1 与 chunked 累计超限均 413 并关闭", async () => {
    const { url } = await bodyTransport();
    const poll = JSON.stringify({
      hostId: HOST,
      acceptDispatch: true,
      acceptControl: true,
    });
    const exact = `${poll}${" ".repeat(REMOTE_BODY_LIMIT_BYTES - Buffer.byteLength(poll))}`;
    expect(Buffer.byteLength(exact)).toBe(REMOTE_BODY_LIMIT_BYTES);

    const accepted = await fetch(`${url}/runner/v1/poll`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: exact,
      signal: AbortSignal.timeout(2_000),
    });
    expect(accepted.status).toBe(204);

    const fastCl = await rawRequest(
      url,
      [...pollHeaders(url, [`Content-Length: ${REMOTE_BODY_LIMIT_BYTES + 1}`]), ""].join(
        "\r\n",
      ),
      1_000,
    );
    expect(fastCl).toContain(" 413 ");
    expect(fastCl).toContain('"error":"payload_too_large"');
    expect(fastCl).toContain('"message":"请求体过大"');
    expect(fastCl.toLowerCase()).toContain("connection: close");

    const chunk = "x".repeat(REMOTE_BODY_LIMIT_BYTES + 1);
    const chunked = await rawRequest(
      url,
      [
        ...pollHeaders(url, ["Transfer-Encoding: chunked"]),
        `${chunk.length.toString(16)}\r\n${chunk}\r\n0\r\n\r\n`,
      ].join("\r\n"),
    );
    expect(chunked).toContain(" 413 ");
    expect(chunked).toContain('"error":"payload_too_large"');
    expect(chunked.toLowerCase()).toContain("connection: close");
  });

  it("dispatch work 按真实 JSON envelope 精确允许 1MiB，+1 在入队前拒绝", async () => {
    const environment = makeRoot("agentos-remote-poll-envelope-");
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 50,
    });
    const { server, url } = await serve(remote);
    const worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: inertRunner(),
    });
    cleanups.push(async () => {
      await worker.stop();
      await remote.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });
    const sizedRequest = (requestId: string, targetBytes: number) => {
      const request = baseRequest({ requestId, prompt: "" });
      const baseBytes = Buffer.byteLength(JSON.stringify(request));
      return { ...request, prompt: "x".repeat(targetBytes - baseBytes) };
    };
    const oversized = sizedRequest("poll-envelope-b", REMOTE_REQUEST_LIMIT_BYTES + 1);
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBe(
      REMOTE_REQUEST_LIMIT_BYTES + 1,
    );
    await expect(remote.dispatch(oversized)).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.INVALID_REQUEST, retryable: false },
    });

    const request = sizedRequest("poll-envelope-a", REMOTE_REQUEST_LIMIT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(request))).toBe(REMOTE_REQUEST_LIMIT_BYTES);
    const dispatch = remote.dispatch(request);
    void dispatch.catch(() => {});
    remote.requests.get(request.requestId).delivery = Number.MAX_SAFE_INTEGER - 1;
    const work = await worker.poll(new AbortController().signal);
    expect(work).toMatchObject({ kind: "dispatch", request });
    expect(remotePollWorkBytes(work)).toBe(REMOTE_BODY_LIMIT_BYTES);
    remote.releaseClaim(work);
  });

  it("reset-session work 按真实 JSON envelope 精确允许 1MiB，+1 在入队前拒绝", async () => {
    const environment = makeRoot("agentos-remote-reset-envelope-");
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 50,
    });
    cleanups.push(async () => {
      await remote.close();
      rmSync(environment.root, { recursive: true, force: true });
    });
    const workFor = (agent: string) => ({
      kind: "reset-session",
      controlId: "00000000-0000-4000-8000-000000000000",
      scope: { user: "u", project: "p", agent },
      delivery: Number.MAX_SAFE_INTEGER,
      leaseId: "00000000-0000-4000-8000-000000000000",
    });
    const emptyBytes = remotePollWorkBytes(workFor(""));
    const exactScope = {
      user: "u",
      project: "p",
      agent: "x".repeat(REMOTE_BODY_LIMIT_BYTES - emptyBytes),
    };
    expect(remotePollWorkBytes(workFor(exactScope.agent))).toBe(REMOTE_BODY_LIMIT_BYTES);

    const reset = remote.resetSession(exactScope);
    void reset.catch(() => {});
    const control = [...remote.controls.values()][0];
    control.delivery = Number.MAX_SAFE_INTEGER - 1;
    const work = remote.claim(HOST, { acceptDispatch: false, acceptControl: true });
    expect(work).toMatchObject({ kind: "reset-session", scope: exactScope });
    expect(remotePollWorkBytes(work)).toBe(REMOTE_BODY_LIMIT_BYTES);
    remote.releaseClaim(work);
    clearTimeout(control.timeout);
    remote.controls.delete(control.controlId);
    control.deferred.resolve();
    await expect(reset).resolves.toBeUndefined();

    await expect(
      remote.resetSession({ ...exactScope, agent: `${exactScope.agent}x` }),
    ).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.INVALID_REQUEST, retryable: false },
    });
    expect(remote.controls.size).toBe(0);
  });

  it("cancel work 按真实 JSON envelope 精确允许 1MiB，+1 在入队前拒绝", async () => {
    const environment = makeRoot("agentos-remote-cancel-envelope-");
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 50,
    });
    cleanups.push(async () => {
      await remote.close();
      rmSync(environment.root, { recursive: true, force: true });
    });
    const workFor = (requestId: string) => ({
      kind: "cancel",
      controlId: "00000000-0000-4000-8000-000000000000",
      requestId,
      delivery: Number.MAX_SAFE_INTEGER,
      leaseId: "00000000-0000-4000-8000-000000000000",
    });
    const emptyBytes = remotePollWorkBytes(workFor(""));
    const exactRequestId = "x".repeat(REMOTE_BODY_LIMIT_BYTES - emptyBytes);
    expect(remotePollWorkBytes(workFor(exactRequestId))).toBe(REMOTE_BODY_LIMIT_BYTES);

    const exactRecord = {
      state: "inflight",
      terminal: false,
      assignedHostId: HOST,
      cancelOperation: null,
    };
    remote.requests.set(exactRequestId, exactRecord);
    const cancellation = remote.cancel(exactRequestId);
    void cancellation.catch(() => {});
    const control = [...remote.controls.values()][0];
    control.delivery = Number.MAX_SAFE_INTEGER - 1;
    const work = remote.claim(HOST, { acceptDispatch: false, acceptControl: true });
    expect(work).toMatchObject({ kind: "cancel", requestId: exactRequestId });
    expect(remotePollWorkBytes(work)).toBe(REMOTE_BODY_LIMIT_BYTES);
    remote.releaseClaim(work);
    clearTimeout(control.timeout);
    remote.controls.delete(control.controlId);
    remote.requests.delete(exactRequestId);
    control.deferred.resolve({
      requestId: exactRequestId,
      outcome: RUNNER_CANCEL_OUTCOMES.CANCELLED,
    });
    await expect(cancellation).resolves.toMatchObject({
      requestId: exactRequestId,
      outcome: RUNNER_CANCEL_OUTCOMES.CANCELLED,
    });

    const oversizedRequestId = `${exactRequestId}x`;
    const oversizedRecord = {
      state: "inflight",
      terminal: false,
      assignedHostId: HOST,
      cancelOperation: null,
    };
    remote.requests.set(oversizedRequestId, oversizedRecord);
    await expect(remote.cancel(oversizedRequestId)).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.INVALID_REQUEST, retryable: false },
    });
    remote.requests.delete(oversizedRequestId);
    expect(remote.controls.size).toBe(0);
  });

  it("真实 poll 半包在绝对 3s 后固定 408 并关闭", async () => {
    const { url } = await bodyTransport();
    const response = await rawRequest(
      url,
      [...pollHeaders(url, ["Content-Length: 100"]), "{"].join("\r\n"),
      4_500,
    );
    expect(response).toContain(" 408 ");
    expect(response).toContain('"error":"request_timeout"');
    expect(response).toContain('"message":"请求体读取超时"');
    expect(response.toLowerCase()).toContain("connection: close");
  });

  it("真实 poll abort 清理后仍可接受下一次 authenticated poll", async () => {
    const { url } = await bodyTransport();
    await abortRawRequest(
      url,
      [...pollHeaders(url, ["Content-Length: 100"]), "{"].join("\r\n"),
    );
    const next = await postJson(url, "/poll", {
      hostId: HOST,
      acceptDispatch: true,
      acceptControl: true,
    });
    expect(next.status).toBe(204);
  });

  it("unauthorized 与 wrong-method 半包立即 fail-and-close，且不拖住 shutdown", async () => {
    const { url, remote, server } = await bodyTransport();
    const unauthorized = await rawRequest(
      url,
      [
        "POST /runner/v1/poll HTTP/1.1",
        `Host: ${new URL(url).host}`,
        "Authorization: Bearer wrong-runner-token-with-at-least-32-bytes",
        "Content-Type: application/json",
        "Content-Length: 100",
        "",
        "{",
      ].join("\r\n"),
      1_000,
    );
    expect(unauthorized).toContain(" 401 ");
    expect(unauthorized.toLowerCase()).toContain("connection: close");

    const wrongMethod = await rawRequest(
      url,
      [
        "PUT /runner/v1/poll HTTP/1.1",
        `Host: ${new URL(url).host}`,
        `Authorization: Bearer ${TOKEN}`,
        "Content-Type: application/json",
        "Content-Length: 100",
        "",
        "{",
      ].join("\r\n"),
      1_000,
    );
    expect(wrongMethod).toContain(" 405 ");
    expect(wrongMethod.toLowerCase()).toContain("connection: close");

    const openConnections = await new Promise<number>((resolveConnections, reject) => {
      server.getConnections((error, count) => {
        if (error) reject(error);
        else resolveConnections(count);
      });
    });
    expect(openConnections).toBe(0);
    await remote.close();
    await closeServer(server);
  });

  it("authenticated long poll 有硬上限，超额 429+close，释放后恢复 admission", async () => {
    expect(REMOTE_MAX_POLLERS).toBe(16);
    const environment = makeRoot("agentos-remote-poller-cap-");
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 1_000,
      maxPollers: 1,
    });
    expect(
      () =>
        new RemoteRunner({
          token: TOKEN,
          hostId: HOST,
          placementStore: placementStore(environment),
          maxPollers: REMOTE_MAX_POLLERS + 1,
        }),
    ).toThrow(/maxPollers 不得超过 staging hard limit/);
    const { server, url } = await serve(remote);
    cleanups.push(async () => {
      await remote.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });
    const body = {
      hostId: HOST,
      acceptDispatch: true,
      acceptControl: true,
    };
    const firstController = new AbortController();
    const first = fetch(`${url}/runner/v1/poll`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: firstController.signal,
    });
    void first.catch(() => {});
    await waitFor(() => remote.pollers.size === 1);

    const saturated = await postJson(url, "/poll", body);
    expect(saturated.status).toBe(429);
    expect(saturated.headers.get("connection")).toBe("close");
    expect(await saturated.json()).toEqual({
      error: "poll_capacity",
      message: "Remote Runner poll capacity 已满",
    });
    expect(remote.pollers.size).toBe(1);

    firstController.abort();
    await first.catch(() => {});
    await waitFor(() => remote.pollers.size === 0);

    const recoveredController = new AbortController();
    const recovered = fetch(`${url}/runner/v1/poll`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: recoveredController.signal,
    });
    void recovered.catch(() => {});
    await waitFor(() => remote.pollers.size === 1);
    recoveredController.abort();
    await recovered.catch(() => {});
    await waitFor(() => remote.pollers.size === 0);
  });
});

describe("Remote Runner Worker response boundary", () => {
  const makeWorker = (overrides: Record<string, unknown> = {}) =>
    new RemoteRunnerWorker({
      url: "http://127.0.0.1:1",
      token: TOKEN,
      hostId: HOST,
      runner: inertRunner(),
      requestTimeoutMs: 25,
      maxResponseBytes: 64,
      ...overrides,
    });

  it("完整响应读取沿用一个 absolute timer，并清理 caller listener/controller", async () => {
    expect(REMOTE_BODY_TIMEOUT_MS).toBe(3_000);
    expect(typeof globalThis.clearTimeout).toBe("function");
    const timers = controlledOneShotTimer();
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, "addEventListener");
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const prefix = '{"value":"';
    const suffix = '"}';
    const exact = `${prefix}${"x".repeat(64 - prefix.length - suffix.length)}${suffix}`;
    expect(Buffer.byteLength(exact)).toBe(64);
    const worker = makeWorker({
      requestTimerApi: timers.api,
      fetchImpl: async () => new Response(exact, { status: 200 }),
    });

    await expect(worker.fetchOnce("/ack", {}, caller.signal)).resolves.toEqual({
      status: 200,
      body: { value: "x".repeat(64 - prefix.length - suffix.length) },
    });
    expect(timers.setTimer).toHaveBeenCalledWith(expect.any(Function), 25);
    expect(timers.clearTimer).toHaveBeenCalledWith(timers.handle);
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(worker.requestControllers.size).toBe(0);
    expect(typeof globalThis.clearTimeout).toBe("function");
    await worker.stop();
  });

  it("streaming 与 Content-Length oversize 均固定拒绝并 cancel body", async () => {
    for (const contentLength of [undefined, "65"] as const) {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (contentLength === undefined) {
            controller.enqueue(new TextEncoder().encode("x".repeat(65)));
          }
        },
        cancel,
      });
      const timers = controlledOneShotTimer();
      const worker = makeWorker({
        requestTimerApi: timers.api,
        fetchImpl: async () =>
          new Response(body, {
            status: 200,
            ...(contentLength ? { headers: { "content-length": contentLength } } : {}),
          }),
      });
      await expect(
        worker.fetchOnce("/ack", {}, new AbortController().signal),
      ).rejects.toMatchObject({
        code: "response_too_large",
        message: "Hub 响应体超出限制",
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(timers.clearTimer).toHaveBeenCalledWith(timers.handle);
      expect(worker.requestControllers.size).toBe(0);
      await worker.stop();
    }
    await expect(
      readRemoteResponseBody(new Response("{}"), {
        maxBytes: REMOTE_BODY_LIMIT_BYTES + 1,
      }),
    ).rejects.toThrow(/staging hard limit/);
  });

  it("headers 后 stalled body 由 absolute deadline 固定中断且完整清理", async () => {
    const timers = controlledOneShotTimer();
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, "addEventListener");
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    let headersReady: () => void = () => {};
    const headers = new Promise<void>((resolveHeaders) => {
      headersReady = resolveHeaders;
    });
    const worker = makeWorker({
      requestTimerApi: timers.api,
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new Error("untrusted stalled body detail")),
              { once: true },
            );
          },
        });
        headersReady();
        return new Response(body, { status: 200 });
      },
    });
    const pending = worker.fetchOnce("/ack", {}, caller.signal);
    await headers;
    timers.fire();
    await expect(pending).rejects.toThrow("Hub 响应读取超时");
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(timers.clearTimer).toHaveBeenCalledWith(timers.handle);
    expect(worker.requestControllers.size).toBe(0);
    await worker.stop();
  });

  it("Worker.stop 可立即 abort headers 已到的 stalled body，不回传 stream error", async () => {
    const timers = controlledOneShotTimer();
    let headersReady: () => void = () => {};
    const headers = new Promise<void>((resolveHeaders) => {
      headersReady = resolveHeaders;
    });
    const worker = makeWorker({
      requestTimerApi: timers.api,
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new Error("response stream secret")),
              { once: true },
            );
          },
        });
        headersReady();
        return new Response(body, { status: 200 });
      },
    });
    const pending = worker.fetchOnce("/ack", {}, new AbortController().signal);
    await headers;
    const startedAt = Date.now();
    await worker.stop();
    expect(Date.now() - startedAt).toBeLessThan(100);
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: "Remote Runner request aborted" });
    expect(JSON.stringify(failure)).not.toContain("response stream secret");
    expect(timers.clearTimer).toHaveBeenCalledWith(timers.handle);
    expect(worker.requestControllers.size).toBe(0);
  });

  it("401/5xx cancel unread body；other 4xx bounded-consume 且仅保留固定错误", async () => {
    for (const status of [401, 503]) {
      const cancel = vi.fn();
      const timers = controlledOneShotTimer();
      const worker = makeWorker({
        requestTimerApi: timers.api,
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("secret response body"));
              },
              cancel,
            }),
            { status },
          ),
      });
      const failure = await worker
        .fetchOnce("/ack", {}, new AbortController().signal)
        .catch((error: unknown) => error);
      expect(cancel).toHaveBeenCalledOnce();
      expect(JSON.stringify(failure)).not.toContain("secret response body");
      if (status === 401) expect(failure).toBeInstanceOf(RemoteAuthenticationError);
      else expect(failure).toMatchObject({ message: "Hub 暂时不可用" });
      expect(timers.clearTimer).toHaveBeenCalledWith(timers.handle);
      expect(worker.requestControllers.size).toBe(0);
      await worker.stop();
    }

    const cancel = vi.fn();
    const timers = controlledOneShotTimer();
    const worker = makeWorker({
      requestTimerApi: timers.api,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    error: "stale_delivery",
                    message: "secret protocol detail",
                  }),
                ),
              );
              controller.close();
            },
            cancel,
          }),
          { status: 409 },
        ),
    });
    const failure = await worker
      .fetchOnce("/ack", {}, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      status: 409,
      code: "stale_delivery",
      message: "Hub 拒绝了 Remote Runner 请求",
    });
    expect(JSON.stringify(failure)).not.toContain("secret protocol detail");
    expect(cancel).not.toHaveBeenCalled();
    expect(timers.clearTimer).toHaveBeenCalledWith(timers.handle);
    expect(worker.requestControllers.size).toBe(0);
    await worker.stop();
  });

  it("默认 long-poll 总 deadline 覆盖 Hub 25s wait，headers 后另有 3s body deadline", async () => {
    const timers = recordingTimers();
    const worker = new RemoteRunnerWorker({
      url: "http://127.0.0.1:1",
      token: TOKEN,
      hostId: HOST,
      runner: inertRunner(),
      requestTimerApi: timers.api,
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    await expect(
      worker.fetchOnce("/poll", {}, new AbortController().signal),
    ).resolves.toEqual({ status: 200, body: {} });
    expect(REMOTE_POLL_TIMEOUT_MS).toBe(25_000);
    expect(REMOTE_POLL_RESPONSE_TIMEOUT_MS).toBeGreaterThan(REMOTE_POLL_TIMEOUT_MS);
    expect(timers.scheduled.map(({ ms }) => ms)).toEqual([
      REMOTE_POLL_RESPONSE_TIMEOUT_MS,
      REMOTE_BODY_TIMEOUT_MS,
    ]);
    for (const { handle } of timers.scheduled) {
      expect(timers.clearTimeout).toHaveBeenCalledWith(handle);
    }
    expect(worker.requestControllers.size).toBe(0);
    await worker.stop();
  });

  it("response timeout/body 配置只允许向下收紧", () => {
    expect(REMOTE_REQUEST_LIMIT_BYTES).toBe(
      REMOTE_BODY_LIMIT_BYTES - REMOTE_POLL_ENVELOPE_BYTES,
    );
    expect(REMOTE_EXECUTION_PAYLOAD_LIMIT_BYTES).toBeGreaterThan(
      REMOTE_REQUEST_LIMIT_BYTES,
    );
    expect(() => makeWorker({ requestTimeoutMs: REMOTE_BODY_TIMEOUT_MS + 1 })).toThrow(
      /requestTimeoutMs 不得超过 staging hard limit/,
    );
    expect(() => makeWorker({ maxResponseBytes: REMOTE_BODY_LIMIT_BYTES + 1 })).toThrow(
      /maxResponseBytes 不得超过 staging hard limit/,
    );
    expect(() =>
      makeWorker({
        pollResponseTimeoutMs: REMOTE_POLL_RESPONSE_TIMEOUT_MS + 1,
      }),
    ).toThrow(/pollResponseTimeoutMs 不得超过 staging hard limit/);
    expect(() => makeWorker({ pollResponseTimeoutMs: 24, requestTimeoutMs: 25 })).toThrow(
      /pollResponseTimeoutMs 不得小于 requestTimeoutMs/,
    );
  });
});

describe("Remote Runner Worker payload/stop boundary", () => {
  const workFor = (request: RunnerRequest, delivery = 1) => ({
    kind: "dispatch",
    request,
    delivery,
    leaseId: `lease-${delivery}`,
  });

  const stubTransport = (worker: InstanceType<typeof RemoteRunnerWorker>) => {
    worker.sendWithReconnect = vi.fn(async () => ({ status: 200, body: {} }));
    return worker;
  };

  it("大 prompt 在执行前拒绝；active 多 request 共用全局硬预算", async () => {
    const tooLarge = stubTransport(
      new RemoteRunnerWorker({
        url: "http://127.0.0.1:1",
        token: TOKEN,
        hostId: HOST,
        runner: inertRunner(),
        maxRequestBytes: 300,
        maxEventBytes: 512,
        maxExecutionPayloadBytes: 2_048,
        maxCachedPayloadBytes: 4_096,
      }),
    );
    await expect(
      tooLarge.handleDispatch(
        workFor(
          baseRequest({
            requestId: "worker-large-prompt",
            prompt: "p".repeat(400),
          }),
        ),
        1_000_000,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    expect(tooLarge.executions.size).toBe(0);
    expect(tooLarge.cachedPayloadBytes).toBe(0);
    await tooLarge.stop();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const runner = {
      dispatch: async (request: RunnerRequest) => {
        await gate;
        return {
          requestId: request.requestId,
          text: "done",
          sessionId: null,
          ms: 1,
          fresh: true,
        };
      },
      cancel: async (requestId: string) => ({ requestId, outcome: "cancelled" }),
      resetSession: async () => {},
      close: async () => release(),
    };
    const firstRequest = baseRequest({ requestId: "worker-global-a" });
    const probe = new RemoteRunnerWorker({
      url: "http://127.0.0.1:1",
      token: TOKEN,
      hostId: HOST,
      runner,
      maxEventBytes: 512,
    });
    const firstAccountedBytes =
      Buffer.byteLength(JSON.stringify(firstRequest)) +
      probe.workerTerminalReserveBytes(firstRequest.requestId);
    const worker = stubTransport(
      new RemoteRunnerWorker({
        url: "http://127.0.0.1:1",
        token: TOKEN,
        hostId: HOST,
        runner,
        maxEventBytes: 512,
        maxExecutionPayloadBytes: 2_048,
        maxCachedPayloadBytes: firstAccountedBytes,
      }),
    );
    const first = worker.handleDispatch(
      workFor(firstRequest),
      1_000_000,
      new AbortController().signal,
    );
    await waitFor(() => worker.executions.size === 1);
    expect(worker.cachedPayloadBytes).toBe(firstAccountedBytes);
    await expect(
      worker.handleDispatch(
        workFor(baseRequest({ requestId: "worker-global-b" }), 2),
        1_000_000,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "cache_capacity" });
    expect(worker.executions.has("worker-global-b")).toBe(false);
    expect(worker.cachedPayloadBytes).toBe(firstAccountedBytes);
    release();
    await first;
    expect(worker.cachedPayloadBytes).toBe(
      worker.executions.get(firstRequest.requestId).payloadBytes,
    );
    await worker.stop();
  });

  it("result/error 与 terminal event 精确换账，completed trim 精确扣除旧执行", async () => {
    const runner = {
      dispatch: async (
        request: RunnerRequest,
        { onEvent }: { onEvent: (event: RunnerEvent) => void },
      ) => {
        if (request.prompt === "fail-budget") {
          const error = runnerError({
            requestId: request.requestId,
            code: RUNNER_ERROR_CODES.INTERNAL,
            message: "fixed failure",
            retryable: false,
          });
          onEvent(runnerLifecycleEvent(request.requestId, 1, "failed", error));
          throw new RunnerDispatchError(error);
        }
        const result = {
          requestId: request.requestId,
          text: "r".repeat(120),
          sessionId: null,
          ms: 1,
          fresh: true,
        };
        onEvent(runnerLifecycleEvent(request.requestId, 1, "completed", result));
        return result;
      },
      cancel: async (requestId: string) => ({ requestId, outcome: "cancelled" }),
      resetSession: async () => {},
      close: async () => {},
    };
    const worker = stubTransport(
      new RemoteRunnerWorker({
        url: "http://127.0.0.1:1",
        token: TOKEN,
        hostId: HOST,
        runner,
        maxCompleted: 1,
        maxEventBytes: 1_024,
        maxExecutionPayloadBytes: 4_096,
        maxCachedPayloadBytes: 4_096,
      }),
    );
    const completedId = "worker-budget-complete";
    await worker.handleDispatch(
      workFor(baseRequest({ requestId: completedId })),
      1_000_000,
      new AbortController().signal,
    );
    const completed = worker.executions.get(completedId);
    expect(completed.settled).toBe(true);
    expect(completed.reservedBytes).toBe(0);
    expect(completed.payloadBytes).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(completed.request)),
    );
    expect(worker.cachedPayloadBytes).toBe(completed.payloadBytes);

    const failedId = "worker-budget-failed";
    await worker.handleDispatch(
      workFor(baseRequest({ requestId: failedId, prompt: "fail-budget" }), 2),
      1_000_000,
      new AbortController().signal,
    );
    const failed = worker.executions.get(failedId);
    expect(worker.executions.has(completedId)).toBe(false);
    expect(failed.settled).toBe(true);
    expect(failed.reservedBytes).toBe(0);
    expect(failed.error).toMatchObject({ code: RUNNER_ERROR_CODES.INTERNAL });
    expect(failed.events.at(-1)).toMatchObject({ kind: "failed" });
    expect(worker.cachedPayloadBytes).toBe(failed.payloadBytes);
    expect(worker.cachedPayloadBytes).toBeLessThanOrEqual(4_096);
    await worker.stop();
  });

  it("oversize vendor event 只缓存固定 synthetic failure，并准确消费 terminal reserve", async () => {
    const cancel = vi.fn(async (requestId: string) => ({
      requestId,
      outcome: "cancelled",
    }));
    const runner = {
      dispatch: async (
        request: RunnerRequest,
        { onEvent }: { onEvent: (event: RunnerEvent) => void },
      ) => {
        onEvent({
          requestId: request.requestId,
          sequence: 1,
          at: new Date().toISOString(),
          kind: "delta",
          text: "vendor-secret".repeat(100),
        });
        return {
          requestId: request.requestId,
          text: "must-not-win",
          sessionId: null,
          ms: 1,
          fresh: true,
        };
      },
      cancel,
      resetSession: async () => {},
      close: async () => {},
    };
    const worker = stubTransport(
      new RemoteRunnerWorker({
        url: "http://127.0.0.1:1",
        token: TOKEN,
        hostId: HOST,
        runner,
        maxEventBytes: 512,
        maxExecutionPayloadBytes: 1_024,
        maxCachedPayloadBytes: 1_024,
      }),
    );
    const requestId = "worker-synthetic-overflow";
    await worker.handleDispatch(
      workFor(baseRequest({ requestId })),
      1_000_000,
      new AbortController().signal,
    );
    await Promise.resolve();
    const entry = worker.executions.get(requestId);
    expect(entry.reservedBytes).toBe(0);
    expect(entry.result).toBeNull();
    expect(entry.error).toMatchObject({
      code: RUNNER_ERROR_CODES.INTERNAL,
      message: "Remote Runner Worker payload cache 超出限制",
    });
    expect(entry.events).toHaveLength(1);
    expect(entry.events[0]).toMatchObject({ kind: "failed", error: entry.error });
    expect(JSON.stringify(entry)).not.toContain("vendor-secret");
    expect(worker.cachedPayloadBytes).toBe(entry.payloadBytes);
    expect(worker.cachedPayloadBytes).toBeLessThanOrEqual(1_024);
    expect(cancel).toHaveBeenCalledWith(requestId);
    await worker.stop();
  });

  it("stalled replay 被 pin，容量压力不能淘汰后重执行；delivery 集合完成后清空", async () => {
    const executions = new Map<string, number>();
    const runner = {
      dispatch: async (
        request: RunnerRequest,
        { onEvent }: { onEvent: (event: RunnerEvent) => void },
      ) => {
        executions.set(request.requestId, (executions.get(request.requestId) ?? 0) + 1);
        const result = {
          requestId: request.requestId,
          text: "replay-result",
          sessionId: null,
          ms: 1,
          fresh: true,
        };
        onEvent(runnerLifecycleEvent(request.requestId, 1, "completed", result));
        return result;
      },
      cancel: async (requestId: string) => ({ requestId, outcome: "cancelled" }),
      resetSession: async () => {},
      close: async () => {},
    };
    const worker = new RemoteRunnerWorker({
      url: "http://127.0.0.1:1",
      token: TOKEN,
      hostId: HOST,
      runner,
      maxEventBytes: 400,
      maxExecutionPayloadBytes: 2_048,
      maxCachedPayloadBytes: 600,
    });
    let blockNext = false;
    let replayStarted: () => void = () => {};
    const replayStart = new Promise<void>((resolveReplay) => {
      replayStarted = resolveReplay;
    });
    let releaseReplay: () => void = () => {};
    const replayGate = new Promise<void>((resolveReplay) => {
      releaseReplay = resolveReplay;
    });
    worker.sendWithReconnect = vi.fn(async () => {
      if (blockNext) {
        blockNext = false;
        replayStarted();
        await replayGate;
      }
      return { status: 200, body: {} };
    });

    const firstRequest = baseRequest({ requestId: "pinned-replay-first" });
    await worker.handleDispatch(
      workFor(firstRequest),
      1_000_000,
      new AbortController().signal,
    );
    const first = worker.executions.get(firstRequest.requestId);
    expect(first.pins).toBe(0);
    expect(first.orphanedDeliveries.size).toBe(0);
    blockNext = true;
    const replay = worker.handleDispatch(
      workFor(firstRequest, 2),
      1_000_000,
      new AbortController().signal,
    );
    await replayStart;
    expect(first.pins).toBe(1);

    const secondRequest = baseRequest({ requestId: "pinned-replay-second" });
    await expect(
      worker.handleDispatch(
        workFor(secondRequest, 3),
        1_000_000,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "cache_capacity" });
    expect(worker.executions.get(firstRequest.requestId)).toBe(first);
    expect(executions.get(firstRequest.requestId)).toBe(1);

    releaseReplay();
    await replay;
    expect(first.pins).toBe(0);
    expect(first.orphanedDeliveries.size).toBe(0);
    await worker.handleDispatch(
      workFor(secondRequest, 4),
      1_000_000,
      new AbortController().signal,
    );
    expect(worker.executions.has(firstRequest.requestId)).toBe(false);
    expect(worker.executions.has(secondRequest.requestId)).toBe(true);
    expect(executions.get(firstRequest.requestId)).toBe(1);
    expect(executions.get(secondRequest.requestId)).toBe(1);
    expect(worker.cachedPayloadBytes).toBe(
      worker.executions.get(secondRequest.requestId).payloadBytes,
    );
    await worker.stop();
  });

  it("in-flight control 不被 completed trim 淘汰或重复执行，payload 回收无泄漏", async () => {
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((resolveSlow) => {
      releaseSlow = resolveSlow;
    });
    const calls = new Map<string, number>();
    const runner = {
      dispatch: async () => {
        throw new Error("unused");
      },
      cancel: async (requestId: string) => {
        calls.set(requestId, (calls.get(requestId) ?? 0) + 1);
        if (requestId === "slow-control") await slowGate;
        return { requestId, outcome: "cancelled" };
      },
      resetSession: async () => {},
      close: async () => releaseSlow(),
    };
    const worker = stubTransport(
      new RemoteRunnerWorker({
        url: "http://127.0.0.1:1",
        token: TOKEN,
        hostId: HOST,
        runner,
        maxCompleted: 1,
        maxConcurrentControls: 2,
        maxEventBytes: 512,
        maxCachedPayloadBytes: 2_048,
      }),
    );
    const signal = new AbortController().signal;
    const slowWork = {
      kind: "cancel",
      controlId: "control-slow",
      requestId: "slow-control",
      delivery: 1,
      leaseId: "lease-control-slow",
    };
    const slow = worker.handleControl(slowWork, 1_000_000, signal);
    await waitFor(() => calls.get("slow-control") === 1);
    await worker.handleControl(
      {
        kind: "cancel",
        controlId: "control-fast",
        requestId: "fast-control",
        delivery: 1,
        leaseId: "lease-control-fast",
      },
      1_000_000,
      signal,
    );
    expect(worker.completedControls.size).toBe(2);
    expect(worker.completedControls.get("control-slow").settled).toBe(false);
    expect(worker.completedControls.get("control-fast").settled).toBe(true);
    const fastPayload = worker.completedControls.get("control-fast").payloadBytes;
    expect(worker.cachedPayloadBytes).toBe(fastPayload);

    const replay = worker.handleControl(slowWork, 1_000_000, signal);
    releaseSlow();
    await Promise.all([slow, replay]);
    expect(calls.get("slow-control")).toBe(1);
    expect(worker.completedControls.has("control-slow")).toBe(true);
    expect(worker.completedControls.has("control-fast")).toBe(false);
    expect(worker.cachedPayloadBytes).toBe(
      worker.completedControls.get("control-slow").payloadBytes,
    );
    await worker.stop();
  });

  it("pre-aborted heartbeat 不发请求；runner close reject/deadline 固定向 stop 传播", async () => {
    const fetchImpl = vi.fn();
    const heartbeatWorker = new RemoteRunnerWorker({
      url: "http://127.0.0.1:1",
      token: TOKEN,
      hostId: HOST,
      runner: inertRunner(),
      fetchImpl,
    });
    const aborted = new AbortController();
    aborted.abort();
    const stopHeartbeat = heartbeatWorker.startHeartbeat(
      workFor(baseRequest({ requestId: "pre-aborted-heartbeat" })),
      30,
      aborted.signal,
      vi.fn(),
    );
    await stopHeartbeat();
    expect(fetchImpl).not.toHaveBeenCalled();
    const queuedFactory = vi.fn();
    const launchSignal = new AbortController();
    heartbeatWorker.launch(queuedFactory, launchSignal.signal, "dispatch");
    launchSignal.abort();
    await waitFor(() => heartbeatWorker.activeOperations.size === 0);
    expect(queuedFactory).not.toHaveBeenCalled();
    expect(heartbeatWorker.activeDispatches).toBe(0);
    await heartbeatWorker.stop();

    const secret = "runner-close-secret";
    const rejecting = new RemoteRunnerWorker({
      url: "http://127.0.0.1:1",
      token: TOKEN,
      hostId: HOST,
      runner: {
        ...inertRunner(),
        close: async () => {
          throw new Error(secret);
        },
      },
      stopTimeoutMs: 50,
    });
    const rejected = await rejecting.stop().catch((error: unknown) => error);
    expect(rejected).toMatchObject({
      code: "close_failed",
      message: "Remote Runner Worker stop failed",
    });
    expect(JSON.stringify(rejected)).not.toContain(secret);

    const hanging = new RemoteRunnerWorker({
      url: "http://127.0.0.1:1",
      token: TOKEN,
      hostId: HOST,
      runner: {
        ...inertRunner(),
        close: () => new Promise(() => {}),
      },
      stopTimeoutMs: 20,
    });
    await expect(hanging.stop()).rejects.toMatchObject({
      code: "deadline_exceeded",
      message: "Remote Runner Worker stop failed",
    });
  });
});

describe("Remote Runner retry backoff", () => {
  it("每个 operation 指数退避并带 jitter，成功后从基础档重新开始", async () => {
    const delays: number[] = [];
    const randomValues = [0, 1, 0.5, 0];
    const retryTimerApi = {
      setTimeout(callback: () => void, ms: number) {
        delays.push(ms);
        const handle = Object.freeze({ index: delays.length });
        queueMicrotask(callback);
        return handle;
      },
      clearTimeout: vi.fn(),
    };
    let failuresRemaining = 3;
    const worker = new RemoteRunnerWorker({
      url: "http://127.0.0.1:1",
      token: TOKEN,
      hostId: HOST,
      runner: inertRunner(),
      reconnectDelayMs: 100,
      reconnectMaxDelayMs: 400,
      random: () => randomValues.shift() ?? 0,
      retryTimerApi,
      fetchImpl: async () => {
        if (failuresRemaining-- > 0) throw new TypeError("offline fixture");
        return new Response(null, { status: 204 });
      },
    });

    const signal = new AbortController().signal;
    await expect(worker.sendWithReconnect("/poll", {}, signal)).resolves.toMatchObject({
      status: 204,
    });
    expect(delays).toEqual([50, 200, 300]);

    failuresRemaining = 1;
    await expect(worker.sendWithReconnect("/poll", {}, signal)).resolves.toMatchObject({
      status: 204,
    });
    expect(delays).toEqual([50, 200, 300, 50]);
    expect(retryTimerApi.clearTimeout).toHaveBeenCalledTimes(4);
  });
});

describe("C-REMOTE-01 · outbound Remote Runner transport", () => {
  it("credential 在 Hub 侧固定绑定 host，拒绝缺失或 body 冒充 identity", async () => {
    expect(() => new RemoteRunner({ token: TOKEN })).toThrow(/hostId/);
    const environment = makeRoot();
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 20,
    });
    const { server, url } = await serve(remote);
    cleanups.push(async () => {
      await remote.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });

    const response = await fetch(`${url}/runner/v1/poll`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hostId: "spoofed-host",
        acceptDispatch: true,
        acceptControl: true,
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("未投递 work 可在 Hub 侧线性取消，并暴露严格 health / close 状态", async () => {
    const environment = makeRoot();
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 20,
    });
    cleanups.push(async () => {
      await remote.close();
      rmSync(environment.root, { recursive: true, force: true });
    });
    const request = baseRequest({ requestId: "remote-queued-cancel" });
    const events: RunnerEvent[] = [];

    expect(remote.health()).toEqual({
      ready: false,
      hostId: HOST,
      inflight: 0,
      queued: 0,
    });
    const dispatch = remote.dispatch(request, {
      onEvent: (event: RunnerEvent) => events.push(event),
    });
    expect(remote.health().queued).toBe(1);
    const abortedPoll = new AbortController();
    abortedPoll.abort();
    await expect(
      remote.waitForWork(
        HOST,
        { acceptDispatch: true, acceptControl: true },
        abortedPoll.signal,
      ),
    ).resolves.toBeNull();
    expect(remote.pollers.size).toBe(0);
    expect(remote.requests.get(request.requestId)).toMatchObject({
      state: "pending",
      delivery: 0,
    });
    await expect(remote.cancel(request.requestId)).resolves.toEqual({
      requestId: request.requestId,
      outcome: RUNNER_CANCEL_OUTCOMES.CANCELLED,
    });
    await expect(dispatch).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.CANCELLED, retryable: false },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sequence: 1,
      kind: "failed",
      error: { code: RUNNER_ERROR_CODES.CANCELLED },
    });
    const cancelledRecord = remote.requests.get(request.requestId);
    expect(cancelledRecord.reservedBytes).toBe(0);
    expect(cancelledRecord.payloadBytes).toBeGreaterThan(cancelledRecord.eventBytes);
    expect(remote.cachedPayloadBytes).toBe(cancelledRecord.payloadBytes);
    expect(remote.health()).toMatchObject({ inflight: 0, queued: 0 });

    await remote.close();
    expect(remote.health().ready).toBe(false);
    await expect(
      remote.dispatch(baseRequest({ requestId: "remote-after-close" })),
    ).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.UNAVAILABLE, retryable: true },
    });
  });

  it("运行中 cancel 通过出站 control 到 LocalRunner，并归一化 failed event", async () => {
    const environment = makeRoot();
    const fixture = contractAdapterFixture();
    const local = new LocalRunner({
      workspaceRoot: environment.workspaceRoot,
      sessionStore: new SessionStore(environment.sessionPath),
      getAdapter: (id: string) => (id === "contract" ? fixture.AdapterClass : null),
      hostId: HOST,
    });
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 20,
    });
    const { server, url } = await serve(remote);
    const worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: local,
      reconnectDelayMs: 5,
    }).start();
    cleanups.push(async () => {
      fixture.releaseBlockedExecution();
      await worker.stop();
      await remote.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });

    const request = baseRequest({ requestId: "remote-running-cancel", prompt: "block" });
    const events: RunnerEvent[] = [];
    const dispatch = remote.dispatch(request, {
      onEvent: (event: RunnerEvent) => events.push(event),
    });
    await fixture.waitForBlockedExecution();
    expect(remote.health().inflight).toBe(1);

    await expect(remote.cancel(request.requestId)).resolves.toEqual({
      requestId: request.requestId,
      outcome: RUNNER_CANCEL_OUTCOMES.CANCELLED,
    });
    await expect(dispatch).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.CANCELLED, retryable: false },
    });
    expect(events.map((event) => event.kind)).toEqual(["started", "failed"]);
    expect(events.at(-1)?.error).toMatchObject({ code: RUNNER_ERROR_CODES.CANCELLED });
    expect(fixture.executionCount()).toBe(1);
    await expect(remote.cancel(request.requestId)).resolves.toEqual({
      requestId: request.requestId,
      outcome: RUNNER_CANCEL_OUTCOMES.CANCELLED,
    });
  });

  it("同一个真实 CLI task 经 Local 与 Remote 得到相同核心结果和事件序列", async () => {
    const environment = makeRoot();
    const localReference = makeCliRunner(
      environment,
      join(environment.root, "local.json"),
    );
    const remoteExecution = makeCliRunner(
      environment,
      join(environment.root, "remote.json"),
    );
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 30,
    });
    const { server, url } = await serve(remote);
    const worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: remoteExecution,
      reconnectDelayMs: 5,
    }).start();
    cleanups.push(async () => {
      await worker.stop();
      await remote.close();
      await localReference.close();
      await remoteExecution.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });

    const request = cliRequest("remote-parity", "same-task");
    const localEvents: RunnerEvent[] = [];
    const remoteEvents: RunnerEvent[] = [];
    const localResult = await localReference.dispatch(request, {
      onEvent: (event: RunnerEvent) => localEvents.push(event),
    });
    const remoteResult = await remote.dispatch(request, {
      onEvent: (event: RunnerEvent) => remoteEvents.push(event),
    });

    expect(remoteResult).toMatchObject({
      text: localResult.text,
      sessionId: localResult.sessionId,
      fresh: localResult.fresh,
    });
    expect(remoteEvents.map(comparableEvent)).toEqual(localEvents.map(comparableEvent));
    expect(remoteEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("拒绝错误 Bearer credential，且不会接触本地执行端", async () => {
    const environment = makeRoot();
    let executions = 0;
    let closes = 0;
    const runner = {
      dispatch: async () => {
        executions++;
        throw new Error("must not execute");
      },
      cancel: async (requestId: string) => ({ requestId, outcome: "not_found" }),
      resetSession: async () => {},
      close: async () => {
        closes++;
      },
    };
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 20,
    });
    const { server, url } = await serve(remote);
    const worker = new RemoteRunnerWorker({
      url,
      token: "wrong-remote-runner-token-with-at-least-32-bytes",
      hostId: HOST,
      runner,
      reconnectDelayMs: 5,
    }).start();
    cleanups.push(async () => {
      await worker.stop();
      await remote.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });

    await expect(worker.wait()).rejects.toBeInstanceOf(RemoteAuthenticationError);
    expect(executions).toBe(0);
    expect(worker.fatalError).toBeInstanceOf(RemoteAuthenticationError);
    await worker.stop();
    expect(closes).toBe(1);
  });

  it("连接瞬断后主动重连，并完成已在 Hub 排队的任务", async () => {
    const environment = makeRoot();
    const local = makeCliRunner(environment, environment.sessionPath);
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 20,
    });
    const { server, url } = await serve(remote);
    const states: string[] = [];
    let disconnected = false;
    const reconnectingFetch: typeof fetch = async (...args) => {
      if (!disconnected) {
        disconnected = true;
        throw new TypeError("simulated connection reset");
      }
      return fetch(...args);
    };
    const worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: local,
      reconnectDelayMs: 5,
      fetchImpl: reconnectingFetch,
      onState: ({ state }: { state: string }) => states.push(state),
    }).start();
    cleanups.push(async () => {
      await worker.stop();
      await remote.close();
      await local.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });

    const result = await remote.dispatch(cliRequest("remote-reconnect", "after-drop"));
    expect(result.text).toBe("fresh:after-drop");
    expect(states).toContain("reconnecting");
    expect(states).toContain("connected");
  });

  it("已断开的 long poll 即使抢到 offer，未 ack 也会快速重排且不丢 work", async () => {
    const environment = makeRoot();
    const fixture = contractAdapterFixture();
    const local = new LocalRunner({
      workspaceRoot: environment.workspaceRoot,
      sessionStore: new SessionStore(environment.sessionPath),
      getAdapter: (id: string) => (id === "contract" ? fixture.AdapterClass : null),
      hostId: HOST,
    });
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 100,
      offerLeaseMs: 30,
      leaseMs: 100,
    });
    const { server, url } = await serve(remote);
    const controller = new AbortController();
    const abandonedPoll = fetch(`${url}/runner/v1/poll`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hostId: HOST,
        acceptDispatch: true,
        acceptControl: true,
      }),
      signal: controller.signal,
    }).catch(() => null);
    await waitFor(() => remote.pollers.size === 1);

    const result = remote.dispatch(baseRequest({ requestId: "remote-abandoned-offer" }));
    controller.abort();
    await abandonedPoll;
    const worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: local,
      reconnectDelayMs: 5,
    }).start();
    cleanups.push(async () => {
      await worker.stop();
      await remote.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });

    await expect(result).resolves.toMatchObject({ text: "contract-result" });
    expect(fixture.executionCount()).toBe(1);
  });

  it("health 随 authenticated Worker 离线变 false，并在重连后恢复 true", async () => {
    const environment = makeRoot();
    const runner = {
      dispatch: async () => {
        throw new Error("not used");
      },
      cancel: async (requestId: string) => ({ requestId, outcome: "not_found" }),
      resetSession: async () => {},
      close: async () => {},
    };
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 5,
      livenessTimeoutMs: 20,
    });
    const { server, url } = await serve(remote);
    let worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner,
      reconnectDelayMs: 5,
    }).start();
    cleanups.push(async () => {
      await worker.stop();
      await remote.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });

    await waitFor(() => remote.health().ready);
    await worker.stop();
    await waitFor(() => !remote.health().ready);
    worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner,
      reconnectDelayMs: 5,
    }).start();
    await waitFor(() => remote.health().ready);
    expect(remote.health()).toMatchObject({ ready: true, hostId: HOST });
  });

  it("重复 delivery 重放缓存结果，Hub 去重 sequence 且本地只执行一次", async () => {
    const environment = makeRoot();
    const fixture = contractAdapterFixture();
    const local = new LocalRunner({
      workspaceRoot: environment.workspaceRoot,
      sessionStore: new SessionStore(environment.sessionPath),
      getAdapter: (id: string) => (id === "contract" ? fixture.AdapterClass : null),
      hostId: HOST,
    });
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 20,
    });
    const { server, url } = await serve(remote);
    const worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: local,
      reconnectDelayMs: 5,
    }).start();
    const signal = new AbortController().signal;
    cleanups.push(async () => {
      await worker.stop();
      await remote.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });

    const request = baseRequest({ requestId: "remote-redelivery", prompt: "events" });
    const events: RunnerEvent[] = [];
    const result = remote.dispatch(request, {
      onEvent: (event: RunnerEvent) => events.push(event),
    });
    await expect(result).resolves.toMatchObject({ text: "contract-result" });
    const leaseId = remote.requests.get(request.requestId).leaseId;
    await worker.handleDispatch(
      { kind: "dispatch", request, delivery: 1, leaseId },
      100,
      signal,
    );

    expect(fixture.executionCount()).toBe(1);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);

    const appended = await fetch(`${url}/runner/v1/event`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hostId: HOST,
        requestId: request.requestId,
        delivery: 1,
        leaseId,
        event: {
          requestId: request.requestId,
          sequence: 7,
          at: new Date().toISOString(),
          kind: "progress",
          label: "must-not-append",
        },
      }),
    });
    expect(appended.status).toBe(409);
    expect(events).toHaveLength(6);
  });

  it("Worker 与 LocalRunner 重启后从持久 store 恢复同一 vendor session", async () => {
    const environment = makeRoot();
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 20,
    });
    const { server, url } = await serve(remote);
    let local = makeCliRunner(environment, environment.sessionPath);
    let worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: local,
      reconnectDelayMs: 5,
    }).start();
    cleanups.push(async () => {
      await worker.stop();
      await remote.close();
      await local.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });

    const first = await remote.dispatch(cliRequest("remote-session-1", "first"));
    expect(first).toMatchObject({ text: "fresh:first", fresh: true });
    await worker.stop();
    await local.close();

    local = makeCliRunner(environment, environment.sessionPath);
    worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: local,
      reconnectDelayMs: 5,
    }).start();
    const events: RunnerEvent[] = [];
    const resumed = await remote.dispatch(cliRequest("remote-session-2", "second"), {
      onEvent: (event: RunnerEvent) => events.push(event),
    });

    expect(resumed).toMatchObject({
      text: "resumed:fixture-session-1:second",
      sessionId: "fixture-session-1",
      fresh: false,
    });
    expect(events[0]).toMatchObject({ kind: "started", fresh: false });
  });

  it("server 与 Worker 一致拒绝弱 token、非 loopback HTTP、退化 path 和 redirect", async () => {
    const environment = makeRoot();
    const store = placementStore(environment);
    const runner = inertRunner();
    expect(
      () =>
        new RemoteRunner({
          token: "too-short",
          hostId: HOST,
          placementStore: store,
        }),
    ).toThrow(/32 bytes/);
    expect(
      () =>
        new RemoteRunner({
          token: TOKEN,
          hostId: HOST,
          placementStore: store,
          pathPrefix: "/",
        }),
    ).toThrow(/pathPrefix/);
    expect(
      () =>
        new RemoteRunnerWorker({
          url: "http://127.0.0.1:1",
          token: "too-short",
          hostId: HOST,
          runner,
        }),
    ).toThrow(/32 bytes/);
    expect(
      () =>
        new RemoteRunnerWorker({
          url: "http://runner.example",
          token: TOKEN,
          hostId: HOST,
          runner,
        }),
    ).toThrow(/HTTPS/);
    expect(
      () =>
        new RemoteRunnerWorker({
          url: "https://runner.example",
          token: TOKEN,
          hostId: HOST,
          runner,
          pathPrefix: "/",
        }),
    ).toThrow(/pathPrefix/);

    let redirectMode: RequestRedirect | undefined;
    const redirectWorker = new RemoteRunnerWorker({
      url: "https://runner.example",
      token: TOKEN,
      hostId: HOST,
      runner,
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
        redirectMode = init?.redirect;
        throw new TypeError("redirect blocked");
      },
    });
    await expect(
      redirectWorker.fetchOnce(
        "/poll",
        { hostId: HOST, acceptDispatch: true, acceptControl: true },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/redirect blocked/);
    expect(redirectMode).toBe("error");
    await redirectWorker.stop();
    rmSync(environment.root, { recursive: true, force: true });
  });

  it("placement 原子持久化且只保存 host；重启保留、错误 host 与损坏/写失败均 fail closed", async () => {
    const environment = makeRoot();
    const scope = { user: "placement-user", project: "placement-project", agent: "a" };
    const store = placementStore(environment);
    store.set(scope, HOST);
    expect(statSync(environment.placementPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(environment.placementPath, "utf8")).not.toContain("sessionId");

    const restartedStore = placementStore(environment);
    const restarted = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: restartedStore,
      pollTimeoutMs: 20,
    });
    expect(restarted.hasSession(scope)).toBe(true);
    await restarted.close();

    restartedStore.set(scope, OTHER_HOST);
    const wrongHost = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 20,
    });
    expect(wrongHost.hasSession(scope)).toBe(false);
    await expect(
      wrongHost.dispatch(
        baseRequest({
          requestId: "wrong-placement",
          user: scope.user,
          project: scope.project,
          agent: scope.agent,
        }),
      ),
    ).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.UNAVAILABLE, retryable: true },
    });
    await expect(wrongHost.resetSession(scope)).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.UNAVAILABLE, retryable: true },
    });
    await wrongHost.close();

    class FaultPlacementStore extends RemotePlacementStore {
      fail = false;

      persist(value?: unknown) {
        if (this.fail) throw new Error("simulated placement write failure");
        return super.persist(value);
      }
    }
    const faultPath = join(environment.root, "state", "fault-placements.json");
    const fault = new FaultPlacementStore({ filePath: faultPath });
    fault.set(scope, HOST);
    fault.fail = true;
    expect(() => fault.set(scope, OTHER_HOST)).toThrow(/simulated/);
    expect(fault.getHostId(scope)).toBe(HOST);

    const corruptPath = join(environment.root, "state", "corrupt-placements.json");
    writeFileSync(corruptPath, "{not-json", { mode: 0o600 });
    expect(() => new RemotePlacementStore({ filePath: corruptPath })).toThrow(
      /无法读取 placement store/,
    );
    rmSync(environment.root, { recursive: true, force: true });
  });

  it("静默长任务通过 heartbeat 续租，不会被健康 Worker 重投", async () => {
    const environment = makeRoot();
    const fixture = contractAdapterFixture();
    const local = new LocalRunner({
      workspaceRoot: environment.workspaceRoot,
      sessionStore: new SessionStore(environment.sessionPath),
      getAdapter: (id: string) => (id === "contract" ? fixture.AdapterClass : null),
      hostId: HOST,
    });
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 10,
      offerLeaseMs: 10,
      leaseMs: 30,
      closeGraceMs: 50,
    });
    const { server, url } = await serve(remote);
    const worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: local,
      reconnectDelayMs: 2,
    }).start();
    cleanups.push(async () => {
      fixture.releaseBlockedExecution();
      await worker.stop();
      await remote.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });

    const request = baseRequest({ requestId: "heartbeat-silent", prompt: "block" });
    const result = remote.dispatch(request);
    await fixture.waitForBlockedExecution();
    const initialLease = remote.requests.get(request.requestId).leaseId;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const record = remote.requests.get(request.requestId);
    expect(record).toMatchObject({
      state: "inflight",
      delivery: 1,
      leaseId: initialLease,
    });
    expect(record.leaseUntil).toBeGreaterThan(Date.now());
    expect(fixture.executionCount()).toBe(1);
    fixture.releaseBlockedExecution();
    await expect(result).resolves.toMatchObject({ text: "contract-result" });
    expect(fixture.executionCount()).toBe(1);
  });

  it("每次 claim 使用不可预测 leaseId；过期 Worker 的 event/result/fail 全被 fence", async () => {
    const environment = makeRoot();
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 10,
      offerLeaseMs: 10,
      leaseMs: 25,
      closeGraceMs: 30,
    });
    const request = baseRequest({ requestId: "stale-lease" });
    const dispatch = remote.dispatch(request);
    void dispatch.catch(() => {});
    const first = remote.claim(HOST);
    expect(first).toMatchObject({ kind: "dispatch", delivery: 1 });
    remote.acceptAck(HOST, {
      requestId: request.requestId,
      delivery: first.delivery,
      leaseId: first.leaseId,
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    const second = remote.claim(HOST);
    expect(second).toMatchObject({ kind: "dispatch", delivery: 2 });
    expect(second.leaseId).not.toBe(first.leaseId);
    remote.acceptAck(HOST, {
      requestId: request.requestId,
      delivery: second.delivery,
      leaseId: second.leaseId,
    });

    const failure = runnerError({
      requestId: request.requestId,
      code: RUNNER_ERROR_CODES.CANCELLED,
      message: "stale worker must be fenced",
      retryable: false,
    });
    const failedEvent = runnerLifecycleEvent(request.requestId, 1, "failed", failure);
    for (const submit of [
      () =>
        remote.acceptEvent(
          HOST,
          request.requestId,
          first.delivery,
          first.leaseId,
          failedEvent,
        ),
      () =>
        remote.acceptResult(HOST, request.requestId, first.delivery, first.leaseId, {
          requestId: request.requestId,
          text: "stale",
          sessionId: null,
          ms: 0,
          fresh: true,
        }),
      () =>
        remote.acceptFailure(
          HOST,
          request.requestId,
          first.delivery,
          first.leaseId,
          failure,
        ),
    ]) {
      expect(submit).toThrowError(
        expect.objectContaining({ status: 409, code: "stale_delivery" }),
      );
    }

    remote.acceptEvent(
      HOST,
      request.requestId,
      second.delivery,
      second.leaseId,
      failedEvent,
    );
    remote.acceptFailure(
      HOST,
      request.requestId,
      second.delivery,
      second.leaseId,
      failure,
    );
    await expect(dispatch).rejects.toMatchObject({ error: failure });
    await remote.close();
    rmSync(environment.root, { recursive: true, force: true });
  });

  it("Worker.stop 先关闭底层 runner 解除阻塞，并在确定上界内清空 active operation", async () => {
    const environment = makeRoot();
    const fixture = contractAdapterFixture();
    const local = new LocalRunner({
      workspaceRoot: environment.workspaceRoot,
      sessionStore: new SessionStore(environment.sessionPath),
      getAdapter: (id: string) => (id === "contract" ? fixture.AdapterClass : null),
      hostId: HOST,
    });
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 10,
      closeGraceMs: 40,
      controlTimeoutMs: 40,
    });
    const { server, url } = await serve(remote);
    const worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: local,
      reconnectDelayMs: 2,
      stopTimeoutMs: 200,
    }).start();
    const request = baseRequest({ requestId: "bounded-stop", prompt: "block" });
    const dispatch = remote.dispatch(request);
    void dispatch.catch(() => {});
    await fixture.waitForBlockedExecution();

    const startedAt = Date.now();
    await worker.stop();
    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(fixture.cancellationCount()).toBe(1);
    expect(worker.activeOperations.size).toBe(0);
    await remote.close();
    await expect(dispatch).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.CANCELLED },
    });
    await closeServer(server);
    rmSync(environment.root, { recursive: true, force: true });
  });

  it("control reply 先完整校验再终结，旧 fence 被拒且离线 control 有 deadline", async () => {
    const environment = makeRoot();
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 10,
      offerLeaseMs: 10,
      leaseMs: 25,
      controlTimeoutMs: 500,
    });
    const scope = { user: "control-user", project: "control-project", agent: "a" };
    const firstReset = remote.resetSession(scope);
    const first = remote.claim(HOST, { acceptDispatch: false, acceptControl: true });
    remote.acceptAck(HOST, {
      controlId: first.controlId,
      delivery: first.delivery,
      leaseId: first.leaseId,
    });
    expect(() =>
      remote.acceptControl(HOST, first.controlId, first.delivery, first.leaseId, true, {
        malformed: true,
      }),
    ).toThrow(/不得包含 result/);
    expect(remote.controls.has(first.controlId)).toBe(true);
    remote.acceptControl(HOST, first.controlId, first.delivery, first.leaseId, true);
    await expect(firstReset).resolves.toBeUndefined();

    const secondReset = remote.resetSession(scope);
    const oldFence = remote.claim(HOST, {
      acceptDispatch: false,
      acceptControl: true,
    });
    remote.acceptAck(HOST, {
      controlId: oldFence.controlId,
      delivery: oldFence.delivery,
      leaseId: oldFence.leaseId,
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    const newFence = remote.claim(HOST, {
      acceptDispatch: false,
      acceptControl: true,
    });
    expect(newFence.leaseId).not.toBe(oldFence.leaseId);
    remote.acceptAck(HOST, {
      controlId: newFence.controlId,
      delivery: newFence.delivery,
      leaseId: newFence.leaseId,
    });
    expect(() =>
      remote.acceptControl(
        HOST,
        oldFence.controlId,
        oldFence.delivery,
        oldFence.leaseId,
        true,
      ),
    ).toThrowError(expect.objectContaining({ code: "stale_delivery" }));
    remote.acceptControl(
      HOST,
      newFence.controlId,
      newFence.delivery,
      newFence.leaseId,
      true,
    );
    await expect(secondReset).resolves.toBeUndefined();
    await remote.close();

    const offline = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 10,
      controlTimeoutMs: 25,
    });
    const startedAt = Date.now();
    await expect(offline.resetSession(scope)).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.UNAVAILABLE, retryable: true },
    });
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(offline.controls.size).toBe(0);
    await offline.close();
    rmSync(environment.root, { recursive: true, force: true });
  });

  it("Hub 重启令旧上传 orphan 而不杀 Worker；同 requestId 新 lease 完整重放且不重执行", async () => {
    const environment = makeRoot();
    const fixture = contractAdapterFixture();
    const local = new LocalRunner({
      workspaceRoot: environment.workspaceRoot,
      sessionStore: new SessionStore(environment.sessionPath),
      getAdapter: (id: string) => (id === "contract" ? fixture.AdapterClass : null),
      hostId: HOST,
    });
    let remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      requestLedger: new RemoteRequestLedger({
        directoryPath: join(environment.root, "old-request-ledger"),
      }),
      pollTimeoutMs: 10,
      leaseMs: 40,
      closeGraceMs: 30,
    });
    const oldRemote = remote;
    const server = createServer(async (request, response) => {
      const handled = await remote.handleHttp(request, response);
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
    const url = await listen(server);
    const worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: local,
      reconnectDelayMs: 2,
    }).start();
    const request = baseRequest({ requestId: "hub-restart-orphan", prompt: "block" });
    const abandoned = oldRemote.dispatch(request);
    void abandoned.catch(() => {});
    await fixture.waitForBlockedExecution();
    await waitFor(() => oldRemote.requests.get(request.requestId)?.events.length === 1);
    const oldRecord = oldRemote.requests.get(request.requestId);
    const oldLeaseId = oldRecord.leaseId;

    remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 10,
      leaseMs: 40,
      closeGraceMs: 30,
    });
    const orphanProbe = await postJson(url, "/event", {
      hostId: HOST,
      requestId: request.requestId,
      delivery: oldRecord.delivery,
      leaseId: oldLeaseId,
      event: oldRecord.events[0],
    });
    expect(orphanProbe.status).toBe(404);
    await expect(orphanProbe.json()).resolves.toMatchObject({
      error: "unknown_work",
    });

    fixture.releaseBlockedExecution();
    await waitFor(() => worker.executions.get(request.requestId)?.settled === true);
    expect(worker.fatalError).toBeNull();
    const replayed = await remote.dispatch(request);
    expect(replayed).toMatchObject({ text: "contract-result" });
    const newRecord = remote.requests.get(request.requestId);
    expect(newRecord.delivery).toBe(1);
    expect(newRecord.leaseId).not.toBe(oldLeaseId);
    expect(fixture.executionCount()).toBe(1);
    expect(worker.fatalError).toBeNull();

    await worker.stop();
    await remote.close();
    await oldRemote.close();
    await expect(abandoned).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.CANCELLED },
    });
    await closeServer(server);
    rmSync(environment.root, { recursive: true, force: true });
  });

  it("409 conflict 不会被误判为 orphan：同 sequence 异内容和异 result 都显式失败", async () => {
    const environment = makeRoot();
    const fixture = contractAdapterFixture();
    const local = new LocalRunner({
      workspaceRoot: environment.workspaceRoot,
      sessionStore: new SessionStore(environment.sessionPath),
      getAdapter: (id: string) => (id === "contract" ? fixture.AdapterClass : null),
      hostId: HOST,
    });
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 10,
      leaseMs: 3_000,
    });
    const { server, url } = await serve(remote);
    const worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: local,
      reconnectDelayMs: 2,
    }).start();
    cleanups.push(async () => {
      await worker.stop();
      await remote.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });

    const request = baseRequest({ requestId: "protocol-conflict", prompt: "events" });
    await remote.dispatch(request);
    const record = remote.requests.get(request.requestId);
    const entry = worker.executions.get(request.requestId);
    const work = {
      kind: "dispatch",
      request,
      delivery: record.delivery,
      leaseId: record.leaseId,
    };
    const originalEvent = entry.events[1];
    entry.events[1] = Object.freeze({ ...originalEvent, text: "tampered delta" });
    await expect(
      worker.handleDispatch(work, 3_000, new AbortController().signal),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(entry.orphanedDeliveries.has(work.leaseId)).toBe(false);

    entry.events[1] = originalEvent;
    const originalResult = entry.result;
    entry.result = Object.freeze({ ...originalResult, text: "tampered result" });
    await expect(
      worker.handleDispatch(work, 3_000, new AbortController().signal),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(entry.orphanedDeliveries.has(work.leaseId)).toBe(false);
    entry.result = originalResult;
  });

  it("Worker 并发有硬上限，Hub queued 正确且终态热缓存/Worker cache 有界并可从冷账本重放", async () => {
    const environment = makeRoot();
    const maxCompleted = 2;
    const maxConcurrentDispatches = 2;
    const executionCacheHardLimit = maxCompleted + maxConcurrentDispatches;
    let active = 0;
    let peak = 0;
    let cachePeak = 0;
    let executions = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class BoundedAdapter extends Adapter {
      static id = "bounded";
      static label = "Bounded concurrency fixture";
      static capabilities = {
        streaming: false,
        thoughts: false,
        session: true,
        usage: false,
      };

      async send() {
        executions++;
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
        this._sessionId ??= `bounded-${executions}`;
        return {
          text: "bounded-result",
          sessionId: this._sessionId,
          ms: 1,
          fresh: true,
        };
      }
    }
    const local = new LocalRunner({
      workspaceRoot: environment.workspaceRoot,
      sessionStore: new SessionStore(environment.sessionPath),
      getAdapter: (id: string) => (id === "bounded" ? BoundedAdapter : null),
      hostId: HOST,
    });
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 10,
      maxPending: 20,
      maxCompletedRequests: maxCompleted,
    });
    const { server, url } = await serve(remote);
    const worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: local,
      reconnectDelayMs: 2,
      maxConcurrentDispatches,
      maxCompleted,
    });
    class ObservedExecutionMap extends Map {
      set(key: unknown, value: unknown) {
        super.set(key, value);
        // Size can only grow at set(). Sampling every growth point makes this
        // peak a hard observable bound, independent of eventual trim timing.
        cachePeak = Math.max(cachePeak, this.size);
        return this;
      }
    }
    worker.executions = new ObservedExecutionMap();
    worker.start();
    cleanups.push(async () => {
      release();
      await worker.stop();
      await remote.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });

    const requests = Array.from({ length: 8 }, (_, index) =>
      baseRequest({
        requestId: `bounded-${index}`,
        agent: `bounded-agent-${index}`,
        adapter: "bounded",
      }),
    );
    const results = requests.map((request) => remote.dispatch(request));
    await waitFor(() => active === 2);
    expect(remote.health()).toMatchObject({ inflight: 2, queued: 6 });
    expect(peak).toBe(2);
    release();
    await expect(Promise.all(results)).resolves.toHaveLength(requests.length);
    expect(peak).toBe(2);
    expect(executions).toBe(requests.length);
    expect(remote.requests.size).toBeLessThanOrEqual(2);
    expect(cachePeak).toBeLessThanOrEqual(executionCacheHardLimit);
    // Hub outcome acknowledgement resolves before the Worker resumes from its
    // POST and trims the terminal replay cache. The cache contract is eventual
    // convergence; cachePeak separately covers completed + in-flight entries.
    await waitFor(() => worker.executions.size <= maxCompleted);
    expect(worker.executions.size).toBeLessThanOrEqual(maxCompleted);

    const replayEvents: RunnerEvent[] = [];
    await expect(
      remote.dispatch(requests[0], {
        onEvent: (event: RunnerEvent) => replayEvents.push(event),
      }),
    ).resolves.toMatchObject({ text: "bounded-result" });
    expect(replayEvents.map((event) => event.kind)).toEqual(["started", "completed"]);
    expect(executions).toBe(requests.length);
  });

  it("顺序多批 event 在单条或累计 bytes 越界前 fail-closed，且不缓存越界内容", async () => {
    expect(REMOTE_EVENT_LIMIT_BYTES).toBeLessThan(REMOTE_REQUEST_EVENT_LIMIT_BYTES);
    expect(REMOTE_REQUEST_EVENT_LIMIT_BYTES).toBeLessThan(
      REMOTE_CACHED_PAYLOAD_LIMIT_BYTES,
    );
    const environment = makeRoot();
    expect(
      () =>
        new RemoteRunner({
          token: TOKEN,
          hostId: HOST,
          placementStore: placementStore(environment),
          maxCachedPayloadBytes: REMOTE_CACHED_PAYLOAD_LIMIT_BYTES + 1,
        }),
    ).toThrow(/maxCachedPayloadBytes 不得超过 staging hard limit/);
    const maxEventBytes = 512;
    const maxRequestEventBytes = 900;
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 10,
      maxEventBytes,
      maxRequestEventBytes,
    });
    const { server, url } = await serve(remote);
    cleanups.push(async () => {
      await remote.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });

    const begin = (requestId: string) => {
      const request = baseRequest({ requestId, agent: requestId });
      const dispatch = remote.dispatch(request);
      void dispatch.catch(() => {});
      const work = remote.claim(HOST);
      remote.acceptAck(HOST, {
        requestId,
        delivery: work.delivery,
        leaseId: work.leaseId,
      });
      return { dispatch, work };
    };
    const upload = (requestId: string, work: Record<string, unknown>, event: unknown) =>
      postJson(url, "/event", {
        hostId: HOST,
        requestId,
        delivery: work.delivery,
        leaseId: work.leaseId,
        event,
      });
    const event = (requestId: string, sequence: number, text: string) => ({
      requestId,
      sequence,
      at: new Date().toISOString(),
      kind: "delta",
      text,
    });

    const single = begin("event-single-byte-limit");
    const singleFailure = await upload(
      "event-single-byte-limit",
      single.work,
      event("event-single-byte-limit", 1, "x".repeat(maxEventBytes)),
    );
    expect(singleFailure.status).toBe(413);
    expect(await singleFailure.json()).toEqual({
      error: "event_bytes_exceeded",
      message: "dispatch event bytes 超出限制",
    });
    await expect(single.dispatch).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.INTERNAL, retryable: false },
    });
    expect(remote.requests.has("event-single-byte-limit")).toBe(false);
    expect(remote.requestLedger.get("event-single-byte-limit").events).toHaveLength(1);
    expect(remote.requestLedger.get("event-single-byte-limit").events[0].kind).toBe(
      "failed",
    );

    const cumulative = begin("event-cumulative-byte-limit");
    const acceptedEvents = [
      event("event-cumulative-byte-limit", 1, "a".repeat(220)),
      event("event-cumulative-byte-limit", 2, "b".repeat(220)),
    ];
    for (const acceptedEvent of acceptedEvents) {
      expect(Buffer.byteLength(JSON.stringify(acceptedEvent))).toBeLessThanOrEqual(
        maxEventBytes,
      );
      const response = await upload(
        "event-cumulative-byte-limit",
        cumulative.work,
        acceptedEvent,
      );
      expect(response.status).toBe(200);
    }
    const cumulativeRecord = remote.requests.get("event-cumulative-byte-limit");
    expect(cumulativeRecord.eventBytes).toBeLessThanOrEqual(maxRequestEventBytes);

    const cumulativeFailure = await upload(
      "event-cumulative-byte-limit",
      cumulative.work,
      event("event-cumulative-byte-limit", 3, "c".repeat(220)),
    );
    expect(cumulativeFailure.status).toBe(413);
    expect(await cumulativeFailure.json()).toEqual({
      error: "event_bytes_exceeded",
      message: "dispatch event bytes 超出限制",
    });
    await expect(cumulative.dispatch).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.INTERNAL, retryable: false },
    });
    expect(cumulativeRecord.eventBytes).toBeLessThanOrEqual(maxRequestEventBytes);
    expect(cumulativeRecord.bufferedEvents.size).toBe(0);
    expect(remote.requests.has("event-cumulative-byte-limit")).toBe(false);
    const archived = remote.requestLedger.get("event-cumulative-byte-limit");
    expect(
      archived.events.filter(({ kind }: RunnerEvent) => kind === "delta"),
    ).toHaveLength(acceptedEvents.length);
  });

  it("Hub request/prompt/event 共用全局 payload 上限，越界新 request 不挤占既有 active cache", async () => {
    const environment = makeRoot();
    const maxCachedPayloadBytes = 2_200;
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 10,
      closeGraceMs: 10,
      maxEventBytes: 500,
      maxRequestEventBytes: 1_500,
      maxRequestBytes: 600,
      maxCachedPayloadBytes,
    });
    const { server, url } = await serve(remote);
    cleanups.push(async () => {
      await remote.close();
      await closeServer(server);
      rmSync(environment.root, { recursive: true, force: true });
    });

    const begin = (requestId: string) => {
      const request = baseRequest({ requestId, agent: requestId });
      const dispatch = remote.dispatch(request);
      void dispatch.catch(() => {});
      const work = remote.claim(HOST);
      remote.acceptAck(HOST, {
        requestId,
        delivery: work.delivery,
        leaseId: work.leaseId,
      });
      return { dispatch, work };
    };
    const active = ["global-cache-a", "global-cache-b"].map((requestId) => ({
      requestId,
      ...begin(requestId),
    }));

    for (const item of active) {
      const event = {
        requestId: item.requestId,
        sequence: 1,
        at: new Date().toISOString(),
        kind: "delta",
        text: "x".repeat(320),
      };
      const response = await postJson(url, "/event", {
        hostId: HOST,
        requestId: item.requestId,
        delivery: item.work.delivery,
        leaseId: item.work.leaseId,
        event,
      });
      expect(response.status).toBe(200);
    }
    const retainedPayloadBytes = active.reduce((total, item) => {
      const record = remote.requests.get(item.requestId);
      return total + record.payloadBytes + record.reservedBytes;
    }, 0);
    expect(remote.cachedPayloadBytes).toBe(retainedPayloadBytes);
    expect(retainedPayloadBytes).toBeLessThanOrEqual(maxCachedPayloadBytes);

    const rejectedId = "global-cache-c";
    await expect(
      remote.dispatch(baseRequest({ requestId: rejectedId, agent: rejectedId })),
    ).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.UNAVAILABLE, retryable: true },
    });
    expect(remote.requests.has(rejectedId)).toBe(false);
    expect(remote.cachedPayloadBytes).toBe(retainedPayloadBytes);

    const oversizedPromptId = "global-cache-large-prompt";
    await expect(
      remote.dispatch(
        baseRequest({
          requestId: oversizedPromptId,
          prompt: "p".repeat(600),
        }),
      ),
    ).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.INVALID_REQUEST, retryable: false },
    });
    expect(remote.requests.has(oversizedPromptId)).toBe(false);
    expect(remote.cachedPayloadBytes).toBe(retainedPayloadBytes);
    expect(remote.cachedPayloadBytes).toBeLessThanOrEqual(maxCachedPayloadBytes);
  });

  it("terminal result 计入全局 payload，completed trim 精确扣减且超限时只保留冷账本", async () => {
    const environment = makeRoot();
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 10,
      maxCompletedRequests: 1,
      maxEventBytes: 2_048,
      maxRequestEventBytes: 4_096,
      maxCachedPayloadBytes: 4_096,
    });
    cleanups.push(async () => {
      await remote.close();
      rmSync(environment.root, { recursive: true, force: true });
    });

    const complete = async (requestId: string, text: string) => {
      const request = baseRequest({ requestId });
      const dispatch = remote.dispatch(request);
      const work = remote.claim(HOST);
      remote.acceptAck(HOST, {
        requestId,
        delivery: work.delivery,
        leaseId: work.leaseId,
      });
      const result = {
        requestId,
        text,
        sessionId: null,
        ms: 1,
        fresh: true,
      };
      remote.acceptEvent(
        HOST,
        requestId,
        work.delivery,
        work.leaseId,
        runnerLifecycleEvent(requestId, 1, "completed", result),
      );
      remote.acceptResult(HOST, requestId, work.delivery, work.leaseId, result);
      await expect(dispatch).resolves.toEqual(result);
      return remote.requests.get(requestId);
    };

    const first = await complete("terminal-cache-first", "a".repeat(300));
    expect(first.payloadBytes).toBeGreaterThan(first.eventBytes);
    expect(remote.cachedPayloadBytes).toBe(first.payloadBytes);

    const second = await complete("terminal-cache-second", "b".repeat(300));
    expect(remote.requests.has("terminal-cache-first")).toBe(false);
    expect(remote.requests.get("terminal-cache-second")).toBe(second);
    expect(second.payloadBytes).toBeGreaterThan(second.eventBytes);
    expect(remote.cachedPayloadBytes).toBe(second.payloadBytes);
    expect(remote.cachedPayloadBytes).toBeLessThanOrEqual(4_096);
    expect(remote.requestLedger.get("terminal-cache-first").state).toBe("completed");

    const tightEnvironment = makeRoot("agentos-remote-tight-cache-");
    const requestId = "terminal-cache-cold-only";
    const tightRequest = baseRequest({ requestId });
    const result = {
      requestId,
      text: "c".repeat(800),
      sessionId: null,
      ms: 1,
      fresh: true,
    };
    const terminalEvent = runnerLifecycleEvent(requestId, 1, "completed", result);
    const requestBytes = Buffer.byteLength(JSON.stringify(tightRequest));
    const resultBytes = Buffer.byteLength(JSON.stringify(result));
    const eventBytes = Buffer.byteLength(JSON.stringify(terminalEvent));
    const reservedBytes = remote.syntheticTerminalReserveBytes(requestId);
    expect(resultBytes).toBeGreaterThan(reservedBytes);
    const tightCachedPayloadBytes = requestBytes + reservedBytes + eventBytes;
    const tightRemote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(tightEnvironment),
      pollTimeoutMs: 10,
      maxEventBytes: eventBytes,
      maxRequestEventBytes: eventBytes,
      maxCachedPayloadBytes: tightCachedPayloadBytes,
    });
    cleanups.push(async () => {
      await tightRemote.close();
      rmSync(tightEnvironment.root, { recursive: true, force: true });
    });
    const dispatch = tightRemote.dispatch(tightRequest);
    const work = tightRemote.claim(HOST);
    tightRemote.acceptAck(HOST, {
      requestId,
      delivery: work.delivery,
      leaseId: work.leaseId,
    });
    tightRemote.acceptEvent(HOST, requestId, work.delivery, work.leaseId, terminalEvent);
    expect(tightRemote.cachedPayloadBytes).toBe(tightCachedPayloadBytes);
    tightRemote.acceptResult(HOST, requestId, work.delivery, work.leaseId, result);
    await expect(dispatch).resolves.toEqual(result);
    expect(tightRemote.requests.has(requestId)).toBe(false);
    expect(tightRemote.cachedPayloadBytes).toBe(0);
    expect(tightRemote.requestLedger.get(requestId)).toMatchObject({
      requestId,
      state: "completed",
      result,
    });
  });

  it("越界 event gap 立即终止 request 并清空 buffer，不允许单请求无界占用内存", async () => {
    const environment = makeRoot();
    const remote = new RemoteRunner({
      token: TOKEN,
      hostId: HOST,
      placementStore: placementStore(environment),
      pollTimeoutMs: 10,
      leaseMs: 100,
      maxEventsPerRequest: 4,
      maxEventGap: 2,
    });
    const request = baseRequest({ requestId: "event-gap-limit" });
    const dispatch = remote.dispatch(request);
    void dispatch.catch(() => {});
    const work = remote.claim(HOST);
    remote.acceptAck(HOST, {
      requestId: request.requestId,
      delivery: work.delivery,
      leaseId: work.leaseId,
    });
    expect(() =>
      remote.acceptEvent(HOST, request.requestId, work.delivery, work.leaseId, {
        requestId: request.requestId,
        sequence: 100,
        at: new Date().toISOString(),
        kind: "progress",
        label: "malicious gap",
      }),
    ).toThrowError(expect.objectContaining({ status: 413 }));
    await expect(dispatch).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.INTERNAL, retryable: false },
    });
    const record = remote.requests.get(request.requestId);
    expect(record.bufferedEvents.size).toBe(0);
    expect(record.events).toHaveLength(1);
    expect(record.events[0].kind).toBe("failed");
    await remote.close();
    rmSync(environment.root, { recursive: true, force: true });
  });
});
