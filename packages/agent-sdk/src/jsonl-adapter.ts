import {
  AgentSdkContractError,
  parseAdapterDescriptor,
  parseAdapterResult,
  parseRunnerObservation,
} from "./contracts.js";
import type {
  AbortSignalLike,
  AdapterDescriptor,
  AdapterInvocation,
  AdapterResult,
  AgentAdapter,
  RunnerObservation,
} from "./contracts.js";

export type ProcessCommand = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}>;
export type ProcessExit = Readonly<{ code: number | null; signal?: string }>;
export interface SpawnedProcess {
  onStdout(listener: (chunk: string) => void): () => void;
  onStderr(listener: (chunk: string) => void): () => void;
  wait(): Promise<ProcessExit>;
  kill(): void;
}
export interface ProcessSpawner {
  spawn(command: ProcessCommand): SpawnedProcess;
}
export interface AdapterScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}
export type JsonLineInterpretation = Readonly<{
  text?: string;
  sessionId?: string;
  observations?: readonly RunnerObservation[];
}>;
export type JsonLineAdapterOptions = Readonly<{
  descriptor: AdapterDescriptor;
  spawner: ProcessSpawner;
  scheduler: AdapterScheduler;
  timeoutMs: number;
  now?: () => number;
  environment?: Readonly<Record<string, string | undefined>>;
  buildCommand(
    invocation: AdapterInvocation,
  ): Readonly<{ executable: string; args: readonly string[] }>;
  interpretLine(value: unknown): JsonLineInterpretation | undefined;
  maxLineBytes?: number;
  maxStderrBytes?: number;
}>;

export class AdapterExecutionError extends Error {
  readonly code:
    | "BUSY"
    | "CANCELLED"
    | "INVALID_COMMAND"
    | "PROCESS_FAILED"
    | "PROTOCOL"
    | "TIMEOUT";
  constructor(
    code: AdapterExecutionError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AdapterExecutionError";
    this.code = code;
  }
}

const SCOPED_ENV = new Set(["AGENT_OS_URL", "AGENT_OS_TOKEN"]);
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}
function bytes(value: string): number {
  let total = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    total += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return total;
}
export function sanitizeAdapterEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  scoped: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (!name.toUpperCase().startsWith("AGENT_OS_") && value !== undefined)
      result[name] = value;
  }
  for (const [name, value] of Object.entries(scoped)) {
    if (name.toUpperCase().startsWith("AGENT_OS_") && !SCOPED_ENV.has(name))
      throw new AdapterExecutionError(
        "INVALID_COMMAND",
        `control-plane variable ${name} is forbidden`,
      );
    if (!text(value))
      throw new AdapterExecutionError(
        "INVALID_COMMAND",
        `environment ${name} must be non-empty`,
      );
    result[name] = value;
  }
  return Object.freeze(result);
}

export class JsonLineSubprocessAdapter implements AgentAdapter {
  readonly descriptor: AdapterDescriptor;
  readonly #options: JsonLineAdapterOptions;
  readonly #now: () => number;
  readonly #maxLineBytes: number;
  readonly #maxStderrBytes: number;
  #active:
    | Readonly<{
        cancel: (cause: AdapterExecutionError) => void;
        done: Promise<void>;
      }>
    | undefined;
  #closed = false;

  constructor(options: JsonLineAdapterOptions) {
    if (options === null || typeof options !== "object")
      throw new AgentSdkContractError(
        "INVALID_ADAPTER",
        "JSONL adapter options are required",
      );
    this.descriptor = parseAdapterDescriptor(options.descriptor);
    if (
      typeof options.spawner?.spawn !== "function" ||
      typeof options.scheduler?.schedule !== "function" ||
      typeof options.scheduler.cancel !== "function" ||
      typeof options.buildCommand !== "function" ||
      typeof options.interpretLine !== "function" ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1
    )
      throw new AgentSdkContractError(
        "INVALID_ADAPTER",
        "JSONL adapter options are invalid",
      );
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    this.#maxStderrBytes = options.maxStderrBytes ?? 8192;
  }

