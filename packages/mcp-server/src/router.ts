import { ZodError, z } from "zod";
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
] as const satisfies readonly (keyof RuntimePort)[]);

export class McpToolError extends Error {
  readonly code:
    | "INVALID_ARGUMENTS"
    | "INVALID_CONTEXT"
    | "PRINCIPAL_MISMATCH"
    | "UNKNOWN_TOOL";
  readonly tool: string;
  readonly issues: readonly unknown[];

  constructor(
    code: McpToolError["code"],
    tool: string,
    message: string,
    issues: readonly unknown[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "McpToolError";
    this.code = code;
    this.tool = tool;
    this.issues = issues;
  }
}

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

const DISPATCHERS: DispatcherMap = {
  register_agent: (runtime, input, context) => {
    assertPrincipal("register_agent", input.id, context);
    return runtime.registerAgent(input, context);
  },
  find_agent: (runtime, input, context) => runtime.findAgent(input, context),
  create_task: (runtime, input, context) => runtime.createTask(input, context),
  assign_task: (runtime, input, context) => runtime.assignTask(input, context),
  update_task: (runtime, input, context) => runtime.updateTask(input, context),
  send_message: (runtime, input, context) => {
    assertPrincipal("send_message", input.from, context);
    return runtime.sendMessage(input, context);
  },
  notify_blocked: (runtime, input, context) => runtime.notifyBlocked(input, context),
  report_result: (runtime, input, context) => runtime.reportResult(input, context),
  request_approval: (runtime, input, context) => runtime.requestApproval(input, context),
  get_context: (runtime, input, context) => runtime.getContext(input, context),
  write_memory: (runtime, input, context) => runtime.writeMemory(input, context),
  query_memory: (runtime, input, context) => runtime.queryMemory(input, context),
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

export function createMcpToolRouter(runtime: RuntimePort): McpToolRouter {
  if (runtime === null || typeof runtime !== "object") {
    throw new TypeError("RuntimePort is required");
  }
  for (const method of RUNTIME_METHODS) {
    if (typeof runtime[method] !== "function") {
      throw new TypeError(`RuntimePort.${method} must be a function`);
    }
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
      return await dispatch(runtime, tool, parsed, context);
    },
  });
}
