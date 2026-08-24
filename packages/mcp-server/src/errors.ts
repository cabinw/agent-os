export type McpToolErrorCode =
  | "AUTHORIZATION_UNAVAILABLE"
  | "INVALID_ARGUMENTS"
  | "INVALID_CONTEXT"
  | "NOT_REGISTERED"
  | "NOT_TASK_EXECUTOR"
  | "NOT_TASK_OWNER"
  | "PRINCIPAL_MISMATCH"
  | "TASK_NOT_FOUND"
  | "UNKNOWN_TOOL";

export class McpToolError extends Error {
  readonly code: McpToolErrorCode;
  readonly tool: string;
  readonly issues: readonly unknown[];

  constructor(
    code: McpToolErrorCode,
    tool: string,
    message: string,
    issues: readonly unknown[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "McpToolError";
    this.code = code;
    this.tool = tool;
    this.issues = issues;
  }
}
