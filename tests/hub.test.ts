import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import { Hub } from "../apps/chat-spike/src/hub.mjs";
// @ts-expect-error
import { EventLog } from "../apps/chat-spike/src/log.mjs";
// @ts-expect-error
import { RUNNER_INTERFACE_METHODS } from "../apps/chat-spike/src/runners/contract.mjs";
// @ts-expect-error
import { project } from "../apps/chat-spike/src/thread.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type FakeSend = (
  prompt: string,
  turn: number,
) => string | undefined | Promise<string | undefined>;

interface TestEvent {
  id: string;
  seq: number;
  type: string;
  actor: { kind: string };
  payload: Record<string, unknown>;
  causedBy?: string;
}

interface TestEventLog {
  replay: () => TestEvent[];
}

interface TestHub {
  agents: Map<string, { queue: Promise<unknown> }>;
  tools: {
    call: (
      name: string,
      args: Record<string, unknown>,
      caller?: string | null,
    ) => Promise<unknown>;
  };
  accept: (task: string) => void;
  depthOf: (event: string) => number;
  register: (
    id: string,
    profile: { id: string; role?: string; capabilities?: string[] },
  ) => void;
  roster: () => Array<{ hasSession: boolean }>;
  resetSession: (agent: string) => Promise<void>;
  say: (content: string, to: string) => void;
  tasks: () => Record<string, { executor: string | null; status: string }>;
}

type FakeAdapterClass = new (options: { mcp?: unknown }) => {
  hasSession: boolean;
  resetSession: () => void;
  send: (prompt: string) => Promise<{ text: string; ms: number; fresh: boolean }>;
  close: () => Promise<void>;
};

type RunnerRequest = {
  requestId: string;
  user: string;
  project: string;
  agent: string;
  adapter: string;
  workspace: string;
  prompt: string;
};

/**
 * Trusted test double for the execution plane. Hub tests exercise routing and
 * policy; this boundary owns every fake adapter instance just as LocalRunner
 * owns real vendor adapters in production.
 */
class TrustedFakeRunner {
  readonly definitions: Record<string, { Fake: FakeAdapterClass }>;
  readonly instances = new Map<string, InstanceType<FakeAdapterClass>>();
  readonly dispatches: RunnerRequest[] = [];
  readonly resets: Array<{ user: string; project: string; agent: string }> = [];

  constructor(definitions: Record<string, { Fake: unknown }>) {
    this.definitions = definitions as Record<string, { Fake: FakeAdapterClass }>;
  }

  async dispatch(request: RunnerRequest) {
    this.dispatches.push(request);
    let instance = this.instances.get(request.agent);
    if (!instance) {
      const Adapter = this.definitions[request.adapter]?.Fake;
      if (!Adapter) throw new Error(`FakeRunner 找不到 adapter ${request.adapter}`);
      instance = new Adapter({});
      this.instances.set(request.agent, instance);
    }
    return instance.send(request.prompt);
  }

  hasSession(scope: { agent: string }) {
    return this.instances.get(scope.agent)?.hasSession ?? false;
  }

  async resetSession(scope: { user: string; project: string; agent: string }) {
    this.resets.push(scope);
    this.instances.get(scope.agent)?.resetSession();
  }

  async cancel(requestId: string) {
    return { requestId, outcome: "not_found" };
  }

  health() {
    return { ready: true, hostId: "trusted-fake", inflight: 0, queued: 0 };
  }

  async close() {
    await Promise.all([...this.instances.values()].map((adapter) => adapter.close()));
  }
}

/** Give adapter callbacks access to a hub that is constructed after them. */
function hubReference() {
  let value: TestHub | undefined;
  return {
    get(): TestHub {
      if (!value) throw new Error("hub reference used before initialization");
      return value;
    },
    set(hub: TestHub): void {
      value = hub;
    },
  };
}

/**
 * A fake vendor: no process, no network. What is under test is the seam — who
 * gets woken, in what order, and when the runtime stops — not whether a CLI
 * answers. Each adapter records the prompts it was handed and can be told to
 * reply with a `send_message` of its own.
 */
