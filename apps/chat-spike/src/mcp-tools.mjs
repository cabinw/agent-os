/**
 * The participation channel: three of the v0.3 tools, and the whole trust
 * boundary (docs/protocol/mcp-protocol.md, ADR-001).
 *
 * Everything an agent sends crosses exactly here and is validated here. The
 * three things an agent can never do are enforced structurally rather than by
 * checking for them:
 *
 *   1. **Write an event.** Tools take a payload; the envelope — id, seq, at,
 *      actor — is built by the runtime. There is no field an agent could use.
 *   2. **Set task status.** No such tool exists in this surface.
 *   3. **Approve anything.** Same. A message is guidance, never an approval
 *      (docs/product/threads.md).
 *
 * Plus authorization: an agent may only speak as itself. `from` must match the
 * caller's registered id, so one agent cannot impersonate another.
 */

import { ValidationError, validate } from "./validate.mjs";

/** The human is always addressable and is never a registered agent. */
export const HUMAN_ID = "you";

const MESSAGE_TYPES = [
  "instruction",
  "question",
  "answer",
  "progress",
  "report",
  "review",
  "warning",
];

export const TOOL_SPECS = {
  register_agent: {
    description:
      "Register this agent with Agent OS. Required before any other call. Declares capabilities, never a provider-specific behaviour.",
    schema: {
      id: { type: "string", required: true },
      name: { type: "string", required: true },
      provider: { type: "string" },
      role: { type: "string" },
      capabilities: { type: "string[]" },
    },
  },

  find_agent: {
    description:
      "Find agents by the capability the work needs. This is the only supported way to discover who can do something — do not name an agent you were not given here, and do not choose by vendor (ADR-004).",
    schema: {
      capabilities: { type: "string[]" },
      available: { type: "boolean" },
    },
  },

  get_context: {
    description:
      "Fetch the shared context for the current work: prior messages and decisions. Call this before starting — working from an isolated context is the failure this protocol exists to prevent.",
    schema: {
      include: { type: "string[]" },
      limit: { type: "number" },
    },
  },

  create_task: {
    description:
      "Create a task. Note there is no executor field — assignment is a separate, explicit act, so that who does the work is always a decision someone made rather than a side effect of describing it.",
    schema: {
      title: { type: "string", required: true },
      requires: { type: "string[]" },
      detail: { type: "string" },
    },
  },

  assign_task: {
    description:
      "Assign a task to an executor, which wakes it. Omit `executor` to let the runtime match by capability — preferred, because it cannot pick a vendor by name.",
    schema: {
      task: { type: "string", required: true },
      executor: { type: "string" },
    },
  },

  report_result: {
    description:
      "Report a finished task. This moves it to `review`, never to `completed` — acceptance is someone else's act. You cannot accept your own work.",
    schema: {
      task: { type: "string", required: true },
      status: { type: "string", required: true, enum: ["completed", "failed"] },
      summary: { type: "string", required: true },
      outputs: { type: "string[]" },
    },
  },

  send_message: {
    description:
      "Send a message into the thread. This is how an agent speaks; it does not return text to the caller.",
    schema: {
      from: { type: "string", required: true },
      to: { type: "string", required: true },
      type: { type: "string", required: true, enum: MESSAGE_TYPES },
      content: { type: "string", required: true },
      task: { type: "string" },
      replyTo: { type: "string" },
      attachments: { type: "string[]" },
    },
  },
};

/**
 * @param {object} runtime
 * @param {(payload: object) => object} runtime.registerAgent
 * @param {(payload: object, caller: string|null) => object} runtime.sendMessage
 * @param {(payload: object) => object} runtime.findAgent
 * @param {(payload: object) => object} runtime.getContext
 * @param {() => Set<string>} runtime.registeredIds
 */
export function createToolRouter(runtime) {
  return {
    list() {
      return Object.entries(TOOL_SPECS).map(([name, s]) => ({
        name,
        description: s.description,
        inputSchema: toJsonSchema(s.schema),
      }));
    },

    /**
     * @param {string} name
     * @param {object} args
     * @param {string|null} caller  registered agent id, when known
     */
    async call(name, args, caller = null) {
      const spec = TOOL_SPECS[name];
      if (!spec) throw new ValidationError(`未知工具：${name}`);

      const params = validate(spec.schema, args ?? {}, name);

      switch (name) {
        case "register_agent":
          return runtime.registerAgent(params);

        case "find_agent":
          return runtime.findAgent(params);

        case "create_task":
          return runtime.createTask(params, caller);

        case "assign_task":
          return runtime.assignTask(params, caller);

        case "report_result": {
          // Rule 3, structurally: `status` names the *outcome the executor
          // claims*, and the runtime still routes it to `review`. An agent
          // cannot mark its own work done, including by saying so.
          if (caller && runtime.executorOf(params.task) !== caller) {
            throw new ValidationError(
              `${params.task} 不是指派给 "${caller}" 的，不能替别人交付`,
            );
          }
          return runtime.reportResult(params, caller);
        }

        case "get_context":
          return runtime.getContext(params);

        case "send_message": {
          // Authorization, not validation: the shape is fine, the claim is not.
          if (!runtime.registeredIds().has(params.from)) {
            throw new ValidationError(
              `未注册的发送者 "${params.from}"——必须先调用 register_agent`,
            );
          }
          if (caller && params.from !== caller) {
            throw new ValidationError(
              `不能以 "${params.from}" 的身份发言：调用方注册为 "${caller}"`,
            );
          }
          // A message addressed to an agent wakes it. Refusing an unknown
          // recipient here is what keeps `to` from becoming a dead letter that
          // looks delivered — see the routing note in server.mjs.
          if (params.to !== HUMAN_ID && !runtime.registeredIds().has(params.to)) {
            throw new ValidationError(
              `未知收件人 "${params.to}"——先用 find_agent 查谁在，或发给 "${HUMAN_ID}"`,
            );
          }
          return runtime.sendMessage(params, caller);
        }

        default:
          throw new ValidationError(`未处理的工具：${name}`);
      }
    },
  };
}

function toJsonSchema(schema) {
  const properties = {};
  const required = [];
  for (const [key, rule] of Object.entries(schema)) {
    properties[key] =
      rule.type === "string[]"
        ? { type: "array", items: { type: "string" } }
        : { type: rule.type, ...(rule.enum ? { enum: rule.enum } : {}) };
    if (rule.required) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}
