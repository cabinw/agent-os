export { AGENT_TOOL_NAMES, AgentClientError, createAgentClient } from "./client.js";
export type { AgentClient, AgentToolName, AgentToolTransport } from "./client.js";
export {
  AgentSdkContractError,
  RUNNER_ERROR_CODES,
  createAdapterCatalog,
  parseAdapterDescriptor,
  parseAdapterResult,
  parseRunnerDispatchRequest,
  parseRunnerObservation,
} from "./contracts.js";
export type {
  AbortSignalLike,
  AdapterDescriptor,
  AdapterInvocation,
  AdapterResult,
  AgentAdapter,
  AgentId,
  Awaitable,
  IntegrationCapabilities,
  RequestId,
  Runner,
  RunnerCancelOutcome,
  RunnerDispatchRequest,
  RunnerError,
  RunnerErrorCode,
  RunnerEvent,
  RunnerHealth,
  RunnerObservation,
  ScopedMcpMount,
} from "./contracts.js";
export {
  AdapterExecutionError,
  JsonLineSubprocessAdapter,
  sanitizeAdapterEnvironment,
} from "./jsonl-adapter.js";
export type {
  AdapterScheduler,
  JsonLineAdapterOptions,
  JsonLineInterpretation,
  ProcessCommand,
  ProcessExit,
  ProcessSpawner,
  SpawnedProcess,
} from "./jsonl-adapter.js";

export const PACKAGE = "agent-sdk" as const;