function fakeAdapter(id: string, label: string, opts: { onSend?: FakeSend } = {}) {
  const prompts: string[] = [];
  class Fake {
    static id = id;
    static label = label;
    static capabilities = {
      streaming: false,
      thoughts: false,
      session: true,
      usage: false,
    };
    _sessionId: string | null = null;
    mcp: unknown;
    constructor(o: { mcp?: unknown }) {
      this.mcp = o.mcp;
    }
    get hasSession() {
      return this._sessionId !== null;
    }
    resetSession() {
      this._sessionId = null;
    }
    async send(prompt: string) {
      prompts.push(prompt);
      this._sessionId = "s1";
      const text = await opts.onSend?.(prompt, prompts.length);
      return { text: text ?? `${label} 回复 ${prompts.length}`, ms: 1, fresh: false };
    }
    async close() {}
  }
  return { Fake, prompts };
}

function makeHub(
  adapters: Record<string, { Fake: unknown }>,
  roster: Array<{ id: string; role?: string; capabilities?: string[] }>,
  budget?: number,
) {
  const dir = mkdtempSync(join(tmpdir(), "agentos-hub-"));
  dirs.push(dir);
  const log = new EventLog(join(dir, "events.jsonl")) as TestEventLog;
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const runner = new TrustedFakeRunner(adapters);
  const hub = new Hub({
    log,
    projectId: "proj_test",
    broadcast: (type: string, data: Record<string, unknown>) =>
      events.push({ type, data }),
    getAdapter: (id: string) => adapters[id]?.Fake,
    budget,
    runner,
  }) as TestHub;
  for (const a of roster) hub.register(a.id, a);
  return { hub, log, events, runner };
}

/** Turns are queued, so a test has to wait for the chain to settle. */
async function settle(hub: { agents: Map<string, { queue: Promise<unknown> }> }) {
  for (let i = 0; i < 20; i++) {
    await Promise.all([...hub.agents.values()].map((a) => a.queue));
    await new Promise((r) => setImmediate(r));
  }
}

function messages(log: TestEventLog) {
  return log
    .replay()
    .filter((e) => e.type === "message.sent")
    .map((e) => `${e.payload.from}→${e.payload.to}: ${e.payload.content}`);
}

describe("Hub Runner 边界", () => {
  const baseOptions = () => ({
    log: { replay: () => [] },
    projectId: "proj_runner_boundary",
    broadcast: () => {},
    getAdapter: () => null,
  });

  it("缺少 Runner 或任一共享接口方法都会在构造时失败", () => {
    expect(() => new Hub(baseOptions())).toThrow(/Hub\.runner/);

    const complete = new TrustedFakeRunner({});
    const missing = RUNNER_INTERFACE_METHODS.at(-1) as string;
    const incomplete = new Proxy(complete, {
      get(target, property, receiver) {
        if (property === missing) return undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => new Hub({ ...baseOptions(), runner: incomplete })).toThrow(missing);
  });

  it("execute 和 reset 只调用 Runner，Hub 不实例化或保存 vendor adapter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentos-hub-runner-only-"));
    dirs.push(dir);
    const dispatches: RunnerRequest[] = [];
    const resets: Array<{ user: string; project: string; agent: string }> = [];
    const methods = Object.fromEntries(
      RUNNER_INTERFACE_METHODS.map((method: string) => [method, async () => undefined]),
    ) as Record<string, (...args: never[]) => unknown>;
    methods.dispatch = async (request: RunnerRequest) => {
      dispatches.push(request);
      return { text: "runner-only", ms: 1, fresh: true };
    };
    methods.hasSession = () => false;
    methods.resetSession = async (scope: {
      user: string;
      project: string;
      agent: string;
    }) => {
      resets.push(scope);
    };
    methods.health = () => ({
      ready: true,
      hostId: "runner-only",
      inflight: 0,
      queued: 0,
    });

    class CatalogOnlyAdapter {
      static id = "alpha";
      static label = "Alpha";
      static capabilities = {};
      constructor() {
        throw new Error("Hub 不得实例化 catalog adapter");
      }
    }

    const hub = new Hub({
      log: new EventLog(join(dir, "events.jsonl")),
      projectId: "proj_runner_only",
      broadcast: () => {},
      getAdapter: (id: string) => (id === "alpha" ? CatalogOnlyAdapter : null),
      runner: methods,
      userId: "owner",
    }) as TestHub;
    hub.register("alpha");
    hub.say("必须走 Runner", "alpha");
    await settle(hub);
    await hub.resetSession("alpha");

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      user: "owner",
      project: "proj_runner_only",
      agent: "alpha",
      adapter: "alpha",
      workspace: "alpha",
    });
    expect(resets).toEqual([
      { user: "owner", project: "proj_runner_only", agent: "alpha" },
    ]);
    expect(hub).not.toHaveProperty("adapterFor");
    expect(hub).not.toHaveProperty("workspace");
    expect(hub.agents.get("alpha")).not.toHaveProperty("adapter");
  });
});

