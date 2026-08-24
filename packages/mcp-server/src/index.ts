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
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  mcpCallContextSchema,
  toolInputSchemas,
} from "./schemas.js";
export type { McpCallContext, ToolInputMap, ToolName } from "./schemas.js";
export { McpToolError, createMcpToolRouter } from "./router.js";
export type {
  McpToolDefinition,
  McpToolRouter,
  RuntimePort,
} from "./router.js";

export const PACKAGE = "mcp-server" as const;
