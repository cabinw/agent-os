import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import { makeEvent } from "../apps/chat-spike/src/events.mjs";
// @ts-expect-error
import { Hub } from "../apps/chat-spike/src/hub.mjs";
// @ts-expect-error
import { EventLog } from "../apps/chat-spike/src/log.mjs";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type SendResult = {
  text: string;
  sessionId: string | null;
  ms: number;
  fresh: boolean;
};

type DispatchRequest = {
  requestId: string;
  agent: string;
  adapter: string;
  prompt: string;
};

function fakeAdapter(onSend: (prompt: string) => Promise<string> = async () => "ok") {
  const prompts: string[] = [];
  class FakeAdapter {
    static id = "alpha";
    static label = "Alpha";
    static capabilities = {
      streaming: false,
      thoughts: false,
      session: true,
      usage: false,
    };
    hasSession = false;

    resetSession() {
      this.hasSession = false;
    }

    async send(prompt: string): Promise<SendResult> {
      prompts.push(prompt);
      this.hasSession = true;
      return {
        text: await onSend(prompt),
        sessionId: "session-alpha",
        ms: 1,
        fresh: prompts.length === 1,
      };
    }

    async close() {}
  }
  return { FakeAdapter, prompts };
}

class TrustedFakeRunner {
  readonly adapter: ReturnType<typeof fakeAdapter>;
  readonly instances = new Map<
    string,
    InstanceType<ReturnType<typeof fakeAdapter>["FakeAdapter"]>
  >();

  constructor(adapter: ReturnType<typeof fakeAdapter>) {
    this.adapter = adapter;
  }

  async dispatch(request: DispatchRequest) {
    let instance = this.instances.get(request.agent);
    if (!instance) {
      instance = new this.adapter.FakeAdapter();
      this.instances.set(request.agent, instance);
    }
    return instance.send(request.prompt);
  }

  hasSession(scope: { agent: string }) {
    return this.instances.get(scope.agent)?.hasSession ?? false;
  }

  resetSession(scope: { agent: string }) {
    this.instances.get(scope.agent)?.resetSession();
  }

  async cancel(requestId: string) {
    return { requestId, outcome: "not_found" };
  }

  health() {
    return { ready: true, hostId: "trusted-fake", inflight: 0, queued: 0 };
  }

  async close() {
    await Promise.all([...this.instances.values()].map((instance) => instance.close()));
  }
}

function makeHub(adapter: ReturnType<typeof fakeAdapter>, existingLogPath?: string) {
  const dir = existingLogPath
    ? join(existingLogPath, "..")
    : mkdtempSync(join(tmpdir(), "agentos-regression-"));
  if (!existingLogPath) dirs.push(dir);
  const log = new EventLog(existingLogPath ?? join(dir, "events.jsonl"));
  const runner = new TrustedFakeRunner(adapter);
  const hub = new Hub({
    log,
    projectId: "proj_regression",
    broadcast: () => {},
    getAdapter: (id: string) => (id === "alpha" ? adapter.FakeAdapter : null),
    runner,
  });
  hub.register("alpha", { capabilities: ["coding"] });
  return { hub, log };
}

