import { ZodError, z } from "zod";
import { authorizeToolCall } from "./authorization.js";
import type { AuthorizationPort } from "./authorization.js";
import { McpToolError } from "./errors.js";
import {
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  mcpCallContextSchema,
  toolInputSchemas,
} from "./schemas.js";
import type { McpCallContext, ToolInputMap, ToolName } from "./schemas.js";

type Awaitable<T> = T | Promise<T>;

export interface RuntimePort {
  registerAgent(
    input: ToolInputMap["register_agent"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  findAgent(
    input: ToolInputMap["find_agent"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  createTask(
    input: ToolInputMap["create_task"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  assignTask(
    input: ToolInputMap["assign_task"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  updateTask(
    input: ToolInputMap["update_task"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  sendMessage(
    input: ToolInputMap["send_message"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  notifyBlocked(
    input: ToolInputMap["notify_blocked"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  reportResult(
    input: ToolInputMap["report_result"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  requestApproval(
    input: ToolInputMap["request_approval"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  getContext(
    input: ToolInputMap["get_context"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  writeMemory(
    input: ToolInputMap["write_memory"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  queryMemory(
    input: ToolInputMap["query_memory"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  openNegotiation(
    input: ToolInputMap["open_negotiation"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  objectNegotiation(
    input: ToolInputMap["object_negotiation"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  escalateNegotiation(
    input: ToolInputMap["escalate_negotiation"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  resolveNegotiation(
    input: ToolInputMap["resolve_negotiation"],
    context: McpCallContext,
  ): Awaitable<unknown>;
  proposePlan(
    input: ToolInputMap["propose_plan"],
    context: McpCallContext,
  ): Awaitable<unknown>;
}

const RUNTIME_METHODS = Object.freeze([
  "registerAgent",
  "findAgent",
  "createTask",
  "assignTask",
  "updateTask",
  "sendMessage",
  "notifyBlocked",
  "reportResult",
  "requestApproval",
  "getContext",
  "writeMemory",
  "queryMemory",
  "openNegotiation",
  "objectNegotiation",
  "escalateNegotiation",
  "resolveNegotiation",
  "proposePlan",
] as const satisfies readonly (keyof RuntimePort)[]);

export type McpToolDefinition = Readonly<{
  name: ToolName;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}>;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const nested of Object.values(object)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function parseContext(tool: string, value: unknown): McpCallContext {
  try {
    return deepFreeze(mcpCallContextSchema.parse(value));
  } catch (cause) {
    if (!(cause instanceof ZodError)) throw cause;
    throw new McpToolError(
      "INVALID_CONTEXT",
      tool,
      `invalid authenticated context for ${tool}`,
      cause.issues,
      { cause },
    );
  }
}

function parseInput<Name extends ToolName>(
  name: Name,
  value: unknown,
): ToolInputMap[Name] {
  try {
    return deepFreeze(toolInputSchemas[name].parse(value)) as ToolInputMap[Name];
  } catch (cause) {
    if (!(cause instanceof ZodError)) throw cause;
    throw new McpToolError(
      "INVALID_ARGUMENTS",
      name,
      `invalid arguments for ${name}`,
      cause.issues,
      { cause },
    );
  }
}

type DispatcherMap = {
  readonly [Name in ToolName]: (
    runtime: RuntimePort,
    input: ToolInputMap[Name],
    context: McpCallContext,
  ) => Awaitable<unknown>;
};

function assertPrincipal(tool: ToolName, claimed: string, context: McpCallContext): void {
  if (claimed !== context.principal.id) {
    throw new McpToolError(
      "PRINCIPAL_MISMATCH",
      tool,
      `${tool} identity does not match the authenticated principal`,
    );
  }
}

function assertInputPrincipal<Name extends ToolName>(
  name: Name,
  input: ToolInputMap[Name],
  context: McpCallContext,
): void {
  if (name === "register_agent") {
    assertPrincipal(name, (input as ToolInputMap["register_agent"]).id, context);
  } else if (name === "send_message") {
    assertPrincipal(name, (input as ToolInputMap["send_message"]).from, context);
  } else if (name === "open_negotiation") {
    const participants = (input as ToolInputMap["open_negotiation"]).participants;
    if (!participants.includes(context.principal.id)) {
      throw new McpToolError(
        "PRINCIPAL_MISMATCH",
        name,
        "open_negotiation participants must include the authenticated proposer",
      );
    }
  }
}

const DISPATCHERS: DispatcherMap = {
  register_agent: (runtime, input, context) => runtime.registerAgent(input, context),
  find_agent: (runtime, input, context) => runtime.findAgent(input, context),
  create_task: (runtime, input, context) => runtime.createTask(input, context),
  assign_task: (runtime, input, context) => runtime.assignTask(input, context),
  update_task: (runtime, input, context) => runtime.updateTask(input, context),
  send_message: (runtime, input, context) => runtime.sendMessage(input, context),
  notify_blocked: (runtime, input, context) => runtime.notifyBlocked(input, context),
  report_result: (runtime, input, context) => runtime.reportResult(input, context),
  request_approval: (runtime, input, context) => runtime.requestApproval(input, context),
  get_context: (runtime, input, context) => runtime.getContext(input, context),
  write_memory: (runtime, input, context) => runtime.writeMemory(input, context),
  query_memory: (runtime, input, context) => runtime.queryMemory(input, context),
  open_negotiation: (runtime, input, context) => runtime.openNegotiation(input, context),
  object_negotiation: (runtime, input, context) =>
    runtime.objectNegotiation(input, context),
  escalate_negotiation: (runtime, input, context) =>
    runtime.escalateNegotiation(input, context),
  resolve_negotiation: (runtime, input, context) =>
    runtime.resolveNegotiation(input, context),
  propose_plan: (runtime, input, context) => runtime.proposePlan(input, context),
};

function dispatch<Name extends ToolName>(
  runtime: RuntimePort,
  name: Name,
  input: ToolInputMap[Name],
  context: McpCallContext,
): Awaitable<unknown> {
  const dispatcher = DISPATCHERS[name] as DispatcherMap[Name];
  return dispatcher(runtime, input, context);
}

export type McpToolRouter = Readonly<{
  list(): readonly McpToolDefinition[];
  call(name: string, input: unknown, context: unknown): Promise<unknown>;
}>;

export function createMcpToolRouter(
  runtime: RuntimePort,
  authorization: AuthorizationPort,
): McpToolRouter {
  if (runtime === null || typeof runtime !== "object") {
    throw new TypeError("RuntimePort is required");
  }
  for (const method of RUNTIME_METHODS) {
    if (typeof runtime[method] !== "function") {
      throw new TypeError(`RuntimePort.${method} must be a function`);
    }
  }
  if (authorization === null || typeof authorization !== "object") {
    throw new TypeError("AuthorizationPort is required");
  }
  if (typeof authorization.isRegistered !== "function") {
    throw new TypeError("AuthorizationPort.isRegistered must be a function");
  }
  if (typeof authorization.task !== "function") {
    throw new TypeError("AuthorizationPort.task must be a function");
  }
  const definitions = Object.freeze(
    TOOL_NAMES.map((name) =>
      Object.freeze({
        name,
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: deepFreeze(
          z.toJSONSchema(toolInputSchemas[name]) as Record<string, unknown>,
        ),
      }),
    ),
  );
  return Object.freeze({
    list: () => definitions,
    async call(name: string, input: unknown, contextValue: unknown) {
      if (!(TOOL_NAMES as readonly string[]).includes(name)) {
        throw new McpToolError("UNKNOWN_TOOL", name, `unknown MCP tool ${name}`);
      }
      const tool = name as ToolName;
      const context = parseContext(tool, contextValue);
      const parsed = parseInput(tool, input);
      assertInputPrincipal(tool, parsed, context);
      await authorizeToolCall(authorization, tool, parsed, context);
      return await dispatch(runtime, tool, parsed, context);
    },
  });
}
