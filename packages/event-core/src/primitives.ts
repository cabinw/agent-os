import { z } from "zod";
import { type EventId, isEventId } from "./id.js";

export type ProjectId = string & { readonly __brand: "ProjectId" };
export type Seq = number & { readonly __brand: "Seq" };
export type EntityId = string & { readonly __brand: "EntityId" };
export type TaskId = string & { readonly __brand: "TaskId" };
export type KnowledgeId = string & { readonly __brand: "KnowledgeId" };

function isTrimmedNonEmpty(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    isTrimmedNonEmpty(value) &&
    !containsControlCharacter(value)
  );
}

/** Non-empty protocol text. Parsing validates and never normalizes stored data. */
export const nonEmptyStringSchema = z
  .string()
  .refine(isTrimmedNonEmpty, "must be non-empty and have no surrounding whitespace");

/** Stable ids are opaque to Event Core beyond safe, canonical string shape. */
export const entityIdSchema: z.ZodType<EntityId> = z.custom<EntityId>(isIdentifier, {
  error: "must be a non-empty identifier without control or surrounding whitespace",
});

export const projectIdSchema: z.ZodType<ProjectId> = z.custom<ProjectId>(isIdentifier, {
  error: "must be a non-empty project id without control or surrounding whitespace",
});

export const eventIdSchema: z.ZodType<EventId> = z.custom<EventId>(isEventId, {
  error: "must be a canonical evt_ ULID",
});

export const taskIdSchema: z.ZodType<TaskId> = z.custom<TaskId>(
  (value) => typeof value === "string" && /^TASK-[0-9]{3,}$/u.test(value),
  { error: "must be a canonical TASK-nnn id" },
);

export const knowledgeIdSchema: z.ZodType<KnowledgeId> = z.custom<KnowledgeId>(
  (value) => typeof value === "string" && /^KN-[0-9]{3,}$/u.test(value),
  { error: "must be a canonical KN-nnn id" },
);

const RFC3339_WITH_SECONDS =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
export const rfc3339Schema = z.iso
  .datetime({ offset: true })
  .refine((value) => RFC3339_WITH_SECONDS.test(value), {
    error: "must include RFC3339 time-second and an explicit offset",
  });
export const positiveIntegerSchema = z.number().int().positive().safe();
export const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
export const finiteNumberSchema = z.number().finite();

export const ACTOR_KINDS = Object.freeze(["human", "agent", "system"] as const);
export const actorKindSchema = z.enum(ACTOR_KINDS);
export type ActorKind = z.infer<typeof actorKindSchema>;

export const actorSchema = z.strictObject({
  kind: actorKindSchema,
  id: entityIdSchema,
});
export type Actor = Readonly<z.infer<typeof actorSchema>>;

export const SUBJECT_KINDS = Object.freeze([
  "agent",
  "task",
  "project",
  "message",
  "approval",
  "knowledge",
  "artifact",
  "measurement",
  "pulse",
] as const);
export const subjectKindSchema = z.enum(SUBJECT_KINDS);
export type SubjectKind = z.infer<typeof subjectKindSchema>;

export const subjectSchema = z.strictObject({
  kind: subjectKindSchema,
  id: entityIdSchema,
});
export type Subject = Readonly<z.infer<typeof subjectSchema>>;
