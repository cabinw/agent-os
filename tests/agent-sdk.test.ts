import { describe, expect, it, vi } from "vitest";
import {
  AdapterExecutionError,
  AgentClientError,
  AgentSdkContractError,
  JsonLineSubprocessAdapter,
  createAdapterCatalog,
  createAgentClient,
  parseAdapterDescriptor,
  parseAdapterResult,
  parseRunnerDispatchRequest,
  parseRunnerObservation,
  sanitizeAdapterEnvironment,
} from "../packages/agent-sdk/src/index.js";
import type {
  AbortSignalLike,
  AdapterDescriptor,
  AdapterScheduler,
  ProcessCommand,
  ProcessExit,
  ProcessSpawner,
  SpawnedProcess,
} from "../packages/agent-sdk/src/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class FakeProcess implements SpawnedProcess {
  readonly completion = deferred<ProcessExit>();
  readonly stdout = new Set<(chunk: string) => void>();
  readonly stderr = new Set<(chunk: string) => void>();
  kills = 0;
  onStdout(listener: (chunk: string) => void) {
    this.stdout.add(listener);
    return () => this.stdout.delete(listener);
  }
  onStderr(listener: (chunk: string) => void) {
    this.stderr.add(listener);
    return () => this.stderr.delete(listener);
  }
  wait() {
    return this.completion.promise;
  }
  kill() {
    this.kills += 1;
  }
  out(chunk: string) {
    for (const listener of this.stdout) listener(chunk);
  }
  err(chunk: string) {
    for (const listener of this.stderr) listener(chunk);
  }
  exit(code: number | null, signal?: string) {
    this.completion.resolve({ code, ...(signal ? { signal } : {}) });
  }
}

class FakeSpawner implements ProcessSpawner {
  readonly commands: ProcessCommand[] = [];
  readonly processes: FakeProcess[] = [];
  spawn(command: ProcessCommand) {
    this.commands.push(command);
    const process = new FakeProcess();
    this.processes.push(process);
    return process;
  }
}

class ManualScheduler implements AdapterScheduler {
  readonly callbacks = new Map<number, () => void>();
  readonly cancelled: number[] = [];
  #next = 1;
  schedule(callback: () => void) {
    const id = this.#next++;
    this.callbacks.set(id, callback);
    return id;
  }
  cancel(handle: unknown) {
    const id = handle as number;
    this.cancelled.push(id);
    this.callbacks.delete(id);
  }
  fire(id = 1) {
    const callback = this.callbacks.get(id);
    if (!callback) throw new Error("missing timer");
    this.callbacks.delete(id);
    callback();
  }
}

class ManualSignal implements AbortSignalLike {
  aborted = false;
  reason: unknown;
  readonly listeners = new Set<() => void>();
  addEventListener(_type: "abort", listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "abort", listener: () => void) {
    this.listeners.delete(listener);
  }
  abort(reason?: unknown) {
    this.aborted = true;
    this.reason = reason;
    for (const listener of this.listeners) listener();
  }
}

const descriptor = (id: string): AdapterDescriptor => ({
  id,
  label: id.toUpperCase(),
  integration: {
    participates: true,
    streaming: true,
    reasoning: false,
    session: true,
    usage: true,
  },
});

function harness(id = "alpha", overrides: Record<string, unknown> = {}) {
  const spawner = new FakeSpawner();
  const scheduler = new ManualScheduler();
  let now = 100;
  const adapter = new JsonLineSubprocessAdapter({
    descriptor: descriptor(id),
    spawner,
    scheduler,
    timeoutMs: 5_000,
    now: () => {
      now += 10;
      return now;
    },
    environment: { PATH: "/bin", AGENT_OS_ADMIN_TOKEN: "must-strip" },
    buildCommand: (invocation) => ({
      executable: id,
      args: ["--prompt", invocation.prompt],
    }),
    interpretLine: (value) => {
      const line = value as Record<string, unknown>;
      if (line.type === "text")
        return {
          text: String(line.data ?? ""),
          observations: [{ kind: "delta", text: String(line.data ?? "") }],
        };
      if (line.type === "end") return { sessionId: String(line.session ?? "") };
      return undefined;
    },
    ...overrides,
  });
  return { adapter, scheduler, spawner };
}