describe("A.1 适配器池", () => {
  it("多个 agent 各自持有会话，互不影响", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const b = fakeAdapter("beta", "Beta");
    const { hub } = makeHub({ alpha: a, beta: b }, [{ id: "alpha" }, { id: "beta" }]);

    hub.say("给 alpha", "alpha");
    hub.say("给 beta", "beta");
    await settle(hub);

    expect(a.prompts).toHaveLength(1);
    expect(b.prompts).toHaveLength(1);
    expect(
      hub.roster().filter((r: { hasSession: boolean }) => r.hasSession),
    ).toHaveLength(2);
  });

  it("同一个 agent 的两条消息串行，不并发", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const a = fakeAdapter("alpha", "Alpha", {
      onSend: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return "ok";
      },
    });
    const { hub } = makeHub({ alpha: a }, [{ id: "alpha" }]);

    hub.say("一", "alpha");
    hub.say("二", "alpha");
    await settle(hub);

    expect(a.prompts).toHaveLength(2);
    expect(maxInFlight).toBe(1);
  });

  it("并发写入下 seq 仍然单调无洞", async () => {
    const slow = { onSend: async () => "ok" };
    const a = fakeAdapter("alpha", "Alpha", slow);
    const b = fakeAdapter("beta", "Beta", slow);
    const { hub, log } = makeHub({ alpha: a, beta: b }, [
      { id: "alpha" },
      { id: "beta" },
    ]);

    for (let i = 0; i < 5; i++) {
      hub.say(`a${i}`, "alpha");
      hub.say(`b${i}`, "beta");
    }
    await settle(hub);

    const seqs = log.replay().map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual(seqs.map((_: number, i: number) => i + 1));
  });
});

