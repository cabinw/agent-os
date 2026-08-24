import {
  agentRoleSchema,
  capabilitySchema,
  finiteNumberSchema,
  knowledgeTypeSchema,
  messageTypeSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
  prioritySchema,
  rfc3339Schema,
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

export const TOOL_NAMES = AGENT_TOOL_NAMES;

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
const planLocalKeyInputSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const planDependencyInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("existing"), task: taskIdInputSchema }),
  z.strictObject({ kind: z.literal("proposed"), key: planLocalKeyInputSchema }),
]);
const planProposedTaskInputSchema = z.strictObject({
  key: planLocalKeyInputSchema,
  title: nonEmptyStringSchema,
  description: nonEmptyStringSchema.optional(),
  requires: uniqueArray(capabilitySchema),
  priority: prioritySchema,
  dependsOn: z.array(planDependencyInputSchema),
  requiresApproval: z.boolean(),
});

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

export const CONTEXT_INCLUDE_KINDS = Object.freeze(["decisions", "outputs"] as const);
const contextIncludeKindSchema = z.enum(CONTEXT_INCLUDE_KINDS);
export type ContextIncludeKind = (typeof CONTEXT_INCLUDE_KINDS)[number];

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
    include: nonEmptyUniqueArray(contextIncludeKindSchema),
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
  query_memory: z
    .strictObject({
      q: nonEmptyStringSchema.optional(),
      type: knowledgeTypeSchema.optional(),
      after: rfc3339Schema.optional(),
      before: rfc3339Schema.optional(),
      relatedTo: entityIdInputSchema.optional(),
      relation: nonEmptyStringSchema.optional(),
      status: z.enum(["active", "superseded", "all"]).optional(),
    })
    .refine(
      (input) =>
        input.after === undefined ||
        input.before === undefined ||
        Date.parse(input.after) <= Date.parse(input.before),
      { error: "after must not be later than before", path: ["after"] },
    ),
  open_negotiation: z.strictObject({
    negotiation: entityIdInputSchema,
    topic: nonEmptyStringSchema,
    proposal: nonEmptyStringSchema,
    rationale: nonEmptyStringSchema,
    participants: nonEmptyUniqueArray(entityIdInputSchema).refine(
      (participants) => participants.length >= 2,
      { error: "negotiation requires at least two participants" },
    ),
    task: taskIdInputSchema.optional(),
    architectureChange: z.boolean(),
  }),
  object_negotiation: z.strictObject({
    negotiation: entityIdInputSchema,
    reason: nonEmptyStringSchema,
    alternative: nonEmptyStringSchema,
  }),
  escalate_negotiation: z.strictObject({
    negotiation: entityIdInputSchema,
    reason: nonEmptyStringSchema,
    to: entityIdInputSchema,
  }),
  resolve_negotiation: z.strictObject({
    negotiation: entityIdInputSchema,
    decision: nonEmptyStringSchema,
    rationale: nonEmptyStringSchema,
  }),
  propose_plan: z
    .strictObject({
      proposal: entityIdInputSchema,
      title: nonEmptyStringSchema,
      summary: nonEmptyStringSchema,
      rationale: nonEmptyStringSchema,
      goal: entityIdInputSchema,
      tasks: z.array(planProposedTaskInputSchema).min(1).max(100),
    })
    .superRefine((proposal, context) => {
      const keys = new Set(proposal.tasks.map((task) => task.key));
      if (keys.size !== proposal.tasks.length) {
        context.addIssue({
          code: "custom",
          message: "proposed task keys must be unique",
          path: ["tasks"],
        });
      }
      for (const [index, task] of proposal.tasks.entries()) {
        const references = task.dependsOn.map((dependency) =>
          dependency.kind === "existing"
            ? `existing:${dependency.task}`
            : `proposed:${dependency.key}`,
        );
        if (new Set(references).size !== references.length) {
          context.addIssue({
            code: "custom",
            message: "proposed task dependencies must be unique",
            path: ["tasks", index, "dependsOn"],
          });
        }
        for (const dependency of task.dependsOn) {
          if (dependency.kind !== "proposed") continue;
          if (!keys.has(dependency.key)) {
            context.addIssue({
              code: "custom",
              message: `unknown proposed dependency ${dependency.key}`,
              path: ["tasks", index, "dependsOn"],
            });
          }
          if (dependency.key === task.key) {
            context.addIssue({
              code: "custom",
              message: "proposed task cannot depend on itself",
              path: ["tasks", index, "dependsOn"],
            });
          }
        }
      }
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
  open_negotiation: "Open a sourced proposal between registered agent participants.",
  object_negotiation: "Object to an open proposal with a reason and alternative.",
  escalate_negotiation: "Escalate an objected negotiation to the human control plane.",
  resolve_negotiation:
    "Resolve only an un-escalated agent negotiation; human resolution stays outside MCP.",
  propose_plan:
    "Propose an additive task graph for Supervisor review without mutating tasks.",
} as const satisfies Record<ToolName, string>);
import { AGENT_TOOL_NAMES } from "@agent-os/agent-sdk";