  async send(
    invocation: AdapterInvocation,
    options: Readonly<{
      signal?: AbortSignalLike;
      emit?: (event: RunnerObservation) => void;
    }> = {},
  ): Promise<AdapterResult> {
    if (this.#closed) throw new AdapterExecutionError("CANCELLED", "adapter is closed");
    if (this.#active) throw new AdapterExecutionError("BUSY", "adapter is busy");
    if (
      !text(invocation?.prompt) ||
      !text(invocation.workspace) ||
      (invocation.model !== undefined && !text(invocation.model)) ||
      (invocation.sessionId !== undefined && !text(invocation.sessionId))
    )
      throw new AgentSdkContractError("INVALID_REQUEST", "adapter invocation is invalid");
    if (options.signal?.aborted)
      throw new AdapterExecutionError("CANCELLED", "adapter invocation was cancelled");
    const built = this.#options.buildCommand(invocation);
    if (
      !text(built?.executable) ||
      !Array.isArray(built.args) ||
      built.args.some((arg) => !text(arg))
    )
      throw new AdapterExecutionError("INVALID_COMMAND", "adapter command is invalid");
    const command = Object.freeze({
      executable: built.executable,
      args: Object.freeze([...built.args, ...(invocation.mcp?.args ?? [])]),
      cwd: invocation.workspace,
      env: sanitizeAdapterEnvironment(
        this.#options.environment ?? {},
        invocation.mcp?.env,
      ),
    });
    const process = this.#options.spawner.spawn(command);
    if (
      typeof process?.onStdout !== "function" ||
      typeof process.onStderr !== "function" ||
      typeof process.wait !== "function" ||
      typeof process.kill !== "function"
    )
      throw new AdapterExecutionError(
        "PROCESS_FAILED",
        "spawner returned an invalid process",
      );

    const started = this.#now();
    let stdout = "";
    let stderr = "";
    let output = "";
    let sessionId = invocation.sessionId ?? null;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let rejectStop!: (cause: unknown) => void;
    const stopped = new Promise<never>((_, reject) => {
      rejectStop = reject;
    });
    let stoppedOnce = false;
    const stop = (cause: AdapterExecutionError) => {
      if (stoppedOnce) return;
      stoppedOnce = true;
      try {
        process.kill();
      } finally {
        rejectStop(cause);
      }
    };
    this.#active = { cancel: stop, done };
    const onAbort = () =>
      stop(new AdapterExecutionError("CANCELLED", "adapter invocation was cancelled"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const parseLine = (line: string) => {
      if (bytes(line) > this.#maxLineBytes)
        return stop(
          new AdapterExecutionError("PROTOCOL", "adapter JSONL line exceeds limit"),
        );
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      try {
        const interpreted = this.#options.interpretLine(value);
        if (!interpreted) return;
        if (interpreted.text !== undefined) {
          if (typeof interpreted.text !== "string") {
            throw new TypeError("adapter text is invalid");
          }
          output += interpreted.text;
        }
        if (interpreted.sessionId !== undefined) {
          if (!text(interpreted.sessionId)) {
            throw new TypeError("adapter session is invalid");
          }
          sessionId = interpreted.sessionId;
        }
        for (const observation of interpreted.observations ?? []) {
          const normalized = parseRunnerObservation(observation);
          options.emit?.(normalized);
        }
      } catch (cause) {
        stop(
          new AdapterExecutionError("PROTOCOL", "adapter line interpretation failed", {
            cause,
          }),
        );
      }
    };
    const offOut = process.onStdout((chunk) => {
      stdout += chunk;
      for (let end = stdout.indexOf("\n"); end >= 0; end = stdout.indexOf("\n")) {
        const line = stdout.slice(0, end).trim();
        stdout = stdout.slice(end + 1);
        if (line) parseLine(line);
      }
      if (bytes(stdout) > this.#maxLineBytes)
        stop(
          new AdapterExecutionError("PROTOCOL", "unterminated JSONL line exceeds limit"),
        );
    });
    const offErr = process.onStderr((chunk) => {
      if (bytes(stderr) < this.#maxStderrBytes) stderr += chunk;
    });
    const timer = this.#options.scheduler.schedule(
      () =>
        stop(
          new AdapterExecutionError(
            "TIMEOUT",
            `adapter exceeded ${this.#options.timeoutMs}ms`,
          ),
        ),
      this.#options.timeoutMs,
    );
    try {
      const exit = await Promise.race([process.wait(), stopped]);
      if (stdout.trim()) parseLine(stdout.trim());
      if (exit.code !== 0)
        throw new AdapterExecutionError(
          "PROCESS_FAILED",
          `adapter process exited ${exit.code ?? exit.signal ?? "unknown"}${stderr.trim() ? `: ${stderr.trim().slice(0, this.#maxStderrBytes)}` : ""}`,
        );
      return parseAdapterResult({
        text: output.trim(),
        sessionId,
        durationMs: this.#now() - started,
        fresh: invocation.sessionId === undefined,
      });
    } finally {
      this.#options.scheduler.cancel(timer);
      options.signal?.removeEventListener("abort", onAbort);
      offOut();
      offErr();
      this.#active = undefined;
      finish();
    }
  }

  async cancel(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    active.cancel(
      new AdapterExecutionError("CANCELLED", "adapter invocation was cancelled"),
    );
    await active.done;
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.cancel();
  }
}
