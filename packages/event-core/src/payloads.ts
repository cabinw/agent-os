import { z } from "zod";
import { type DeepReadonly, deepFreeze } from "./immutable.js";
import {
  entityIdSchema,
  eventIdSchema,
  finiteNumberSchema,
  knowledgeIdSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
  rfc3339Schema,
  taskIdSchema,
} from "./primitives.js";

function uniqueArray<T extends z.ZodType>(item: T) {
  return z.array(item).refine((items) => new Set(items).size === items.length, {
    error: "must not contain duplicates",
  });
}

function nonEmptyUniqueArray<T extends z.ZodType>(item: T) {
  return uniqueArray(item).refine((items) => items.length > 0, {
    error: "must contain at least one item",
  });
}

export const CAPABILITIES = Object.freeze([
  "architecture",
  "coding",
  "testing",
  "review",
  "research",
  "design",
  "writing",
  "data",
  "ops",
  "git",
] as const);
export const capabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof capabilitySchema>;

export const AGENT_ROLES = Object.freeze([
  "supervisor",
  "architect",
  "developer",
  "researcher",
  "reviewer",
  "designer",
] as const);
export const agentRoleSchema = z.enum(AGENT_ROLES);

export const AGENT_STATUSES = Object.freeze([
  "idle",
  "working",
  "waiting",
  "blocked",
] as const);
export const agentStatusSchema = z.enum(AGENT_STATUSES);

export const PRIORITIES = Object.freeze(["low", "medium", "high", "critical"] as const);
export const prioritySchema = z.enum(PRIORITIES);

export const MESSAGE_TYPES = Object.freeze([
  "instruction",
  "question",
  "answer",
  "progress",
  "report",
  "review",
  "warning",
] as const);
export const messageTypeSchema = z.enum(MESSAGE_TYPES);

export const KNOWLEDGE_TYPES = Object.freeze([
  "decision",
  "research",
  "technical-note",
  "task-summary",
  "milestone",
  "discussion",
] as const);
export const knowledgeTypeSchema = z.enum(KNOWLEDGE_TYPES);

export const PROJECT_STATES = Object.freeze([
  "active",
  "paused",
  "archived",
  "completed",
] as const);
export const projectStateSchema = z.enum(PROJECT_STATES);

export const integrationSchema = z.strictObject({
  participates: z.boolean(),
  streaming: z.boolean(),
  reasoning: z.boolean(),
  session: z.boolean(),
  usage: z.boolean(),
});

const agentRegisteredSchema = z.strictObject({
  id: entityIdSchema,
  name: nonEmptyStringSchema,
  provider: nonEmptyStringSchema,
  role: agentRoleSchema,
  parentAgent: entityIdSchema.optional(),
  concurrency: positiveIntegerSchema,
  host: entityIdSchema,
  capabilities: uniqueArray(capabilitySchema),
  integration: integrationSchema,
});

const agentStatusChangedSchema = z
  .strictObject({
    host: entityIdSchema,
    from: agentStatusSchema,
    to: agentStatusSchema,
    reason: nonEmptyStringSchema.optional(),
  })
  .refine((payload) => payload.from !== payload.to, {
    error: "agent status must change",
    path: ["to"],
  });

const agentDisconnectedSchema = z.strictObject({
  id: entityIdSchema,
  host: entityIdSchema,
  graceful: z.boolean(),
});

const taskCreatedSchema = z.strictObject({
  title: nonEmptyStringSchema,
  goal: entityIdSchema,
  description: nonEmptyStringSchema.optional(),
  requires: uniqueArray(capabilitySchema),
  priority: prioritySchema,
  dependsOn: uniqueArray(taskIdSchema),
  requiresApproval: z.boolean(),
});

const taskAssignedSchema = z.strictObject({
  executor: entityIdSchema,
  matchedBy: z.enum(["explicit", "capability"]),
});

const taskStartedSchema = z.strictObject({ executor: entityIdSchema });

const taskProgressUpdatedSchema = z.strictObject({
  progress: finiteNumberSchema.min(0).max(100),
  note: nonEmptyStringSchema.optional(),
});

const taskBlockedSchema = z.strictObject({
  reason: nonEmptyStringSchema,
  severity: prioritySchema,
  needs: z.enum(["human", "agent", "resource"]),
});

const taskUnblockedSchema = z.strictObject({ resolution: nonEmptyStringSchema });

const taskReviewRequestedSchema = z.strictObject({
  summary: nonEmptyStringSchema,
  outputs: uniqueArray(nonEmptyStringSchema),
});

