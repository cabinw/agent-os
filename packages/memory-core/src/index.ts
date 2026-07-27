/**
 * memory-core — durable project knowledge.
 *
 * Turns event history into typed, sourced, supersedable knowledge items.
 * Answers *why* a decision was made, not only *what* changed.
 *
 * Sibling of task-engine: the two must not import each other
 * (docs/architecture/packages.md).
 *
 * Contract to implement (Phase 2):
 *   extract(events)   → summarize a *window* of related events, never one
 *   query(q)          → by type / time / relation
 *   graph()           → edges derived from `causedBy`, not hand-authored
 */

import type { EventId } from "@agent-os/event-core";

export type KnowledgeType =
  | "decision"
  | "research"
  | "technical-note"
  | "task-summary"
  | "milestone"
  | "discussion";

/** `KN-nnn`, per project. */
export type KnowledgeId = string & { readonly __brand: "KnowledgeId" };

/**
 * Every knowledge item traces back to the events that produced it. This is what
 * makes memory auditable — it is never the only copy of anything.
 */
export type Sourced = {
  readonly sourceEvents: readonly EventId[];
};

export const PACKAGE = "memory-core" as const;