describe("RM-1.4a · strict Agent SDK contracts", () => {
  it("strictly parses and freezes dispatch requests", () => {
    const request = parseRunnerDispatchRequest({
      requestId: "req-1",
      user: "owner",
      project: "proj",
      agent: "agent",
      adapter: "alpha",
      workspace: "/work",
      prompt: "test",
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(() =>
      parseRunnerDispatchRequest({ ...request, providerSecret: "leak" }),
    ).toThrow(AgentSdkContractError);
    expect(() => parseRunnerDispatchRequest({ ...request, prompt: " " })).toThrow(
      AgentSdkContractError,
    );
  });

  it("strictly parses normalized observations and results", () => {
    expect(
      parseRunnerObservation({ kind: "usage", input: 1, output: 2, total: 3 }),
    ).toEqual({ kind: "usage", input: 1, output: 2, total: 3 });
    expect(
      parseAdapterResult({ text: "ok", sessionId: null, durationMs: 4, fresh: true }),
    ).toEqual({ text: "ok", sessionId: null, durationMs: 4, fresh: true });
    expect(() =>
      parseRunnerObservation({ kind: "delta", text: "x", vendorOnly: true }),
    ).toThrow(AgentSdkContractError);
    expect(() =>
      parseAdapterResult({
        text: "ok",
        sessionId: null,
        durationMs: Number.NaN,
        fresh: true,
      }),
    ).toThrow(AgentSdkContractError);
  });

  it("validates descriptors and rejects duplicate adapter ids", () => {
    expect(parseAdapterDescriptor(descriptor("alpha"))).toEqual(descriptor("alpha"));
    const first = harness().adapter;
    expect(createAdapterCatalog([first]).describe()).toEqual([descriptor("alpha")]);
    expect(() => createAdapterCatalog([first, harness().adapter])).toThrow(
      "duplicate adapter",
    );
  });

  it("exposes named MCP operations without sendEvent or approval decisions", async () => {
    const call = vi.fn(async (tool: string) => tool);
    const client = createAgentClient({ call });
    await expect(client.register({ id: "agent" })).resolves.toBe("register_agent");
    await expect(client.reportProgress({ task: "TASK-001" })).resolves.toBe(
      "update_task",
    );
    await expect(client.openNegotiation({ negotiation: "N-001" })).resolves.toBe(
      "open_negotiation",
    );
    await expect(client.objectNegotiation({ negotiation: "N-001" })).resolves.toBe(
      "object_negotiation",
    );
    await expect(client.escalateNegotiation({ negotiation: "N-001" })).resolves.toBe(
      "escalate_negotiation",
    );
    await expect(client.resolveNegotiation({ negotiation: "N-001" })).resolves.toBe(
      "resolve_negotiation",
    );
    expect(Object.keys(client).sort()).toEqual([
      "call",
      "close",
      "escalateNegotiation",
      "objectNegotiation",
      "openNegotiation",
      "register",
      "reportProgress",
      "reportResult",
      "requestApproval",
      "resolveNegotiation",
      "sendMessage",
    ]);
    await expect(client.call("write_event" as never, {})).rejects.toBeInstanceOf(
      AgentClientError,
    );
    client.close();
    await expect(client.sendMessage({})).rejects.toMatchObject({ code: "CLOSED" });
  });
});

describe("RM-1.4a · JSONL subprocess adapter", () => {
  it("runs two vendor line shapes through the same core task", async () => {
    const alpha = harness("alpha");
    const beta = harness("beta", {
      interpretLine: (value: unknown) => {
        const line = value as Record<string, unknown>;
        if (line.role === "assistant") return { text: String(line.content) };
        if (line.role === "meta") return { sessionId: String(line.id) };
        return undefined;
      },
    });
    const first = alpha.adapter.send({ prompt: "same task", workspace: "/work" });
    alpha.spawner.processes[0]?.out(
      '{"type":"text","data":"answer"}\n{"type":"end","session":"s1"}\n',
    );
    alpha.spawner.processes[0]?.exit(0);
    const second = beta.adapter.send({ prompt: "same task", workspace: "/work" });
    beta.spawner.processes[0]?.out(
      '{"role":"assistant","content":"answer"}\n{"role":"meta","id":"s2"}\n',
    );
    beta.spawner.processes[0]?.exit(0);
    expect((await first).text).toBe("answer");
    expect((await second).text).toBe("answer");
    expect(alpha.spawner.commands[0]?.args).toEqual(["--prompt", "same task"]);
    expect(beta.spawner.commands[0]?.args).toEqual(["--prompt", "same task"]);
  });

  it("mounts only scoped MCP credentials and preserves opaque session", async () => {
    const { adapter, spawner } = harness();
    const waiting = adapter.send({
      prompt: "resume",
      workspace: "/work",
      sessionId: "old",
      mcp: {
        args: ["--mcp"],
        env: { AGENT_OS_URL: "https://hub", AGENT_OS_TOKEN: "scoped" },
      },
    });
    expect(spawner.commands[0]).toMatchObject({
      args: ["--prompt", "resume", "--mcp"],
      env: { PATH: "/bin", AGENT_OS_URL: "https://hub", AGENT_OS_TOKEN: "scoped" },
    });
    expect(JSON.stringify(spawner.commands[0])).not.toContain("ADMIN");
    spawner.processes[0]?.out('{"type":"text","data":"ok"}\n');
    spawner.processes[0]?.exit(0);
    await expect(waiting).resolves.toMatchObject({ sessionId: "old", fresh: false });
  });

  it("normalizes observations and rejects vendor-only event fields", async () => {
    const events: unknown[] = [];
    const good = harness();
    const waiting = good.adapter.send(
      { prompt: "stream", workspace: "/work" },
      { emit: (event) => events.push(event) },
    );
    good.spawner.processes[0]?.out('{"type":"text","data":"chunk"}\n');
    good.spawner.processes[0]?.exit(0);
    await waiting;
    expect(events).toEqual([{ kind: "delta", text: "chunk" }]);

    const bad = harness("bad", {
      interpretLine: () => ({
        observations: [{ kind: "delta", text: "x", vendorOnly: true }],
      }),
    });
    const rejected = bad.adapter.send({ prompt: "bad", workspace: "/work" });
    bad.spawner.processes[0]?.out("{}\n");
    bad.spawner.processes[0]?.exit(0);
    await expect(rejected).rejects.toMatchObject({ code: "PROTOCOL" });
  });

  it("enforces one active invocation", async () => {
    const { adapter, spawner } = harness();
    const first = adapter.send({ prompt: "one", workspace: "/work" });
    await expect(
      adapter.send({ prompt: "two", workspace: "/work" }),
    ).rejects.toMatchObject({ code: "BUSY" });
    spawner.processes[0]?.exit(0);
    await first;
  });

  it("fails closed on absolute timeout and in-flight abort", async () => {
    const timed = harness();
    const timeout = timed.adapter.send({ prompt: "hang", workspace: "/work" });
    timed.scheduler.fire();
    await expect(timeout).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(timed.spawner.processes[0]?.kills).toBe(1);

    const aborted = harness();
    const signal = new ManualSignal();
    const waiting = aborted.adapter.send(
      { prompt: "hang", workspace: "/work" },
      { signal },
    );
    signal.abort();
    await expect(waiting).rejects.toMatchObject({ code: "CANCELLED" });
    expect(aborted.spawner.processes[0]?.kills).toBe(1);
  });

  it("cancel and close settle callers even when the process never exits", async () => {
    const first = harness();
    const waiting = first.adapter.send({ prompt: "hang", workspace: "/work" });
    await first.adapter.cancel();
    await expect(waiting).rejects.toMatchObject({ code: "CANCELLED" });

    const second = harness();
    const closing = second.adapter.send({ prompt: "hang", workspace: "/work" });
    await second.adapter.close();
    await expect(closing).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(
      second.adapter.send({ prompt: "later", workspace: "/work" }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("bounds protocol lines and stderr in process failures", async () => {
    const protocol = harness("small", { maxLineBytes: 8 });
    const tooLarge = protocol.adapter.send({ prompt: "bad", workspace: "/work" });
    protocol.spawner.processes[0]?.out("123456789");
    await expect(tooLarge).rejects.toMatchObject({ code: "PROTOCOL" });

    const failed = harness("failed", { maxStderrBytes: 6 });
    const exit = failed.adapter.send({ prompt: "bad", workspace: "/work" });
    failed.spawner.processes[0]?.err("secret-long-error");
    failed.spawner.processes[0]?.exit(7);
    await expect(exit).rejects.toMatchObject({
      code: "PROCESS_FAILED",
      message: expect.not.stringContaining("long-error"),
    });
  });

  it("rejects forged control-plane environment variables", () => {
    expect(
      sanitizeAdapterEnvironment({ AGENT_OS_ROOT_TOKEN: "drop", PATH: "/bin" }),
    ).toEqual({ PATH: "/bin" });
    expect(() =>
      sanitizeAdapterEnvironment({}, { AGENT_OS_ADMIN_TOKEN: "forged" }),
    ).toThrow(AdapterExecutionError);
  });
});