const taskCompletedSchema = z.strictObject({ acceptedBy: entityIdSchema });

const taskFailedSchema = z.strictObject({
  reason: nonEmptyStringSchema,
  attempts: positiveIntegerSchema,
});

const taskCancelledSchema = z.strictObject({
  by: entityIdSchema,
  reason: nonEmptyStringSchema,
});

const messageSentSchema = z
  .strictObject({
    from: entityIdSchema,
    to: z.union([entityIdSchema, z.literal("*")]),
    type: messageTypeSchema,
    task: taskIdSchema.optional(),
    content: nonEmptyStringSchema,
    replyTo: eventIdSchema.optional(),
    attachments: nonEmptyUniqueArray(nonEmptyStringSchema).optional(),
  })
  .refine((payload) => payload.type !== "answer" || payload.replyTo !== undefined, {
    error: "answer messages must identify the message they answer",
    path: ["replyTo"],
  });

const approvalRequestedSchema = z.strictObject({
  action: nonEmptyStringSchema,
  risk: prioritySchema,
  reversible: z.boolean(),
  requestedBy: entityIdSchema,
  task: taskIdSchema.optional(),
  detail: nonEmptyStringSchema,
});

const approvalGrantedSchema = z.strictObject({
  by: entityIdSchema,
  note: nonEmptyStringSchema.optional(),
});

const approvalRejectedSchema = z.strictObject({
  by: entityIdSchema,
  reason: nonEmptyStringSchema,
});

const approvalExpiredSchema = z.strictObject({ after: rfc3339Schema });

const knowledgeCreatedSchema = z
  .strictObject({
    type: knowledgeTypeSchema,
    title: nonEmptyStringSchema,
    summary: nonEmptyStringSchema,
    sourceEvents: nonEmptyUniqueArray(eventIdSchema),
    rationale: nonEmptyStringSchema.optional(),
    alternatives: nonEmptyUniqueArray(nonEmptyStringSchema).optional(),
    relatedTasks: nonEmptyUniqueArray(taskIdSchema).optional(),
  })
  .refine((payload) => payload.type !== "decision" || payload.rationale !== undefined, {
    error: "decision knowledge must preserve its rationale",
    path: ["rationale"],
  });

const knowledgeLinkedSchema = z
  .strictObject({
    from: entityIdSchema,
    to: entityIdSchema,
    relation: nonEmptyStringSchema,
  })
  .refine((payload) => payload.from !== payload.to, {
    error: "a knowledge link cannot point to itself",
    path: ["to"],
  });

const knowledgeSupersededSchema = z
  .strictObject({ old: knowledgeIdSchema, new: knowledgeIdSchema })
  .refine((payload) => payload.old !== payload.new, {
    error: "knowledge cannot supersede itself",
    path: ["new"],
  });

const projectCreatedSchema = z.strictObject({
  name: nonEmptyStringSchema,
  stack: uniqueArray(nonEmptyStringSchema),
});

const projectHumanParticipationConfiguredSchema = z.strictObject({
  enabled: z.boolean(),
});

const projectStateChangedSchema = z
  .strictObject({ from: projectStateSchema, to: projectStateSchema })
  .refine((payload) => payload.from !== payload.to, {
    error: "project state must change",
    path: ["to"],
  });

const projectSnapshotCapturedSchema = z.strictObject({
  label: nonEmptyStringSchema,
  image: nonEmptyStringSchema,
  at: rfc3339Schema,
});

export const revivalPlanStepSchema = z.strictObject({
  title: nonEmptyStringSchema,
  estimateMinutes: positiveIntegerSchema,
  detail: nonEmptyStringSchema,
});

const projectRevivedSchema = z.strictObject({
  dormantDays: positiveIntegerSchema,
  plan: z.array(revivalPlanStepSchema).nonempty(),
});

const artifactProducedSchema = z.strictObject({
  path: nonEmptyStringSchema,
  kind: nonEmptyStringSchema,
  task: taskIdSchema,
});

const artifactDerivedSchema = z
  .strictObject({
    path: nonEmptyStringSchema,
    from: nonEmptyUniqueArray(nonEmptyStringSchema),
    lens: nonEmptyStringSchema,
  })
  .refine((payload) => !payload.from.includes(payload.path), {
    error: "a derived artifact cannot list itself as a source",
    path: ["from"],
  });

