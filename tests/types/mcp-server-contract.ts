import {
  TOOL_NAMES,
  createApprovalGate,
  createMcpToolRouter,
  toolInputSchemas,
} from "../../packages/mcp-server/src/index.js";
import type {
  ApprovalCommandPort,
  ApprovalOutcome,
  AuthorizationPort,
  HumanPrincipal,
  McpCallContext,
  RuntimePort,
  ToolInputMap,
  ToolName,
} from "../../packages/mcp-server/src/index.js";

declare const runtime: RuntimePort;
declare const authorization: AuthorizationPort;
declare const context: McpCallContext;
declare const input: ToolInputMap["create_task"];
declare const approvalCommands: ApprovalCommandPort;
declare const human: HumanPrincipal;

const router = createMcpToolRouter(runtime, authorization);
const names: readonly ToolName[] = TOOL_NAMES;
const result: Promise<unknown> = router.call("create_task", input, context);
const title: string = toolInputSchemas.create_task.parse(input).title;
void names;
void result;
void title;

const approvalGate = createApprovalGate({
  commands: approvalCommands,
  timeoutMs: 30_000,
});
const approvalResult: Promise<ApprovalOutcome> = approvalGate.request(
  toolInputSchemas.request_approval.parse({
    action: "Publish",
    risk: "high",
    reversible: false,
    detail: "Irreversible release",
  }),
  context,
);
const humanDecision: Promise<void> = approvalGate.grant("approval-001" as never, human);
void approvalResult;
void humanDecision;

// @ts-expect-error parsed tool inputs are readonly at the Runtime Port
input.title = "mutated";

const invalidContext: McpCallContext = {
  ...context,
  // @ts-expect-error only authenticated agent principals enter MCP
  principal: { kind: "human", id: "you" as never },
};
void invalidContext;

// @ts-expect-error agents cannot satisfy the human decision contract
approvalGate.grant("approval-001" as never, context.principal);
