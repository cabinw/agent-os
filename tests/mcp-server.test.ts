import { describe, expect, it } from "vitest";
import { newEventId } from "../packages/event-core/src/index.js";
import {
  McpToolError,
  TOOL_NAMES,
  createMcpToolRouter,
  toolInputSchemas,
} from "../packages/mcp-server/src/index.js";
import type {
  McpCallContext,
  RuntimePort,
  ToolInputMap,
  ToolName,
} from "../packages/mcp-server/src/index.js";

const context = (): McpCallContext => ({
  project: "proj_mcp" as never,
  principal: { kind: "agent", id: "codex" as never },
  host: "runner-mac" as never,
  clientToken: "command-001",
  causedBy: newEventId(),
});

const validInputs: ToolInputMap = {
  register_agent: {
    id: "codex" as never,
    name: "Codex",
    provider: "display-only",
    role: "developer",
    capabilities: ["coding", "testing"],
    concurrency: 2,
  },
  find_agent: { capabilities: ["coding"], available: true },
  create_task: {
    title: "Implement strict MCP tools",
    goal: "GOAL-001" as never,
    description: "Use the canonical v0.3 contract.",
    requires: ["coding"],
    priority: "high",
    dependsOn: [],
    requiresApproval: false,
  },
  assign_task: { task: "TASK-001" as never },
  update_task: { task: "TASK-001" as never, progress: 65, note: "Implementing" },
  send_message: {
    from: "codex" as never,
    to: "you" as never,
    task: "TASK-001" as never,
    type: "instruction",
    content: "Please review the contract.",
    attachments: ["docs/protocol/mcp-protocol.md"],
  },
  notify_blocked: {
    task: "TASK-001" as never,
    reason: "Need a human decision",
    severity: "high",
    needs: "human",
  },
  report_result: {
    task: "TASK-001" as never,
    status: "completed",
    summary: "Implemented and tested.",
    outputs: ["packages/mcp-server/src/index.ts"],
  },
  request_approval: {
    action: "Publish a release",
    task: "TASK-001" as never,
    risk: "medium",
    reversible: true,
    detail: "Publishes only a prerelease tag.",
  },
  get_context: { task: "TASK-001" as never, include: ["decisions", "outputs"] },
  write_memory: {
    type: "decision",
    title: "Use one strict schema source",
    summary: "Runtime and JSON Schema share one definition.",
    rationale: "Prevents discovery and admission drift.",
    alternatives: ["Maintain two schemas"],
  },
  query_memory: { q: "why strict schema", type: "decision" },
};

const methodByTool = {
  register_agent: "registerAgent",
  find_agent: "findAgent",
  create_task: "createTask",
  assign_task: "assignTask",
  update_task: "updateTask",
  send_message: "sendMessage",
  notify_blocked: "notifyBlocked",
  report_result: "reportResult",
  request_approval: "requestApproval",
  get_context: "getContext",
  write_memory: "writeMemory",
  query_memory: "queryMemory",
} as const satisfies Record<ToolName, keyof RuntimePort>;

type RecordedCall = Readonly<{
  method: keyof RuntimePort;
  input: unknown;
  context: McpCallContext;
}>;

function harness(overrides: Partial<RuntimePort> = {}) {
  const calls: RecordedCall[] = [];
  const record =
    (method: keyof RuntimePort) => (input: unknown, callContext: McpCallContext) => {
      calls.push({ method, input, context: callContext });
      return { method };
    };
  const runtime: RuntimePort = {
    registerAgent: record("registerAgent"),
    findAgent: record("findAgent"),
    createTask: record("createTask"),
    assignTask: record("assignTask"),
    updateTask: record("updateTask"),
    sendMessage: record("sendMessage"),
    notifyBlocked: record("notifyBlocked"),
    reportResult: record("reportResult"),
    requestApproval: record("requestApproval"),
    getContext: record("getContext"),
    writeMemory: record("writeMemory"),
    queryMemory: record("queryMemory"),
    ...overrides,
  } as RuntimePort;
  return { calls, router: createMcpToolRouter(runtime), runtime };
}

