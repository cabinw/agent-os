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

import type { Capability } from "@agent-os/agent-sdk";
import type { EventId } from "@agent-os/event-core";
import type { KnowledgeId } from "@agent-os/memory-core";
import type { TaskId } from "@agent-os/task-engine";

/** The v0.3 tool surface — docs/protocol/mcp-protocol.md. */
export const TOOLS = [
  "register_agent",
  "find_agent",
  "create_task",
  "assign_task",
  "update_task",
  "send_message",
  "notify_blocked",
  "report_result",
  "request_approval",
  "get_context",
  "write_memory",
  "query_memory",
] as const;

export type ToolName = (typeof TOOLS)[number];

/** Message kinds carried by `send_message`. */
export type MessageType =
  | "instruction"
  | "question"
  | "answer"
  | "progress"
  | "report"
  | "review"
  | "warning";

/**
 * Output paths or `KN-*` ids referenced by a message. Display-only — attaching
 * transfers nothing (docs/product/threads.md).
 */
export type Attachment = string | KnowledgeId;

/** Placeholder so the reference wiring is exercised at build time. */
export type ToolCallContext = {
  readonly tool: ToolName;
  readonly task?: TaskId;
  readonly requires?: readonly Capability[];
  readonly causedBy?: EventId;
};

export const PACKAGE = "mcp-server" as const;