/** The whole reason the hub exists. */
describe("B.1 接缝：消息路由触发唤醒", () => {
  it("agent A 发给 agent B，B 被叫醒——人没有参与", async () => {
    const hubRef = hubReference();
    // Alpha delegates instead of answering; beta reports to the human so the
    // exchange terminates. Replying to the sender by default is correct — it is
    // also how a two-agent ping-pong starts, which B.2 covers.
    const a = fakeAdapter("alpha", "Alpha", {
      onSend: async () => {
        await hubRef
          .get()
          .tools.call(
            "send_message",
            { from: "alpha", to: "beta", type: "instruction", content: "帮我查一下" },
            "alpha",
          );
        return "";
      },
    });
    const b = fakeAdapter("beta", "Beta", {
      onSend: async () => {
        await hubRef
          .get()
          .tools.call(
            "send_message",
            { from: "beta", to: "you", type: "answer", content: "查完了" },
            "beta",
          );
        return "";
      },
    });
    const made = makeHub({ alpha: a, beta: b }, [{ id: "alpha" }, { id: "beta" }]);
    const hub = made.hub;
    hubRef.set(hub);

    // The human only ever speaks to alpha.
    hub.say("请找人帮忙", "alpha");
    await settle(hub);

    expect(b.prompts).toHaveLength(1);
    expect(b.prompts[0]).toContain("帮我查一下");
    // Identity is injected — beta must know which id to speak as.
    expect(b.prompts[0]).toContain('"beta"');
    expect(messages(made.log)).toContain("beta→you: 查完了");
  });

  it("被唤醒的 agent 拿到的是从日志重建的上下文，不是别人递过来的", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const b = fakeAdapter("beta", "Beta");
    const { hub } = makeHub({ alpha: a, beta: b }, [{ id: "alpha" }, { id: "beta" }]);

    hub.say("代号是青铜麋鹿", "alpha");
    await settle(hub);
    await hub.tools.call(
      "send_message",
      { from: "alpha", to: "beta", type: "question", content: "代号是什么？" },
      "alpha",
    );
    await settle(hub);

    // Beta never spoke to alpha, yet sees what alpha was told.
    expect(b.prompts[0]).toContain("青铜麋鹿");
  });

  it("发给未注册的收件人被拒绝，而不是静默丢弃", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const { hub } = makeHub({ alpha: a }, [{ id: "alpha" }]);
    await expect(
      hub.tools.call(
        "send_message",
        { from: "alpha", to: "ghost", type: "instruction", content: "在吗" },
        "alpha",
      ),
    ).rejects.toThrow(/未知收件人/);
  });

  it("agent 自己调了 send_message 就不再回显正文——一轮只说一次话", async () => {
    const hubRef = hubReference();
    const a = fakeAdapter("alpha", "Alpha", {
      onSend: async (p: string) => {
        if (p.includes("触发")) {
          await hubRef
            .get()
            .tools.call(
              "send_message",
              { from: "alpha", to: "you", type: "answer", content: "我自己说的" },
              "alpha",
            );
          return "这段不该出现";
        }
        return "ok";
      },
    });
    const made = makeHub({ alpha: a }, [{ id: "alpha" }]);
    const hub = made.hub;
    hubRef.set(hub);

    hub.say("触发", "alpha");
    await settle(hub);

    const said = messages(made.log);
    expect(said).toContain("alpha→you: 我自己说的");
    expect(said.join()).not.toContain("这段不该出现");
  });
});

describe("B.2 回环预算", () => {
  it("互相甩锅的循环会被停住，并且是向人报告", async () => {
    const hubRef = hubReference();
    // Two agents that reflexively hand the work back to each other.
    const bounce = (self: string, other: string) => ({
      onSend: async () => {
        await hubRef
          .get()
          .tools.call(
            "send_message",
            { from: self, to: other, type: "instruction", content: "你来" },
            self,
          );
        return "";
      },
    });
    const a = fakeAdapter("alpha", "Alpha", bounce("alpha", "beta"));
    const b = fakeAdapter("beta", "Beta", bounce("beta", "alpha"));
    const made = makeHub({ alpha: a, beta: b }, [{ id: "alpha" }, { id: "beta" }], 4);
    const hub = made.hub;
    hubRef.set(hub);

    hub.say("开始", "alpha");
    await settle(hub);

    expect(a.prompts.length + b.prompts.length).toBeLessThanOrEqual(5);
    expect(messages(made.log).join()).toMatch(/runtime→you.*停止继续唤醒/);
  });

  it("深度是从 causedBy 算出来的，不写进事件", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const { hub, log } = makeHub({ alpha: a }, [{ id: "alpha" }]);
    hub.say("一句话", "alpha");
    await settle(hub);

    const reply = log.replay().at(-1);
    expect(reply.payload).not.toHaveProperty("depth");
    expect(reply.payload).not.toHaveProperty("hops");
    expect(hub.depthOf(reply.id)).toBe(1);
  });
});

