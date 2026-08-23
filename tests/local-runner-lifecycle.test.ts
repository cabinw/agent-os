import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import { Adapter } from "../apps/chat-spike/src/adapters/base.mjs";
// @ts-expect-error
import {
  RUNNER_ERROR_CODES,
  RunnerDispatchError,
  validateDispatchRequest,
} from "../apps/chat-spike/src/runners/contract.mjs";
// @ts-expect-error
import { LocalRunner } from "../apps/chat-spike/src/runners/local.mjs";
// @ts-expect-error
import { RequestStore } from "../apps/chat-spike/src/runners/request-store.mjs";
// @ts-expect-error
import { SessionStore } from "../apps/chat-spike/src/runners/session-store.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function environment() {
  const root = mkdtempSync(join(tmpdir(), "agentos-runner-lifecycle-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspaces");
  mkdirSync(join(workspaceRoot, "project-a"), { recursive: true });
  const sessionPath = join(root, "state", "sessions.json");
  const requestPath = `${sessionPath}.requests.json`;
  return { root, workspaceRoot, sessionPath, requestPath };
}

function request(requestId: string, prompt = "normal") {
  return {
    requestId,
    user: "user-1",
    project: "project-1",
    agent: "agent-1",
    adapter: "fixture",
    workspace: "project-a",
    prompt,
    taskId: "TASK-LIFECYCLE",
    causedBy: "evt_lifecycle",
  };
}

class FastAdapter extends Adapter {
  static id = "fixture";
  static label = "Fast fixture";
  static capabilities = {
    streaming: false,
    thoughts: false,
    session: true,
    usage: false,
  };
  static executions = 0;

  async send() {
    FastAdapter.executions++;
    const fresh = !this.hasSession;
    this._sessionId ??= "fixture-session";
    return {
      text: "done",
      sessionId: this._sessionId,
      ms: 1,
      fresh,
    };
  }
}

class FaultRequestStore extends RequestStore {
  failures = 0;
  failAll = false;

  failNext(count = 1) {
    this.failures += count;
  }

  persist(records: Map<string, unknown>) {
    if (this.failAll || this.failures > 0) {
      if (this.failures > 0) this.failures--;
      throw new Error("injected request-store failure");
    }
    return super.persist(records);
  }
}

function makeRunner(
  target: ReturnType<typeof environment>,
  requestStore: InstanceType<typeof RequestStore>,
  AdapterClass: typeof FastAdapter = FastAdapter,
) {
  return new LocalRunner({
    workspaceRoot: target.workspaceRoot,
    sessionStore: new SessionStore(target.sessionPath),
    requestStore,
    getAdapter: (id: string) => (id === "fixture" ? AdapterClass : null),
    hostId: "lifecycle-host",
  });
}

function blockingAdapterFixture() {
  let startedResolve: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let cancellations = 0;

  class BlockingAdapter extends FastAdapter {
    async send(_prompt: string, { signal }: { signal?: AbortSignal } = {}) {
      FastAdapter.executions++;
      startedResolve();
      return new Promise<never>((_resolve, reject) => {
        const abort = () => {
          cancellations++;
          reject(signal?.reason ?? new Error("cancelled"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }

  return { AdapterClass: BlockingAdapter, started, cancellations: () => cancellations };
}

describe("LocalRunner durable lifecycle", () => {
  it("RequestStore 写失败使用 copy-on-write，不留下幽灵 requestId", () => {
    const target = environment();
    const store = new FaultRequestStore(target.requestPath);
    const fingerprint = "a".repeat(64);
    const first = store.create("request-1", fingerprint);
    store.failAll = true;

    expect(() => store.put({ ...first, state: "running" })).toThrow(
      "injected request-store failure",
    );
    expect(() => store.create("request-2", "b".repeat(64))).toThrow(
      "injected request-store failure",
    );
    expect(store.entries()).toEqual([first]);
  });

  it("重启把未决 ledger 固化为 UNAVAILABLE，且 ledger 不保存 prompt 明文", async () => {
    const target = environment();
    const value = request("indeterminate", "top-secret-prompt");
    const normalized = validateDispatchRequest(value);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex");
    const store = new RequestStore(target.requestPath);
    const queued = store.create(value.requestId, fingerprint);
    store.put({ ...queued, state: "running" });

    expect(readFileSync(target.requestPath, "utf8")).not.toContain(value.prompt);
    FastAdapter.executions = 0;
    const runner = makeRunner(target, new RequestStore(target.requestPath));
    const events: Array<{ kind: string; error?: { code: string } }> = [];
    await expect(
      runner.dispatch(value, {
        onEvent: (event: (typeof events)[number]) => events.push(event),
      }),
    ).rejects.toMatchObject({
      error: {
        requestId: value.requestId,
        code: RUNNER_ERROR_CODES.UNAVAILABLE,
        retryable: true,
      },
    });
    expect(events.map((event) => event.kind)).toEqual(["failed"]);
    expect(FastAdapter.executions).toBe(0);
    expect(() => runner.dispatch({ ...value, prompt: "different" })).toThrow(
      RunnerDispatchError,
    );
    await runner.close();
  });

  it("执行中持久化瞬时失败会确定拒绝，不悬挂也不静默重跑", async () => {
    const target = environment();
    const store = new FaultRequestStore(target.requestPath);
    const runner = makeRunner(target, store);
    const events: Array<{ kind: string; error?: { code: string } }> = [];

    const execution = runner.dispatch(request("persist-on-run"), {
      onEvent: (event: (typeof events)[number]) => events.push(event),
    });
    store.failNext();
    await expect(execution).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.UNAVAILABLE, retryable: true },
    });
    expect(events.map((event) => event.kind)).toEqual(["failed"]);
    expect(store.entries()).toEqual([expect.objectContaining({ state: "unavailable" })]);
    await runner.close();
  });

  it("cancel 持久化失败仍中断 adapter，cancel 与 dispatch 都确定拒绝", async () => {
    const target = environment();
    const store = new FaultRequestStore(target.requestPath);
    const fixture = blockingAdapterFixture();
    const runner = makeRunner(target, store, fixture.AdapterClass);
    const execution = runner.dispatch(request("persist-on-cancel", "block"));
    const rejected = execution.catch((error: unknown) => error);
    await fixture.started;
    store.failAll = true;

    await expect(runner.cancel("persist-on-cancel")).rejects.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.UNAVAILABLE, retryable: true },
    });
    await expect(rejected).resolves.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.UNAVAILABLE, retryable: true },
    });
    expect(fixture.cancellations()).toBe(1);
    await runner.close();
  });

  it("close 在 cancel ledger 失败时仍等待清理并幂等返回", async () => {
    const target = environment();
    const store = new FaultRequestStore(target.requestPath);
    const fixture = blockingAdapterFixture();
    const runner = makeRunner(target, store, fixture.AdapterClass);
    const execution = runner.dispatch(request("persist-on-close", "block"));
    const rejected = execution.catch((error: unknown) => error);
    await fixture.started;
    store.failAll = true;

    await Promise.all([runner.close(), runner.close()]);
    await expect(rejected).resolves.toMatchObject({
      error: { code: RUNNER_ERROR_CODES.UNAVAILABLE, retryable: true },
    });
    expect(fixture.cancellations()).toBe(1);
    expect(runner.health()).toEqual({
      ready: false,
      hostId: "lifecycle-host",
      inflight: 0,
      queued: 0,
    });
  });
});
