import {
  TOOL_NAMES,
  createMcpToolRouter,
  toolInputSchemas,
} from "../../packages/mcp-server/src/index.js";
import type {
  AuthorizationPort,
  McpCallContext,
  RuntimePort,
  ToolInputMap,
  ToolName,
} from "../../packages/mcp-server/src/index.js";

declare const runtime: RuntimePort;
declare const authorization: AuthorizationPort;
declare const context: McpCallContext;
declare const input: ToolInputMap["create_task"];

const router = createMcpToolRouter(runtime, authorization);
const names: readonly ToolName[] = TOOL_NAMES;
const result: Promise<unknown> = router.call("create_task", input, context);
const title: string = toolInputSchemas.create_task.parse(input).title;
void names;
void result;
void title;

// @ts-expect-error parsed tool inputs are readonly at the Runtime Port
input.title = "mutated";

const invalidContext: McpCallContext = {
  ...context,
  // @ts-expect-error only authenticated agent principals enter MCP
  principal: { kind: "human", id: "you" as never },
};
void invalidContext;