describe("注册幂等", () => {
  it("重复注册不再写一条 agent.registered——agent 真的会这么干", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const { hub, log } = makeHub({ alpha: a }, [{ id: "alpha" }]);

    const again = await hub.tools.call("register_agent", { id: "alpha", name: "Alpha" });
    expect(again).toMatchObject({ reconnected: true });
    expect(
      log.replay().filter((e: { type: string }) => e.type === "agent.registered"),
    ).toHaveLength(1);
  });

  it("自己注册的 agent 会进池子，之后能被别人回信唤醒", async () => {
    const hubRef = hubReference();
    const a = fakeAdapter("alpha", "Alpha");
    // Beta answers the human so the exchange terminates; replying to the sender
    // is the default, and that is a two-agent ping-pong by construction (B.2).
    const b = fakeAdapter("beta", "Beta", {
      onSend: async () => {
        await hubRef
          .get()
          .tools.call(
            "send_message",
            { from: "beta", to: "you", type: "answer", content: "在" },
            "beta",
          );
        return "";
      },
    });
    const made = makeHub({ alpha: a, beta: b }, [{ id: "alpha" }]);
    const hub = made.hub;
    hubRef.set(hub);

    await hub.tools.call("register_agent", {
      id: "beta",
      name: "Beta",
      capabilities: ["research"],
    });
    expect(hub.agents.has("beta")).toBe(true);

    await hub.tools.call(
      "send_message",
      { from: "alpha", to: "beta", type: "question", content: "在吗" },
      "alpha",
    );
    await settle(hub);
    expect(b.prompts).toHaveLength(1);
  });

  it("没有适配器的 id 注册被拒绝，而不是留下一个叫不醒的名字", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const { hub } = makeHub({ alpha: a }, [{ id: "alpha" }]);
    await expect(
      hub.tools.call("register_agent", { id: "ghost", name: "Ghost" }),
    ).rejects.toThrow(/没有.*适配器/);
  });
});

describe("B.3 按能力找人", () => {
  it("find_agent 按能力筛，返回候选而不是让调用方猜 id", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const b = fakeAdapter("beta", "Beta");
    const { hub } = makeHub({ alpha: a, beta: b }, [
      { id: "alpha", capabilities: ["coding"] },
      { id: "beta", capabilities: ["research", "writing"] },
    ]);

    const r = (await hub.tools.call("find_agent", { capabilities: ["research"] })) as {
      candidates: Array<{ id: string }>;
    };
    expect(r.candidates.map((c) => c.id)).toEqual(["beta"]);
  });

  it("候选里不含厂商名——路由只读能力（ADR-004）", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const { hub } = makeHub({ alpha: a }, [{ id: "alpha", capabilities: ["coding"] }]);
    const r = (await hub.tools.call("find_agent", {})) as { candidates: object[] };
    for (const c of r.candidates) {
      expect(Object.keys(c)).not.toContain("provider");
    }
  });

  it("available 过滤掉正忙的", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = fakeAdapter("alpha", "Alpha", {
      onSend: async () => {
        await gate;
        return "ok";
      },
    });
    const { hub } = makeHub({ alpha: a }, [{ id: "alpha", capabilities: ["coding"] }]);

    hub.say("忙起来", "alpha");
    await new Promise((r) => setImmediate(r));
    const busy = (await hub.tools.call("find_agent", { available: true })) as {
      matched: number;
    };
    expect(busy.matched).toBe(0);
    release();
    await settle(hub);
  });
});

/**
 * C — tasks. The point is not the state machine (Phase 1.2a owns that) but the
 * boundary: a task scopes a thread, and no argument an agent can send reaches
 * `completed`.
 */
