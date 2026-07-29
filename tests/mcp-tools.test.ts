import { describe, expect, it } from "vitest";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import { TOOL_SPECS, createToolRouter } from "../apps/chat-spike/src/mcp-tools.mjs";
// @ts-expect-error
import { validate } from "../apps/chat-spike/src/validate.mjs";

/** A runtime that records instead of emitting — the tools are what is under test. */
function harness() {
  const registered = new Set<string>();
  const calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const router = createToolRouter({
    registeredIds: () => registered,
    registerAgent(p: Record<string, unknown>) {
      registered.add(p.id as string);
      calls.push({ fn: "registerAgent", params: p });
      return { registered: p.id, seq: calls.length };
    },
    sendMessage(p: Record<string, unknown>) {
      calls.push({ fn: "sendMessage", params: p });
      return { id: `evt_${calls.length}`, seq: calls.length };
    },
    getContext(p: Record<string, unknown>) {
      calls.push({ fn: "getContext", params: p });
      return { project: "proj_test", messages: [], agents: [] };
    },
  });
  return { router, calls, registered };
}

type Router = { call: (name: string, args: object, caller?: string) => Promise<unknown> };

async function register(router: Router, id = "codex") {
  await router.call("register_agent", { id, name: id, capabilities: [] });
}

describe("边界校验", () => {
  it("未知字段被拒绝，而不是被忽略", () => {
    expect(() => validate({ a: { type: "string" } }, { a: "x", b: 1 })).toThrow(
      /未知字段.*b/,
    );
  });

  it("只返回 spec 命名过的字段", () => {
    expect(
      validate({ a: { type: "string" }, b: { type: "number" } }, { a: "x" }),
    ).toEqual({
      a: "x",
    });
  });

  it("必填、类型、枚举、空串都拦得住", async () => {
    const { router } = harness();
    await register(router);
    const bad = [
      { to: "you", type: "answer", content: "hi" }, // 缺 from
      { from: "codex", to: "you", type: "answer", content: "  " }, // 空内容
      { from: "codex", to: "you", type: "shout", content: "hi" }, // 非法枚举
      { from: "codex", to: "you", type: "answer", content: 42 }, // 类型错
    ];
    for (const args of bad) {
      await expect(router.call("send_message", args, "codex")).rejects.toThrow();
    }
  });

  it("未知工具名被拒绝", async () => {
    const { router } = harness();
    await expect(router.call("delete_everything", {})).rejects.toThrow(/未知工具/);
  });
});

/**
 * ADR-001 / CLAUDE.md 规则 3：agent 提请求，运行时做决定。
 * 这三条不是靠检查实现的，是靠"没有这个字段/没有这个工具"实现的——
 * 所以测试断言的是"表面上不存在"，不是"调用会失败"。
 */
describe("agent 不能做的三件事", () => {
  it("没有任何工具能写事件信封", () => {
    const fields = Object.values(TOOL_SPECS).flatMap((s: { schema: object }) =>
      Object.keys(s.schema),
    );
    for (const forbidden of ["id", "seq", "at", "actor", "type_", "event"]) {
      if (forbidden === "id") {
        // register_agent.id 是 agent 自己的 id，不是事件 id——这是唯一的重名
        continue;
      }
      expect(fields).not.toContain(forbidden);
    }
    expect(Object.keys(TOOL_SPECS.send_message.schema)).not.toContain("actor");
  });

  it("没有设置任务状态的工具", () => {
    expect(Object.keys(TOOL_SPECS)).not.toContain("set_task_status");
    expect(Object.keys(TOOL_SPECS).join()).not.toMatch(/status|state/i);
  });

  it("没有批准任何东西的工具", () => {
    expect(Object.keys(TOOL_SPECS).join()).not.toMatch(/approv|grant/i);
  });

  it("信封由运行时构造——传进去的 payload 不含 actor", async () => {
    const { router, calls } = harness();
    await register(router);
    await router.call(
      "send_message",
      { from: "codex", to: "you", type: "answer", content: "hi" },
      "codex",
    );
    const sent = calls.find((c) => c.fn === "sendMessage");
    expect(Object.keys(sent?.params ?? {})).toEqual(["from", "to", "type", "content"]);
  });
});

describe("授权", () => {
  it("未注册的发送者不能说话", async () => {
    const { router } = harness();
    await expect(
      router.call("send_message", {
        from: "ghost",
        to: "you",
        type: "answer",
        content: "hi",
      }),
    ).rejects.toThrow(/未注册/);
  });

  it("不能冒充别的 agent", async () => {
    const { router } = harness();
    await register(router, "codex");
    await register(router, "grok");
    await expect(
      router.call(
        "send_message",
        { from: "grok", to: "you", type: "answer", content: "冒名" },
        "codex",
      ),
    ).rejects.toThrow(/不能以.*身份发言/);
  });

  it("以自己的身份说话是允许的", async () => {
    const { router, calls } = harness();
    await register(router);
    await expect(
      router.call(
        "send_message",
        { from: "codex", to: "you", type: "answer", content: "hi" },
        "codex",
      ),
    ).resolves.toMatchObject({ seq: expect.any(Number) });
    expect(calls.filter((c) => c.fn === "sendMessage")).toHaveLength(1);
  });
});

describe("对外的工具清单", () => {
  it("三个工具，且 JSON Schema 关掉 additionalProperties", () => {
    const { router } = harness();
    const list = router.list();
    expect(list.map((t: { name: string }) => t.name).sort()).toEqual([
      "get_context",
      "register_agent",
      "send_message",
    ]);
    for (const tool of list) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description).toBeTruthy();
    }
  });

  it("send_message 的必填字段进了 required", () => {
    const { router } = harness();
    const tool = router.list().find((t: { name: string }) => t.name === "send_message");
    expect(tool.inputSchema.required.sort()).toEqual(["content", "from", "to", "type"]);
  });
});
