/**
 * mcp-server — the only ingress for external agents.
 *
 * The whole trust boundary lives here. Validation, authorization, and the v0.3
 * tools. Holds no state of its own.
 *
 * Contract to implement (Phase 1.3a–1.3c):
 *   the 12 tools in docs/protocol/mcp-protocol.md, validated with a strict
 *   schema — unknown fields are *rejected*, not ignored.
 *
 * Three things an agent can never do, enforced here (Phase 1.3b–1.3c):
 *   1. write an event directly
 *   2. set a task's status
 *   3. approve anything — including another agent's request
 */

export {
  CONTEXT_INCLUDE_KINDS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  mcpCallContextSchema,
  toolInputSchemas,
} from "./schemas.js";
export type {
  ContextIncludeKind,
  McpCallContext,
  ToolInputMap,
  ToolName,
} from "./schemas.js";
export type { AuthorizationPort, AuthorizedTask } from "./authorization.js";
export {
  ApprovalProjectionError,
  parseApprovalProjectState,
  reduceApprovalProject,
  registerApprovalReducer,
} from "./approval-projection.js";
export type {
  ApprovalDecision,
  ApprovalProjectState,
  ApprovalState,
  ApprovalStatus,
} from "./approval-projection.js";
export { ApprovalGate, ApprovalGateError, createApprovalGate } from "./approval-gate.js";
export type {
  ApprovalCommandPort,
  ApprovalGateOptions,
  ApprovalOutcome,
  ApprovalPrompt,
  ApprovalPromptDecision,
  ApprovalScheduler,
  HumanPrincipal,
  PendingApproval,
} from "./approval-gate.js";
export {
  ApprovalCenterError,
  admitApprovalIntent,
  buildApprovalCenter,
} from "./approval-center.js";
export type {
  ApprovalCenterItem,
  ApprovalCenterSource,
  ApprovalCenterView,
  ApprovalDecisionClient,
  ApprovalDecisionIntent,
  ApprovalMenuAction,
} from "./approval-center.js";
export { McpToolError } from "./errors.js";
export type { McpToolErrorCode } from "./errors.js";
export { createMcpToolRouter } from "./router.js";
export type {
  McpToolDefinition,
  McpToolRouter,
  RuntimePort,
} from "./router.js";
export { TaskContextError, buildTaskContext } from "./context.js";
export type {
  ContextDecision,
  ContextOutput,
  ContextTask,
  TaskContext,
  TaskContextErrorCode,
  TaskContextSource,
} from "./context.js";
export { ProjectPulseError, buildProjectPulse } from "./pulse.js";
export type {
  ProjectPulse,
  ProjectPulseSource,
  PulseActivity,
  PulseConsequence,
  PulseKpis,
  PulseKnowledge,
  PulseMetric,
  PulseMoment,
  PulseProgress,
  PulseRisk,
  PulseStory,
  PulseWindow,
} from "./pulse.js";
export { ProjectLibraryError, buildProjectLibrary } from "./project-library.js";
export type {
  LibraryAgent,
  LibraryFile,
  LibraryKnowledge,
  LibraryNextStep,
  LibrarySnapshot,
  LibraryTimelineItem,
  ProjectLibrary,
  ProjectLibraryItem,
  ProjectLibrarySource,
} from "./project-library.js";

export const PACKAGE = "mcp-server" as const;