describe("C 任务对象", () => {
  it("create_task 不带执行者；assign_task 才指派，并且唤醒他", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const { hub } = makeHub({ alpha: a }, [{ id: "alpha", capabilities: ["coding"] }]);

    const made = (await hub.tools.call("create_task", {
      title: "写个解析器",
      requires: ["coding"],
    })) as { task: string; status: string };
    expect(made.status).toBe("created");
    expect(hub.tasks()[made.task].executor).toBeNull();

    await hub.tools.call("assign_task", { task: made.task });
    await settle(hub);

    expect(hub.tasks()[made.task].executor).toBe("alpha");
    expect(a.prompts[0]).toContain(made.task);
    expect(a.prompts[0]).toContain("写个解析器");
  });

  it("不填 executor 时按能力匹配，匹配不到就拒绝而不是随便挑", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const { hub } = makeHub({ alpha: a }, [{ id: "alpha", capabilities: ["coding"] }]);
    const t = (await hub.tools.call("create_task", {
      title: "做份调研",
      requires: ["research"],
    })) as { task: string };
    await expect(hub.tools.call("assign_task", { task: t.task })).rejects.toThrow(
      /没有具备/,
    );
  });

  it("被指派后状态走 assigned → running，而且 started 是运行时发的", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const { hub, log } = makeHub({ alpha: a }, [
      { id: "alpha", capabilities: ["coding"] },
    ]);
    const t = (await hub.tools.call("create_task", {
      title: "活",
      requires: ["coding"],
    })) as {
      task: string;
    };
    await hub.tools.call("assign_task", { task: t.task });
    await settle(hub);

    const types = log.replay().map((e: { type: string }) => e.type);
    expect(types).toContain("task.assigned");
    expect(types).toContain("task.started");
    const started = log.replay().find((e: { type: string }) => e.type === "task.started");
    expect(started.actor.kind).toBe("system");
  });

  /** Rule 3, and the one that has to survive a persuasive agent. */
  it("agent 报 completed，任务仍然只到 review", async () => {
    const hubRef = hubReference();
    const a = fakeAdapter("alpha", "Alpha", {
      onSend: async () => {
        await hubRef
          .get()
          .tools.call(
            "report_result",
            { task: "TASK-001", status: "completed", summary: "做完了" },
            "alpha",
          );
        return "";
      },
    });
    const made = makeHub({ alpha: a }, [{ id: "alpha", capabilities: ["coding"] }]);
    const hub = made.hub;
    hubRef.set(hub);

    await hub.tools.call("create_task", { title: "活", requires: ["coding"] });
    await hub.tools.call("assign_task", { task: "TASK-001" });
    await settle(hub);

    expect(hub.tasks()["TASK-001"].status).toBe("review");
    expect(made.log.replay().map((e: { type: string }) => e.type)).not.toContain(
      "task.completed",
    );
  });

  it("只有人能验收，验收之后才是 completed", async () => {
    const hubRef = hubReference();
    const a = fakeAdapter("alpha", "Alpha", {
      onSend: async () => {
        await hubRef
          .get()
          .tools.call(
            "report_result",
            { task: "TASK-001", status: "completed", summary: "做完了" },
            "alpha",
          );
        return "";
      },
    });
    const made = makeHub({ alpha: a }, [{ id: "alpha", capabilities: ["coding"] }]);
    const hub = made.hub;
    hubRef.set(hub);
    await hub.tools.call("create_task", { title: "活", requires: ["coding"] });
    await hub.tools.call("assign_task", { task: "TASK-001" });
    await settle(hub);

    hub.accept("TASK-001");
    expect(hub.tasks()["TASK-001"].status).toBe("completed");
    const done = made.log
      .replay()
      .find((e: { type: string }) => e.type === "task.completed");
    expect(done.actor.kind).toBe("human");
  });

  it("不能替别人交付", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const b = fakeAdapter("beta", "Beta");
    const { hub } = makeHub({ alpha: a, beta: b }, [
      { id: "alpha", capabilities: ["coding"] },
      { id: "beta", capabilities: ["coding"] },
    ]);
    await hub.tools.call("create_task", { title: "活", requires: ["coding"] });
    await hub.tools.call("assign_task", { task: "TASK-001", executor: "alpha" });
    await settle(hub);

    await expect(
      hub.tools.call(
        "report_result",
        { task: "TASK-001", status: "completed", summary: "我替他交" },
        "beta",
      ),
    ).rejects.toThrow(/不是指派给/);
  });

  it("非法转移被拒绝，而不是被纠正（ADR-002）", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const { hub } = makeHub({ alpha: a }, [{ id: "alpha", capabilities: ["coding"] }]);
    await hub.tools.call("create_task", { title: "活", requires: ["coding"] });

    // created, never started — nothing to deliver yet.
    await expect(
      hub.tools.call(
        "report_result",
        { task: "TASK-001", status: "completed", summary: "还没开始就交" },
        null,
      ),
    ).rejects.toThrow(/不能 task\.review\.requested/);
    expect(hub.tasks()["TASK-001"].status).toBe("created");
  });

  it("任务给线程划了边界：消息自动落到执行者当前的任务上", async () => {
    const hubRef = hubReference();
    const a = fakeAdapter("alpha", "Alpha", {
      onSend: async () => {
        await hubRef
          .get()
          .tools.call(
            "send_message",
            { from: "alpha", to: "you", type: "progress", content: "进行中" },
            "alpha",
          );
        return "";
      },
    });
    const made = makeHub({ alpha: a }, [{ id: "alpha", capabilities: ["coding"] }]);
    const hub = made.hub;
    hubRef.set(hub);
    await hub.tools.call("create_task", { title: "活", requires: ["coding"] });
    await hub.tools.call("assign_task", { task: "TASK-001" });
    await settle(hub);

    const msg = made.log
      .replay()
      .find((e: { type: string }) => e.type === "message.sent");
    // Never said which task; the runtime scoped it.
    expect(msg.payload.task).toBe("TASK-001");
  });

  it("任务 id 从日志推导，重放得到同样的 id", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const { hub, log } = makeHub({ alpha: a }, [
      { id: "alpha", capabilities: ["coding"] },
    ]);
    await hub.tools.call("create_task", { title: "一" });
    await hub.tools.call("create_task", { title: "二" });
    expect(Object.keys(hub.tasks()).sort()).toEqual(["TASK-001", "TASK-002"]);

    // The ids live in the log, not in a counter that a restart would reset.
    const replayed = Object.keys(project(log.replay()).tasks).sort();
    expect(replayed).toEqual(["TASK-001", "TASK-002"]);
  });
});