const measurementRecordedSchema = z.strictObject({
  metric: nonEmptyStringSchema,
  value: finiteNumberSchema,
  unit: nonEmptyStringSchema,
  source: nonEmptyStringSchema,
  at: rfc3339Schema,
});

const pulseStoryGeneratedSchema = z.strictObject({
  headline: nonEmptyStringSchema,
  body: nonEmptyStringSchema,
  sourceEvents: nonEmptyUniqueArray(eventIdSchema),
});

export const EVENT_TYPES = Object.freeze([
  "agent.registered",
  "agent.status.changed",
  "agent.disconnected",
  "task.created",
  "task.assigned",
  "task.started",
  "task.progress.updated",
  "task.blocked",
  "task.unblocked",
  "task.review.requested",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "message.sent",
  "approval.requested",
  "approval.granted",
  "approval.rejected",
  "approval.expired",
  "knowledge.created",
  "knowledge.linked",
  "knowledge.superseded",
  "project.created",
  "project.human.participation.configured",
  "project.state.changed",
  "project.snapshot.captured",
  "project.revived",
  "artifact.produced",
  "artifact.derived",
  "measurement.recorded",
  "pulse.story.generated",
] as const);

export type EventType = (typeof EVENT_TYPES)[number];
export const eventTypeSchema = z.enum(EVENT_TYPES);

function immutableSchema<Schema extends z.ZodType>(schema: Schema) {
  return schema
    .superRefine((value, context) => {
      if (typeof value !== "object" || value === null) return;
      for (const [field, fieldValue] of Object.entries(value)) {
        if (fieldValue === undefined) {
          context.addIssue({
            code: "custom",
            message: "optional fields must be omitted rather than set to undefined",
            path: [field],
          });
        }
      }
    })
    .transform((value) => deepFreeze(value));
}

export const eventPayloadSchemas = Object.freeze({
  "agent.registered": immutableSchema(agentRegisteredSchema),
  "agent.status.changed": immutableSchema(agentStatusChangedSchema),
  "agent.disconnected": immutableSchema(agentDisconnectedSchema),
  "task.created": immutableSchema(taskCreatedSchema),
  "task.assigned": immutableSchema(taskAssignedSchema),
  "task.started": immutableSchema(taskStartedSchema),
  "task.progress.updated": immutableSchema(taskProgressUpdatedSchema),
  "task.blocked": immutableSchema(taskBlockedSchema),
  "task.unblocked": immutableSchema(taskUnblockedSchema),
  "task.review.requested": immutableSchema(taskReviewRequestedSchema),
  "task.completed": immutableSchema(taskCompletedSchema),
  "task.failed": immutableSchema(taskFailedSchema),
  "task.cancelled": immutableSchema(taskCancelledSchema),
  "message.sent": immutableSchema(messageSentSchema),
  "approval.requested": immutableSchema(approvalRequestedSchema),
  "approval.granted": immutableSchema(approvalGrantedSchema),
  "approval.rejected": immutableSchema(approvalRejectedSchema),
  "approval.expired": immutableSchema(approvalExpiredSchema),
  "knowledge.created": immutableSchema(knowledgeCreatedSchema),
  "knowledge.linked": immutableSchema(knowledgeLinkedSchema),
  "knowledge.superseded": immutableSchema(knowledgeSupersededSchema),
  "project.created": immutableSchema(projectCreatedSchema),
  "project.human.participation.configured": immutableSchema(
    projectHumanParticipationConfiguredSchema,
  ),
  "project.state.changed": immutableSchema(projectStateChangedSchema),
  "project.snapshot.captured": immutableSchema(projectSnapshotCapturedSchema),
  "project.revived": immutableSchema(projectRevivedSchema),
  "artifact.produced": immutableSchema(artifactProducedSchema),
  "artifact.derived": immutableSchema(artifactDerivedSchema),
  "measurement.recorded": immutableSchema(measurementRecordedSchema),
  "pulse.story.generated": immutableSchema(pulseStoryGeneratedSchema),
} satisfies Record<EventType, z.ZodType>);

export type EventPayloadMap = {
  readonly [Type in EventType]: DeepReadonly<
    z.output<(typeof eventPayloadSchemas)[Type]>
  >;
};

export type EventPayload<Type extends EventType = EventType> = EventPayloadMap[Type];

export function parseEventPayload<Type extends EventType>(
  type: Type,
  input: unknown,
): EventPayload<Type> {
  return eventPayloadSchemas[type].parse(input) as EventPayload<Type>;
}
