import { describe, expect, it } from "vitest";
import { newEventId } from "../packages/event-core/src/index.js";
import {
  McpToolError,
  TOOL_NAMES,
  createMcpToolRouter,
  toolInputSchemas,
} from "../packages/mcp-server/src/index.js";
import type {
  AuthorizationPort,
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
  open_negotiation: {
    negotiation: "negotiation-001" as never,
    topic: "Event admission boundary",
    proposal: "Keep one runtime-owned event writer.",
    rationale: "It preserves authority and replay.",
    participants: ["codex", "reviewer"] as never,
    task: "TASK-001" as never,
    architectureChange: true,
  },
  object_negotiation: {
    negotiation: "negotiation-001" as never,
    reason: "The failure boundary is underspecified.",
    alternative: "Add transactional admission.",
  },
  escalate_negotiation: {
    negotiation: "negotiation-001" as never,
    reason: "Architecture options remain incompatible.",
    to: "human-owner" as never,
  },
  resolve_negotiation: {
    negotiation: "negotiation-001" as never,
    decision: "Use transactional admission.",
    rationale: "It preserves one writer with explicit failure semantics.",
  },
  propose_plan: {
    proposal: "plan-proposal-001" as never,
    goal: "goal-release" as never,
    title: "Add recovery verification",
    summary: "Add implementation and verification tasks.",
    rationale: "The current graph lacks recovery evidence.",
    tasks: [
      {
        key: "implement-recovery",
        title: "Implement recovery",
        requires: ["coding"],
        priority: "high",
        dependsOn: [{ kind: "existing", task: "TASK-001" as never }],
        requiresApproval: false,
      },
      {
        key: "verify-recovery",
        title: "Verify recovery",
        requires: ["testing"],
        priority: "high",
        dependsOn: [{ kind: "proposed", key: "implement-recovery" }],
        requiresApproval: false,
      },
    ],
  },
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
  open_negotiation: "openNegotiation",
  object_negotiation: "objectNegotiation",
  escalate_negotiation: "escalateNegotiation",
  resolve_negotiation: "resolveNegotiation",
  propose_plan: "proposePlan",
} as const satisfies Record<ToolName, keyof RuntimePort>;

type RecordedCall = Readonly<{
  method: keyof RuntimePort;
  input: unknown;
  context: McpCallContext;
}>;

function harness(
  overrides: Partial<RuntimePort> = {},
  authorizationOverrides: Partial<AuthorizationPort> = {},
) {
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
    openNegotiation: record("openNegotiation"),
    objectNegotiation: record("objectNegotiation"),
    escalateNegotiation: record("escalateNegotiation"),
    resolveNegotiation: record("resolveNegotiation"),
    proposePlan: record("proposePlan"),
    ...overrides,
  } as RuntimePort;
  const authorization: AuthorizationPort = {
    isRegistered: () => true,
    task: () => ({ owner: "codex" as never, executor: "codex" as never }),
    ...authorizationOverrides,
  };
  return {
    authorization,
    calls,
    router: createMcpToolRouter(runtime, authorization),
    runtime,
  };
}

describe("RM-1.3a · canonical MCP tool surface", () => {
  it("lists exactly seventeen tools from strict runtime schemas", () => {
    const { router } = harness();
    const definitions = router.list();
    expect(definitions.map((item) => item.name)).toEqual(TOOL_NAMES);
    expect(definitions).toHaveLength(17);
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
    [
      "open_negotiation",
      { ...validInputs.open_negotiation, participants: ["architect", "reviewer"] },
    ],
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
    const { authorization, runtime } = harness();
    expect(() =>
      createMcpToolRouter({ ...runtime, writeMemory: undefined } as never, authorization),
    ).toThrow(/RuntimePort\.writeMemory/);
  });
});

describe("RM-1.3b · fail-closed agent authorization", () => {
  const registeredTools = TOOL_NAMES.filter((name) => name !== "register_agent");

  it.each(registeredTools)(
    "rejects unregistered %s before runtime dispatch",
    async (name) => {
      const { calls, router } = harness({}, { isRegistered: () => false });
      await expect(router.call(name, validInputs[name], context())).rejects.toMatchObject(
        {
          code: "NOT_REGISTERED",
          tool: name,
        },
      );
      expect(calls).toEqual([]);
    },
  );

  it("allows self-registration without trusting role as authority", async () => {
    const { calls, router } = harness({}, { isRegistered: () => false });
    await expect(
      router.call(
        "register_agent",
        { ...validInputs.register_agent, role: "supervisor" },
        context(),
      ),
    ).resolves.toEqual({ method: "registerAgent" });
    expect(calls).toHaveLength(1);
  });

  it("allows only the task owner to assign", async () => {
    const denied = harness(
      {},
      { task: () => ({ owner: "architect" as never, executor: "codex" as never }) },
    );
    await expect(
      denied.router.call("assign_task", validInputs.assign_task, context()),
    ).rejects.toMatchObject({ code: "NOT_TASK_OWNER" });
    expect(denied.calls).toEqual([]);

    const allowed = harness(
      {},
      { task: () => ({ owner: "codex" as never, executor: "other" as never }) },
    );
    await expect(
      allowed.router.call("assign_task", validInputs.assign_task, context()),
    ).resolves.toEqual({ method: "assignTask" });
  });

  it.each(["update_task", "notify_blocked", "report_result"] as const)(
    "allows only the task executor to call %s",
    async (name) => {
      const denied = harness(
        {},
        { task: () => ({ owner: "codex" as never, executor: "other" as never }) },
      );
      await expect(
        denied.router.call(name, validInputs[name], context()),
      ).rejects.toMatchObject({ code: "NOT_TASK_EXECUTOR", tool: name });
      expect(denied.calls).toEqual([]);
    },
  );

  it("fails closed when task facts are missing", async () => {
    const { calls, router } = harness({}, { task: () => null });
    await expect(
      router.call("report_result", validInputs.report_result, context()),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(calls).toEqual([]);
  });

  it.each([
    ["find_agent", { isRegistered: () => Promise.reject(new Error("offline")) }],
    ["assign_task", { task: () => Promise.reject(new Error("offline")) }],
  ] as const)(
    "fails closed when %s authorization reads fail",
    async (name, overrides) => {
      const { calls, router } = harness({}, overrides);
      await expect(router.call(name, validInputs[name], context())).rejects.toMatchObject(
        {
          code: "AUTHORIZATION_UNAVAILABLE",
        },
      );
      expect(calls).toEqual([]);
    },
  );

  it("fails fast when the Authorization Port is incomplete", () => {
    const { runtime } = harness();
    expect(() =>
      createMcpToolRouter(runtime, { isRegistered: () => true } as never),
    ).toThrow(/AuthorizationPort\.task/);
  });
});
