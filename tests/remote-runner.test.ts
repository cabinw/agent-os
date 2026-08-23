import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
  RemoteAuthenticationError,
  RemotePlacementStore,
  RemoteRequestLedger,
  RemoteRunner,
  RemoteRunnerWorker,
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
    let active = 0;
    let peak = 0;
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
      maxCompletedRequests: 2,
    });
    const { server, url } = await serve(remote);
    const worker = new RemoteRunnerWorker({
      url,
      token: TOKEN,
      hostId: HOST,
      runner: local,
      reconnectDelayMs: 2,
      maxConcurrentDispatches: 2,
      maxCompleted: 2,
    }).start();
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
    expect(worker.executions.size).toBeLessThanOrEqual(2);

    const replayEvents: RunnerEvent[] = [];
    await expect(
      remote.dispatch(requests[0], {
        onEvent: (event: RunnerEvent) => replayEvents.push(event),
      }),
    ).resolves.toMatchObject({ text: "bounded-result" });
    expect(replayEvents.map((event) => event.kind)).toEqual(["started", "completed"]);
    expect(executions).toBe(requests.length);
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
