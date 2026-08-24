import {
  agentRoleSchema,
  capabilitySchema,
  finiteNumberSchema,
  knowledgeTypeSchema,
  messageTypeSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
  prioritySchema,
} from "@agent-os/event-core";
import type {
  DeepReadonly,
  EntityId,
  EventId,
  ProjectId,
  TaskId,
} from "@agent-os/event-core";
import { z } from "zod";

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

export const TOOL_NAMES = Object.freeze([
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
] as const);

export type ToolName = (typeof TOOL_NAMES)[number];

function isTrimmedWithoutControl(value: string): boolean {
  if (value.length === 0 || value.trim() !== value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

const identifierStringSchema = z.string().max(256).refine(isTrimmedWithoutControl, {
  error: "must be a non-empty identifier without control or surrounding whitespace",
});
const entityIdInputSchema = identifierStringSchema as unknown as z.ZodType<EntityId>;
const projectIdInputSchema = identifierStringSchema as unknown as z.ZodType<ProjectId>;
const taskIdInputSchema = z
  .string()
  .regex(/^TASK-[0-9]{3,}$/u) as unknown as z.ZodType<TaskId>;
const eventIdInputSchema = z
  .string()
  .regex(/^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u) as unknown as z.ZodType<EventId>;

function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return length;
}

const clientTokenSchema = nonEmptyStringSchema.refine(
  (value) => utf8ByteLength(value) <= 256,
  { error: "client token exceeds 256 UTF-8 bytes" },
);

export const mcpCallContextSchema = z.strictObject({
  project: projectIdInputSchema,
  principal: z.strictObject({ kind: z.literal("agent"), id: entityIdInputSchema }),
  host: entityIdInputSchema,
  clientToken: clientTokenSchema,
  causedBy: eventIdInputSchema.optional(),
});

export type McpCallContext = DeepReadonly<z.infer<typeof mcpCallContextSchema>>;

export const toolInputSchemas = {
  register_agent: z.strictObject({
    id: entityIdInputSchema,
    name: nonEmptyStringSchema,
    provider: nonEmptyStringSchema,
    role: agentRoleSchema,
    capabilities: uniqueArray(capabilitySchema),
    concurrency: positiveIntegerSchema,
  }),
  find_agent: z.strictObject({
    capabilities: nonEmptyUniqueArray(capabilitySchema),
    available: z.boolean().optional(),
  }),
  create_task: z.strictObject({
    title: nonEmptyStringSchema,
    goal: entityIdInputSchema,
    description: nonEmptyStringSchema.optional(),
    requires: uniqueArray(capabilitySchema),
    priority: prioritySchema,
    dependsOn: uniqueArray(taskIdInputSchema),
    requiresApproval: z.boolean(),
  }),
  assign_task: z.strictObject({
    task: taskIdInputSchema,
    executor: entityIdInputSchema.optional(),
  }),
  update_task: z.strictObject({
    task: taskIdInputSchema,
    progress: finiteNumberSchema.min(0).max(100),
    note: nonEmptyStringSchema.optional(),
  }),
  send_message: z
    .strictObject({
      from: entityIdInputSchema,
      to: z.union([entityIdInputSchema, z.literal("*")]),
      task: taskIdInputSchema.optional(),
      type: messageTypeSchema,
      content: nonEmptyStringSchema,
      replyTo: eventIdInputSchema.optional(),
      attachments: nonEmptyUniqueArray(nonEmptyStringSchema).optional(),
    })
    .refine((input) => input.type !== "answer" || input.replyTo !== undefined, {
      error: "answer messages must identify the message they answer",
      path: ["replyTo"],
    }),
  notify_blocked: z.strictObject({
    task: taskIdInputSchema,
    reason: nonEmptyStringSchema,
    severity: prioritySchema,
    needs: z.enum(["human", "agent", "resource"]),
  }),
  report_result: z.strictObject({
    task: taskIdInputSchema,
    status: z.enum(["completed", "failed"]),
    summary: nonEmptyStringSchema,
    outputs: uniqueArray(nonEmptyStringSchema).optional(),
  }),
  request_approval: z.strictObject({
    action: nonEmptyStringSchema,
    task: taskIdInputSchema.optional(),
    risk: prioritySchema,
    reversible: z.boolean(),
    detail: nonEmptyStringSchema,
  }),
  get_context: z.strictObject({
    task: taskIdInputSchema,
    include: nonEmptyUniqueArray(nonEmptyStringSchema),
  }),
  write_memory: z
    .strictObject({
      type: knowledgeTypeSchema,
      title: nonEmptyStringSchema,
      summary: nonEmptyStringSchema,
      rationale: nonEmptyStringSchema.optional(),
      alternatives: nonEmptyUniqueArray(nonEmptyStringSchema).optional(),
    })
    .refine((input) => input.type !== "decision" || input.rationale !== undefined, {
      error: "decision memory must preserve its rationale",
      path: ["rationale"],
    }),
  query_memory: z.strictObject({
    q: nonEmptyStringSchema,
    type: knowledgeTypeSchema.optional(),
  }),
} as const satisfies Record<ToolName, z.ZodType>;

export type ToolInputMap = {
  readonly [Name in ToolName]: DeepReadonly<z.infer<(typeof toolInputSchemas)[Name]>>;
};

export const TOOL_DESCRIPTIONS = Object.freeze({
  register_agent: "Register the authenticated agent and its effective capabilities.",
  find_agent: "Find reachable agent placements by controlled task capability.",
  create_task: "Create an unassigned task with immutable requirements and dependencies.",
  assign_task: "Assign a ready task explicitly or by capability routing.",
  update_task: "Report advisory task progress without changing lifecycle state.",
  send_message: "Send a task-scoped or project-scoped collaboration message.",
  notify_blocked: "Declare that the assigned task cannot proceed and what it needs.",
  report_result: "Submit completed work for review or report an unrecoverable failure.",
  request_approval: "Request a blocking human decision with complete risk disclosure.",
  get_context: "Load prior decisions, outputs and related context for a task.",
  write_memory: "Admit a sourced durable knowledge item through Memory Core.",
  query_memory: "Query durable project knowledge by text and optional type.",
} as const satisfies Record<ToolName, string>);
