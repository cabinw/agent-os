import type { Awaitable } from "./contracts.js";

export const AGENT_TOOL_NAMES = Object.freeze([
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
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];
export interface AgentToolTransport {
  call(tool: AgentToolName, input: unknown): Awaitable<unknown>;
}
export class AgentClientError extends Error {
  readonly code: "CLOSED" | "INVALID_TRANSPORT";
  constructor(code: AgentClientError["code"], message: string) {
    super(message);
    this.name = "AgentClientError";
    this.code = code;
  }
}
export interface AgentClient {
  call(tool: AgentToolName, input: unknown): Promise<unknown>;
  register(input: unknown): Promise<unknown>;
  reportProgress(input: unknown): Promise<unknown>;
  reportResult(input: unknown): Promise<unknown>;
  sendMessage(input: unknown): Promise<unknown>;
  requestApproval(input: unknown): Promise<unknown>;
  close(): void;
}
export function createAgentClient(transport: AgentToolTransport): AgentClient {
  if (
    transport === null ||
    typeof transport !== "object" ||
    typeof transport.call !== "function"
  ) {
    throw new AgentClientError(
      "INVALID_TRANSPORT",
      "AgentToolTransport.call is required",
    );
  }
  let closed = false;
  const call = async (tool: AgentToolName, input: unknown) => {
    if (closed) throw new AgentClientError("CLOSED", "AgentClient is closed");
    if (!(AGENT_TOOL_NAMES as readonly string[]).includes(tool)) {
      throw new AgentClientError("INVALID_TRANSPORT", `unknown Agent OS tool ${tool}`);
    }
    return await transport.call(tool, input);
  };
  return Object.freeze({
    call,
    register: (input: unknown) => call("register_agent", input),
    reportProgress: (input: unknown) => call("update_task", input),
    reportResult: (input: unknown) => call("report_result", input),
    sendMessage: (input: unknown) => call("send_message", input),
    requestApproval: (input: unknown) => call("request_approval", input),
    close: () => {
      closed = true;
    },
  });
}
