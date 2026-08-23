import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import { SubprocessAdapter } from "../apps/chat-spike/src/adapters/base.mjs";
// @ts-expect-error
import { Hub } from "../apps/chat-spike/src/hub.mjs";
// @ts-expect-error
import { EventLog } from "../apps/chat-spike/src/log.mjs";
// @ts-expect-error
import { RUNNER_ERROR_CODES } from "../apps/chat-spike/src/runners/contract.mjs";
// @ts-expect-error
import { LocalRunner } from "../apps/chat-spike/src/runners/local.mjs";
// @ts-expect-error
import { SessionStore } from "../apps/chat-spike/src/runners/session-store.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/runner-cli.mjs", import.meta.url));
const dirs: string[] = [];

type FixtureLine = {
  type: "delta" | "progress" | "usage" | "result";
  text?: string;
  label?: string;
  input?: number;
  output?: number;
  total?: number;
  sessionId?: string;
};

type ToolBridge = {
  args: string[];
  env: Record<string, string>;
  reportResult?: () => Promise<void>;
};

type StoredEvent = {
  id: string;
  type: string;
  actor: { kind: string; id: string };
  causedBy?: string;
  payload: Record<string, unknown>;
};

type Broadcast = {
  type: string;
  data: {
    agent?: string;
    code?: string;
    retryable?: boolean;
    event?: { kind: string; error?: { code: string } };
  };
};

type TestHub = {
  agents: Map<string, { queue: Promise<unknown>; busy: boolean }>;
  tools: {
    call: (
      name: string,
      args: Record<string, unknown>,
      caller?: string | null,
    ) => Promise<unknown>;
  };
  register: (id: string, profile: { capabilities?: string[] }) => void;
  say: (text: string, to: string) => StoredEvent;
  tasks: () => Record<string, { status: string }>;
  close: () => Promise<void>;
};

class HubCliFixtureAdapter extends SubprocessAdapter {
  static id = "claude";
  static label = "Hub CLI Fixture";
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

  async send(prompt: string) {
    const result = await super.send(prompt);
    await (this.mcp as ToolBridge | null)?.reportResult?.();
    return result;
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeSystem({ reportTasks = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentos-hub-runner-"));
  dirs.push(dir);
  const workspaceRoot = join(dir, "workspaces");
  mkdirSync(join(workspaceRoot, "claude"), { recursive: true });
  const sessionPath = join(dir, "state", "sessions.json");
  const store = new SessionStore(sessionPath);
  const log = new EventLog(join(dir, "events.jsonl"));
  const broadcasts: Broadcast[] = [];
  const hubRef: { current?: TestHub } = {};

  const runner = new LocalRunner({
    workspaceRoot,
    sessionStore: store,
    getAdapter: (id: string) => (id === "claude" ? HubCliFixtureAdapter : null),
    hostId: "hub-test-host",
    mcpFor: (request: { taskId?: string }) =>
      ({
        args: [],
        env: {},
        ...(reportTasks && request.taskId
          ? {
              reportResult: async () => {
                if (!hubRef.current) throw new Error("Hub 尚未初始化");
                await hubRef.current.tools.call(
                  "report_result",
                  {
                    task: request.taskId,
                    status: "completed",
                    summary: "CLI fixture delivered",
                  },
                  "claude",
                );
              },
            }
          : {}),
      }) satisfies ToolBridge,
  });

  const hub = new Hub({
    log,
    projectId: "proj_runner",
    broadcast: (type: string, data: Broadcast["data"]) => broadcasts.push({ type, data }),
    getAdapter: (id: string) => (id === "claude" ? HubCliFixtureAdapter : null),
    runner,
    userId: "user-local",
  }) as TestHub;
  hubRef.current = hub;
  hub.register("claude", { capabilities: ["coding"] });

  return { hub, log, broadcasts, store, sessionPath };
}

async function settle(hub: TestHub) {
  for (let index = 0; index < 20; index++) {
    await Promise.all([...hub.agents.values()].map((agent) => agent.queue));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function replay(log: { replay: () => StoredEvent[] }) {
  return log.replay();
}

describe("Hub → Local Runner vertical slice", () => {
  it("Hub.say 经 LocalRunner 和真实 CLI 写回 message.sent", async () => {
    const { hub, log, broadcasts, sessionPath } = makeSystem();
    const cause = hub.say("HELLO_FROM_HUB", "claude");
    await settle(hub);

    const reply = replay(log).find(
      (event) => event.type === "message.sent" && event.actor.kind === "agent",
    );
    expect(reply?.payload.from).toBe("claude");
    expect(reply?.payload.to).toBe("you");
    expect(reply?.payload.content).toContain("HELLO_FROM_HUB");
    expect(reply?.causedBy).toBe(cause.id);
    expect(broadcasts.some((item) => item.type === "delta")).toBe(true);
    expect(
      broadcasts.some(
        (item) => item.type === "runner" && item.data.event?.kind === "completed",
      ),
    ).toBe(true);

    const restartedStore = new SessionStore(sessionPath);
    expect(
      restartedStore.get({
        user: "user-local",
        project: "proj_runner",
        agent: "claude",
      }),
    ).toMatchObject({ sessionId: "fixture-session-1", hostId: "hub-test-host" });
    await hub.close();
  });

  it("任务分配经 Runner 执行，并通过 adapter/tool 回调进入 review", async () => {
    const { hub, log } = makeSystem({ reportTasks: true });
    const made = (await hub.tools.call("create_task", {
      title: "run a real CLI task",
      requires: ["coding"],
    })) as { task: string };
    await hub.tools.call("assign_task", { task: made.task });
    await settle(hub);

    expect(hub.tasks()[made.task]?.status).toBe("review");
    const review = replay(log).find((event) => event.type === "task.review.requested");
    expect(review?.actor).toEqual({ kind: "agent", id: "claude" });
    expect(review?.payload.summary).toBe("CLI fixture delivered");
    expect(
      replay(log).filter(
        (event) => event.type === "message.sent" && event.actor.kind === "agent",
      ),
    ).toHaveLength(0);
    await hub.close();
  });

  it("Runner 失败会广播规范错误，且同一 agent 队列继续处理下一轮", async () => {
    const { hub, log, broadcasts } = makeSystem();
    hub.say("__FAIL__", "claude");
    await settle(hub);

    expect(broadcasts).toContainEqual({
      type: "error",
      data: expect.objectContaining({
        agent: "claude",
        code: RUNNER_ERROR_CODES.ADAPTER_FAILURE,
        retryable: false,
      }),
    });
    expect(
      broadcasts.some(
        (item) => item.type === "runner" && item.data.event?.kind === "failed",
      ),
    ).toBe(true);

    hub.say("RECOVER_AFTER_FAILURE", "claude");
    await settle(hub);
    const recovered = replay(log).find(
      (event) =>
        event.type === "message.sent" &&
        event.actor.kind === "agent" &&
        String(event.payload.content).includes("RECOVER_AFTER_FAILURE"),
    );
    expect(recovered).toBeDefined();
    expect(hub.agents.get("claude")?.busy).toBe(false);
    await hub.close();
  });
});