describe("一轮只写一次（C 的真机 bug）", () => {
  it("agent 交付了任务，就不再把正文回显成一条消息", async () => {
    const hubRef = hubReference();
    const a = fakeAdapter("alpha", "Alpha", {
      onSend: async () => {
        await hubRef
          .get()
          .tools.call(
            "report_result",
            { task: "TASK-001", status: "completed", summary: "结论如下" },
            "alpha",
          );
        return "结论如下";
      },
    });
    const made = makeHub({ alpha: a }, [{ id: "alpha", capabilities: ["coding"] }]);
    const hub = made.hub;
    hubRef.set(hub);
    await hub.tools.call("create_task", { title: "活", requires: ["coding"] });
    await hub.tools.call("assign_task", { task: "TASK-001" });
    await settle(hub);

    // Delivering *is* speaking. The first live run wrote both, so the summary
    // appeared twice in the thread.
    expect(messages(made.log)).toHaveLength(0);
  });

  it("任务唤醒也在因果链上——task.started 是这一轮的 cause", async () => {
    const a = fakeAdapter("alpha", "Alpha");
    const { hub, log } = makeHub({ alpha: a }, [
      { id: "alpha", capabilities: ["coding"] },
    ]);
    await hub.tools.call("create_task", { title: "活", requires: ["coding"] });
    await hub.tools.call("assign_task", { task: "TASK-001" });
    await settle(hub);

    const reply = log.replay().find((e: { type: string }) => e.type === "message.sent");
    const started = log.replay().find((e: { type: string }) => e.type === "task.started");
    expect(reply.causedBy).toBe(started.id);
    expect(hub.depthOf(reply.id)).toBeGreaterThan(0);
  });
});