describe("RM-1.3a · canonical MCP tool surface", () => {
  it("lists exactly twelve tools from strict runtime schemas", () => {
    const { router } = harness();
    const definitions = router.list();
    expect(definitions.map((item) => item.name)).toEqual(TOOL_NAMES);
    expect(definitions).toHaveLength(12);
    for (const definition of definitions) {
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.inputSchema.additionalProperties).toBe(false);
      expect(Object.isFrozen(definition.inputSchema)).toBe(true);
    }
    expect(Object.isFrozen(definitions)).toBe(true);
  });

  it.each(TOOL_NAMES)("strictly parses and dispatches %s", async (name) => {
    const { router, calls } = harness();
    await expect(router.call(name, validInputs[name], context())).resolves.toEqual({
      method: methodByTool[name],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(methodByTool[name]);
    expect(calls[0]?.input).toEqual(validInputs[name]);
    expect(Object.isFrozen(calls[0]?.input)).toBe(true);
    expect(Object.isFrozen(calls[0]?.context)).toBe(true);
    expect(Object.isFrozen(calls[0]?.context.principal)).toBe(true);
  });

  it.each(TOOL_NAMES)(
    "rejects unknown %s arguments instead of stripping them",
    async (name) => {
      const { router, calls } = harness();
      await expect(
        router.call(name, { ...validInputs[name], actor: "forged" }, context()),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS", tool: name });
      expect(calls).toEqual([]);
    },
  );

  it("rejects unknown tools before they reach the Runtime Port", async () => {
    const { router, calls } = harness();
    await expect(router.call("write_event", {}, context())).rejects.toMatchObject({
      code: "UNKNOWN_TOOL",
      tool: "write_event",
    });
    expect(calls).toEqual([]);
  });

  it("validates trusted transport context, including UTF-8 token bytes", async () => {
    const { router } = harness();
    await expect(
      router.call("query_memory", validInputs.query_memory, {
        ...context(),
        attacker: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    await expect(
      router.call("query_memory", validInputs.query_memory, {
        ...context(),
        clientToken: "🧭".repeat(65),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
  });

  it.each([
    ["register_agent", { ...validInputs.register_agent, id: "grok" }],
    ["send_message", { ...validInputs.send_message, from: "grok" }],
  ] as const)("binds %s identity to the authenticated principal", async (name, input) => {
    const { router, calls } = harness();
    await expect(router.call(name, input, context())).rejects.toMatchObject({
      code: "PRINCIPAL_MISMATCH",
    });
    expect(calls).toEqual([]);
  });

  it("enforces cross-field and controlled-vocabulary rules", async () => {
    const { router } = harness();
    const invalid = [
      [
        "send_message",
        { ...validInputs.send_message, type: "answer", replyTo: undefined },
      ],
      ["find_agent", { capabilities: ["coding", "coding"] }],
      ["create_task", { ...validInputs.create_task, priority: "urgent" }],
      ["write_memory", { type: "decision", title: "X", summary: "Y" }],
      ["update_task", { ...validInputs.update_task, progress: Number.NaN }],
    ] as const;
    for (const [name, input] of invalid) {
      await expect(router.call(name, input, context())).rejects.toBeInstanceOf(
        McpToolError,
      );
    }
  });

  it("keeps transport authority fields out of every tool schema", () => {
    for (const schema of Object.values(toolInputSchemas)) {
      const keys = Object.keys((schema as { shape: Record<string, unknown> }).shape);
      for (const field of [
        "project",
        "host",
        "clientToken",
        "causedBy",
        "schemaVersion",
        "seq",
        "at",
        "actor",
      ]) {
        expect(keys).not.toContain(field);
      }
    }
  });

  it("has request_approval but no grant, reject, status-set or event-write tool", () => {
    expect(TOOL_NAMES).toContain("request_approval");
    expect(TOOL_NAMES.join(" ")).not.toMatch(/grant|reject|set_status|write_event/);
  });

  it("preserves domain errors from the Runtime Port", async () => {
    const domain = Object.assign(new Error("task dependency is incomplete"), {
      code: "TASK_NOT_READY",
    });
    const { router } = harness({ assignTask: () => Promise.reject(domain) });
    await expect(
      router.call("assign_task", validInputs.assign_task, context()),
    ).rejects.toBe(domain);
  });

  it("fails fast when the Runtime Port is incomplete", () => {
    const { runtime } = harness();
    expect(() =>
      createMcpToolRouter({ ...runtime, writeMemory: undefined } as never),
    ).toThrow(/RuntimePort\.writeMemory/);
  });
});
