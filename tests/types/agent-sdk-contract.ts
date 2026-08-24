import {
  createAdapterCatalog,
  createAgentClient,
  parseRunnerDispatchRequest,
} from "../../packages/agent-sdk/src/index.js";
import type {
  AdapterResult,
  AgentAdapter,
  AgentToolTransport,
  RunnerDispatchRequest,
} from "../../packages/agent-sdk/src/index.js";

declare const transport: AgentToolTransport;
declare const adapter: AgentAdapter;
declare const result: AdapterResult;

const client = createAgentClient(transport);
const catalog = createAdapterCatalog([adapter]);
const request: RunnerDispatchRequest = parseRunnerDispatchRequest({
  requestId: "request-001",
  user: "owner",
  project: "proj_sdk",
  agent: "agent-sdk",
  adapter: "fixture",
  workspace: "/workspace",
  prompt: "Run the task",
});
void client;
void catalog;
void request;
void result;

// @ts-expect-error the SDK exposes no direct event append
client.sendEvent({ type: "task.completed" });

// @ts-expect-error agents cannot decide approvals
client.grantApproval("approval-001");

// @ts-expect-error adapter results are immutable
result.text = "mutated";