async function settle(hub: { agents: Map<string, { queue: Promise<unknown> }> }) {
  for (let i = 0; i < 20; i++) {
    await Promise.all([...hub.agents.values()].map((agent) => agent.queue));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("EVIDENCE-01 · runtime-owned evidence path", () => {
  it("真实 Hub 默认返回 1200 条完整上下文，只有显式 limit 才截断", async () => {
    const { hub } = makeHub(fakeAdapter());
    for (let index = 0; index < 1_200; index++) {
      hub.emit(
        makeEvent({
          type: "message.sent",
          project: "proj_regression",
          actor: { kind: "human", id: "you" },
          payload: {
            from: "you",
            to: "you",
            type: "instruction",
            content: `fact-${String(index).padStart(4, "0")}`,
          },
        }),
      );
    }

    const complete = (await hub.tools.call("get_context", {})) as {
      messages: Array<{ content: string }>;
    };
    expect(complete.messages).toHaveLength(1_200);
    expect(complete.messages[0]?.content).toBe("fact-0000");
    expect(complete.messages.at(-1)?.content).toBe("fact-1199");

    const bounded = (await hub.tools.call("get_context", { limit: 25 })) as {
      messages: Array<{ content: string }>;
    };
    expect(bounded.messages).toHaveLength(25);
    expect(bounded.messages[0]?.content).toBe("fact-1175");
    await expect(hub.tools.call("get_context", { limit: 0 })).rejects.toThrow(/正整数/);
  });

  it("turn 中伪造 replyTo 不能覆盖 runtime-owned cause", async () => {
    const runtime: { hub?: InstanceType<typeof Hub> } = {};
    let forgedId = "";
    const adapter = fakeAdapter(async () => {
      await runtime.hub?.tools.call(
        "send_message",
        {
          from: "alpha",
          to: "you",
          type: "answer",
          content: "done",
          replyTo: forgedId,
        },
        "alpha",
      );
      return "";
    });
    const { hub } = makeHub(adapter);
    runtime.hub = hub;
    const forged = hub.emit(
      makeEvent({
        type: "message.sent",
        project: "proj_regression",
        actor: { kind: "human", id: "you" },
        payload: {
          from: "you",
          to: "someone-else",
          type: "instruction",
          content: "unrelated",
        },
      }),
    );
    forgedId = forged.id;

    const actualCause = hub.say("start", "alpha");
    await settle(hub);

    const reply = hub.log
      .replay()
      .find(
        (event: { type: string; payload?: { content?: string } }) =>
          event.type === "message.sent" && event.payload?.content === "done",
      );
    expect(reply?.causedBy).toBe(actualCause.id);
    expect(reply?.causedBy).not.toBe(forged.id);
  });

  it("快速重复指派只产生一个 task.started 和一次执行", async () => {
    const adapter = fakeAdapter();
    const { hub, log } = makeHub(adapter);
    await hub.tools.call("create_task", { title: "one start", requires: ["coding"] });

    const firstAssign = hub.tools.call("assign_task", {
      task: "TASK-001",
      executor: "alpha",
    });
    const secondAssign = hub.tools.call("assign_task", {
      task: "TASK-001",
      executor: "alpha",
    });
    await Promise.all([firstAssign, secondAssign]);
    await settle(hub);

    expect(
      log.replay().filter((event: { type: string }) => event.type === "task.started"),
    ).toHaveLength(1);
    expect(adapter.prompts).toHaveLength(1);
    expect(hub.tasks()["TASK-001"].status).toBe("running");
  });

  it("Hub 重启后重复注册不追加第二个 agent.registered", () => {
    const adapter = fakeAdapter();
    const first = makeHub(adapter);
    const logPath = first.log.path as string;
    expect(
      first.log
        .replay()
        .filter((event: { type: string }) => event.type === "agent.registered"),
    ).toHaveLength(1);

    const restarted = makeHub(adapter, logPath);
    expect(
      restarted.log
        .replay()
        .filter((event: { type: string }) => event.type === "agent.registered"),
    ).toHaveLength(1);
  });
});

describe("EventLog crash tail", () => {
  it("损坏尾部后的首次 append 在再次重启后仍可重放", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentos-tail-"));
    dirs.push(dir);
    const path = join(dir, "events.jsonl");
    const first = new EventLog(path);
    const event = (content: string) =>
      makeEvent({
        type: "message.sent",
        project: "proj_regression",
        actor: { kind: "human", id: "you" },
        payload: { from: "you", to: "you", type: "instruction", content },
      });

    first.append(event("before crash"));
    appendFileSync(path, '{"id":"evt_incomplete"');

    const recovered = new EventLog(path);
    expect(recovered.append(event("after crash")).seq).toBe(2);

    const restarted = new EventLog(path);
    expect(
      restarted
        .replay()
        .map((item: { payload: { content: string } }) => item.payload.content),
    ).toEqual(["before crash", "after crash"]);
    expect(restarted.seq).toBe(2);
  });
});
