/**
 * memory-core — durable project knowledge.
 *
 * Phase 2.1 owns the strict knowledge draft and structural candidate filter.
 * Window construction, summarization, projections and queries land in the
 * following Memory milestones; see ADR-020.
 */

export { knowledgeDraftSchema, parseKnowledgeDraft } from "./schemas.js";
export type { KnowledgeDraft, KnowledgeId, KnowledgeType, Sourced } from "./schemas.js";
export {
  KNOWLEDGE_TRIGGER_KINDS,
  classifyKnowledgeEvent,
} from "./triggers.js";
export type {
  KnowledgeCandidate,
  KnowledgeEventClassification,
  KnowledgeNoise,
  KnowledgeNoiseReason,
  KnowledgeTriggerKind,
} from "./triggers.js";

export const PACKAGE = "memory-core" as const;
