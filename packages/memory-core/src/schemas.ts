import { eventPayloadSchemas, parseEventPayload } from "@agent-os/event-core";
import type {
  KnowledgeId as CanonicalKnowledgeId,
  EventId,
  EventPayload,
} from "@agent-os/event-core";

/** The one canonical shape eventually emitted as `knowledge.created`. */
export const knowledgeDraftSchema = eventPayloadSchemas["knowledge.created"];

export type KnowledgeDraft = EventPayload<"knowledge.created">;
export type KnowledgeType = KnowledgeDraft["type"];
export type KnowledgeId = CanonicalKnowledgeId;

export type Sourced = Readonly<{
  sourceEvents: readonly EventId[];
}>;

/** Parse and recursively freeze a draft through Event Core's permanent schema. */
export function parseKnowledgeDraft(value: unknown): KnowledgeDraft {
  return parseEventPayload("knowledge.created", value);
}
