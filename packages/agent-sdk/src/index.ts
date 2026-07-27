/**
 * agent-sdk — the adapter surface.
 *
 * The lowest layer permitted to name a vendor. Everything below this line
 * routes on `capabilities` only (ADR-004); adapters live here and nowhere else.
 *
 * Contract to implement (Phase 1.11):
 *   register / receiveTask / reportProgress / reportResult / sendEvent
 *
 * An agent that already speaks MCP needs no adapter at all — it calls the MCP
 * Server directly (ADR-001).
 */

import type { ProjectId } from "@agent-os/event-core";

/**
 * Controlled vocabulary — docs/protocol/agent-schema.md. Routing matches against
 * this exactly rather than guessing at free text. Extending it is a protocol
 * change.
 */
export type Capability =
  | "architecture"
  | "coding"
  | "testing"
  | "review"
  | "research"
  | "design"
  | "writing"
  | "data"
  | "ops"
  | "git";

export type AgentId = string & { readonly __brand: "AgentId" };

export type AgentRef = {
  readonly project: ProjectId;
  readonly id: AgentId;
};

/**
 * Recorded for display and billing only. Never branch on it — ADR-004.
 * Typed as an open string on purpose: a closed union would become the hardcoded
 * provider list the ADR exists to prevent.
 */
export type Provider = string;

export const PACKAGE = "agent-sdk" as const;
