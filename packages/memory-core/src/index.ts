/**
 * memory-core — durable project knowledge.
 *
 * Phase 2.1 owns the strict knowledge draft and structural candidate filter.
 * Window construction, summarization, projections and queries land in the
 * following Memory milestones; see ADR-020.
 */

export {
  KNOWLEDGE_SUMMARY_JSON_SCHEMA,
  knowledgeDraftSchema,
  knowledgeSummarySchema,
  parseKnowledgeDraft,
  parseKnowledgeSummary,
} from "./schemas.js";
export type {
  KnowledgeDraft,
  KnowledgeId,
  KnowledgeSummary,
  KnowledgeType,
  Sourced,
} from "./schemas.js";
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
export { KnowledgeWindowError, buildKnowledgeWindow } from "./windows.js";
export type {
  KnowledgeWindow,
  KnowledgeWindowErrorCode,
} from "./windows.js";
export {
  KnowledgeExtractionError,
  KnowledgeExtractor,
  createKnowledgeExtractor,
  isKnowledgeWindowError,
} from "./extractor.js";
export type {
  KnowledgeAdmissionCommand,
  KnowledgeAdmissionPort,
  KnowledgeExtractionErrorCode,
  KnowledgeExtractionRequest,
  KnowledgeExtractorOptions,
  KnowledgeSummarizer,
  KnowledgeSummarizerInput,
} from "./extractor.js";
export {
  KnowledgeProjectionError,
  assertKnowledgeSupersession,
  emptyKnowledgeProjectState,
  parseKnowledgeProjectState,
  reduceKnowledgeProject,
  registerKnowledgeReducer,
} from "./projection.js";
export type {
  KnowledgeItem,
  KnowledgeRelation,
  KnowledgeProjectState,
  KnowledgeProjectionErrorCode,
} from "./projection.js";
export {
  KnowledgeSuperseder,
  KnowledgeSupersessionError,
  createKnowledgeSuperseder,
} from "./supersession.js";
export {
  MEMORY_QUERY_STATUSES,
  MemoryQueryError,
  queryMemory,
} from "./query.js";
export type {
  MemoryQuery,
  MemoryQueryErrorCode,
  MemoryQueryResult,
  MemoryQueryStatus,
  MemoryRelationDescriptor,
  QueryMemorySource,
} from "./query.js";
export { MemoryGraphError, buildMemoryGraph } from "./graph.js";
export type {
  MemoryGraph,
  MemoryGraphEdge,
  MemoryGraphErrorCode,
  MemoryGraphSource,
} from "./graph.js";
export type {
  KnowledgeSupersederOptions,
  KnowledgeSupersessionCommand,
  KnowledgeSupersessionErrorCode,
  KnowledgeSupersessionPort,
  KnowledgeSupersessionRequest,
} from "./supersession.js";

export const PACKAGE = "memory-core" as const;
