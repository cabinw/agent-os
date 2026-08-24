import type { EntityId, ProjectId, TaskId } from "@agent-os/event-core";
import { McpToolError } from "./errors.js";
import type { McpCallContext, ToolInputMap, ToolName } from "./schemas.js";

type Awaitable<T> = T | Promise<T>;

export type AuthorizedTask = Readonly<{
  owner: EntityId;
  executor?: EntityId;
}>;

export interface AuthorizationPort {
  isRegistered(context: McpCallContext): Awaitable<boolean>;
  task(project: ProjectId, task: TaskId): Awaitable<AuthorizedTask | null>;
}

const OWNER_TOOLS = new Set<ToolName>(["assign_task"]);
const EXECUTOR_TOOLS = new Set<ToolName>([
  "update_task",
  "notify_blocked",
  "report_result",
]);

function denied(
  code:
    | "AUTHORIZATION_UNAVAILABLE"
    | "NOT_REGISTERED"
    | "NOT_TASK_EXECUTOR"
    | "NOT_TASK_OWNER"
    | "TASK_NOT_FOUND",
  tool: ToolName,
  message: string,
  options?: ErrorOptions,
): never {
  throw new McpToolError(code, tool, message, [], options);
}

async function registration(
  authorization: AuthorizationPort,
  tool: ToolName,
  context: McpCallContext,
): Promise<void> {
  let registered: boolean;
  try {
    registered = await authorization.isRegistered(context);
  } catch (cause) {
    denied(
      "AUTHORIZATION_UNAVAILABLE",
      tool,
      "agent registration could not be verified",
      { cause },
    );
  }
  if (!registered) {
    denied(
      "NOT_REGISTERED",
      tool,
      `agent ${context.principal.id} is not registered on host ${context.host}`,
    );
  }
}

async function taskFact(
  authorization: AuthorizationPort,
  tool: ToolName,
  context: McpCallContext,
  taskId: TaskId,
): Promise<AuthorizedTask> {
  let task: AuthorizedTask | null;
  try {
    task = await authorization.task(context.project, taskId);
  } catch (cause) {
    denied("AUTHORIZATION_UNAVAILABLE", tool, "task authority could not be verified", {
      cause,
    });
  }
  if (task === null) {
    denied("TASK_NOT_FOUND", tool, `task ${taskId} does not exist in this project`);
  }
  return task;
}

export async function authorizeToolCall<Name extends ToolName>(
  authorization: AuthorizationPort,
  name: Name,
  input: ToolInputMap[Name],
  context: McpCallContext,
): Promise<void> {
  if (name === "register_agent") return;
  await registration(authorization, name, context);
  if (!OWNER_TOOLS.has(name) && !EXECUTOR_TOOLS.has(name)) return;

  const taskId = (input as ToolInputMap["assign_task"]).task;
  const task = await taskFact(authorization, name, context, taskId);
  if (OWNER_TOOLS.has(name) && task.owner !== context.principal.id) {
    denied(
      "NOT_TASK_OWNER",
      name,
      `agent ${context.principal.id} does not own task ${taskId}`,
    );
  }
  if (EXECUTOR_TOOLS.has(name) && task.executor !== context.principal.id) {
    denied(
      "NOT_TASK_EXECUTOR",
      name,
      `agent ${context.principal.id} is not the executor of task ${taskId}`,
    );
  }
}
