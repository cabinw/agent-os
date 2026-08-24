import {
  eventPayloadSchemas,
  knowledgeTypeSchema,
  nonEmptyStringSchema,
  parseEventPayload,
} from "@agent-os/event-core";
import type {
  KnowledgeId as CanonicalKnowledgeId,
  DeepReadonly,
  EventId,
  EventPayload,
} from "@agent-os/event-core";
import { z } from "zod";

/** The one canonical shape eventually emitted as `knowledge.created`. */
export const knowledgeDraftSchema = eventPayloadSchemas["knowledge.created"];

export type KnowledgeDraft = EventPayload<"knowledge.created">;
export type KnowledgeType = KnowledgeDraft["type"];
export type KnowledgeId = CanonicalKnowledgeId;

export type Sourced = Readonly<{
  sourceEvents: readonly EventId[];
}>;

const uniqueNonEmptyStrings = z
  .array(nonEmptyStringSchema)
  .min(1)
  .refine((items) => new Set(items).size === items.length, {
    error: "must not contain duplicates",
  });

const rawKnowledgeSummarySchema = z
  .strictObject({
    type: knowledgeTypeSchema,
    title: nonEmptyStringSchema,
    summary: nonEmptyStringSchema,
    rationale: nonEmptyStringSchema.optional(),
    alternatives: uniqueNonEmptyStrings.optional(),
  })
  .refine((summary) => summary.type !== "decision" || summary.rationale !== undefined, {
    error: "decision summary must preserve its rationale",
    path: ["rationale"],
  });

function freeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
}

export type KnowledgeSummary = DeepReadonly<z.output<typeof rawKnowledgeSummarySchema>>;

export const knowledgeSummarySchema = rawKnowledgeSummarySchema.transform((summary) =>
  freeze(summary),
) as z.ZodType<KnowledgeSummary>;

export const KNOWLEDGE_SUMMARY_JSON_SCHEMA = freeze(
  z.toJSONSchema(rawKnowledgeSummarySchema) as Record<string, unknown>,
);

/** Parse and recursively freeze a draft through Event Core's permanent schema. */
export function parseKnowledgeDraft(value: unknown): KnowledgeDraft {
  return parseEventPayload("knowledge.created", value);
}

export function parseKnowledgeSummary(value: unknown): KnowledgeSummary {
  return knowledgeSummarySchema.parse(value);
}
