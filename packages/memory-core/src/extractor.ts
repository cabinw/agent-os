import {
  eventIdSchema,
  nonEmptyStringSchema,
  projectIdSchema,
} from "@agent-os/event-core";
import type { EventId, ProjectId, StoredEvent } from "@agent-os/event-core";
import {
  KNOWLEDGE_SUMMARY_JSON_SCHEMA,
  parseKnowledgeDraft,
  parseKnowledgeSummary,
} from "./schemas.js";
import type { KnowledgeDraft, KnowledgeSummary } from "./schemas.js";
import { KnowledgeWindowError, buildKnowledgeWindow } from "./windows.js";
import type { KnowledgeWindow } from "./windows.js";

type Awaitable<Value> = Value | Promise<Value>;

export type KnowledgeSummarizerInput = Readonly<{
  project: ProjectId;
  anchor: EventId;
  trigger: KnowledgeWindow["trigger"];
  possibleTypes: KnowledgeWindow["possibleTypes"];
  events: KnowledgeWindow["events"];
  outputSchema: Readonly<Record<string, unknown>>;
}>;

export interface KnowledgeSummarizer {
  summarize(input: KnowledgeSummarizerInput): Awaitable<unknown>;
}

export type KnowledgeAdmissionCommand = Readonly<{
  project: ProjectId;
  causedBy: EventId;
  operationToken: string;
  draft: KnowledgeDraft;
}>;

export interface KnowledgeAdmissionPort {
  admit(command: KnowledgeAdmissionCommand): Awaitable<void>;
}

export type KnowledgeExtractionRequest = Readonly<{
  project: ProjectId;
  history: readonly StoredEvent[];
  anchor: EventId;
  operationToken: string;
}>;

export type KnowledgeExtractorOptions = Readonly<{
  summarizer: KnowledgeSummarizer;
  admission: KnowledgeAdmissionPort;
}>;

export type KnowledgeExtractionErrorCode =
  | "ADMISSION_FAILURE"
  | "DISALLOWED_TYPE"
  | "INVALID_OPTIONS"
  | "INVALID_REQUEST"
  | "INVALID_SUMMARY"
  | "MODEL_FAILURE"
  | "WINDOW_FAILURE";

export class KnowledgeExtractionError extends Error {
  readonly code: KnowledgeExtractionErrorCode;

  constructor(
    code: KnowledgeExtractionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KnowledgeExtractionError";
    this.code = code;
  }
}

function requirePort(value: unknown, method: "admit" | "summarize", label: string): void {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as Record<string, unknown>)[method] !== "function"
  ) {
    throw new KnowledgeExtractionError(
      "INVALID_OPTIONS",
      `${label}.${method} must be a function`,
    );
  }
}

function parseRequest(value: KnowledgeExtractionRequest): Readonly<{
  project: ProjectId;
  history: readonly StoredEvent[];
  anchor: EventId;
  operationToken: string;
}> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new KnowledgeExtractionError(
      "INVALID_REQUEST",
      "knowledge extraction request is required",
    );
  }
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        key !== "project" &&
        key !== "history" &&
        key !== "anchor" &&
        key !== "operationToken",
    )
  ) {
    throw new KnowledgeExtractionError(
      "INVALID_REQUEST",
      "knowledge extraction request has unknown fields",
    );
  }
  const project = projectIdSchema.safeParse(value.project);
  const anchor = eventIdSchema.safeParse(value.anchor);
  const operationToken = nonEmptyStringSchema.max(256).safeParse(value.operationToken);
  if (!project.success || !anchor.success || !operationToken.success) {
    throw new KnowledgeExtractionError(
      "INVALID_REQUEST",
      "knowledge extraction authority is invalid",
    );
  }
  if (!Array.isArray(value.history)) {
    throw new KnowledgeExtractionError(
      "INVALID_REQUEST",
      "knowledge extraction history must be an array",
    );
  }
  return Object.freeze({
    project: project.data,
    history: value.history,
    anchor: anchor.data,
    operationToken: operationToken.data,
  });
}

export class KnowledgeExtractor {
  readonly #summarizer: KnowledgeSummarizer;
  readonly #admission: KnowledgeAdmissionPort;

  constructor(options: KnowledgeExtractorOptions) {
    if (options === null || typeof options !== "object") {
      throw new KnowledgeExtractionError(
        "INVALID_OPTIONS",
        "KnowledgeExtractor options are required",
      );
    }
    requirePort(options.summarizer, "summarize", "KnowledgeSummarizer");
    requirePort(options.admission, "admit", "KnowledgeAdmissionPort");
    this.#summarizer = options.summarizer;
    this.#admission = options.admission;
  }

  async extract(
    requestValue: KnowledgeExtractionRequest,
  ): Promise<KnowledgeAdmissionCommand> {
    const request = parseRequest(requestValue);
    let window: KnowledgeWindow;
    try {
      window = buildKnowledgeWindow(request.history, request.anchor);
    } catch (cause) {
      throw new KnowledgeExtractionError(
        "WINDOW_FAILURE",
        "knowledge evidence window is invalid",
        { cause },
      );
    }
    if (window.project !== request.project) {
      throw new KnowledgeExtractionError(
        "INVALID_REQUEST",
        "knowledge extraction project does not match history",
      );
    }

    const modelInput: KnowledgeSummarizerInput = Object.freeze({
      project: window.project,
      anchor: window.anchor,
      trigger: window.trigger,
      possibleTypes: window.possibleTypes,
      events: window.events,
      outputSchema: KNOWLEDGE_SUMMARY_JSON_SCHEMA,
    });
    let raw: unknown;
    try {
      raw = await this.#summarizer.summarize(modelInput);
    } catch (cause) {
      throw new KnowledgeExtractionError("MODEL_FAILURE", "summarizer failed", {
        cause,
      });
    }

    let summary: KnowledgeSummary;
    try {
      summary = parseKnowledgeSummary(raw);
    } catch (cause) {
      throw new KnowledgeExtractionError(
        "INVALID_SUMMARY",
        "summarizer returned an invalid knowledge summary",
        { cause },
      );
    }
    if (!window.possibleTypes.includes(summary.type)) {
      throw new KnowledgeExtractionError(
        "DISALLOWED_TYPE",
        `anchor ${window.anchor} does not permit ${summary.type}`,
      );
    }

    const draft = parseKnowledgeDraft({
      ...summary,
      sourceEvents: window.sourceEvents,
      ...(window.relatedTasks.length === 0 ? {} : { relatedTasks: window.relatedTasks }),
    });
    const command: KnowledgeAdmissionCommand = Object.freeze({
      project: request.project,
      causedBy: window.anchor,
      operationToken: request.operationToken,
      draft,
    });
    try {
      await this.#admission.admit(command);
    } catch (cause) {
      throw new KnowledgeExtractionError(
        "ADMISSION_FAILURE",
        "knowledge admission failed",
        { cause },
      );
    }
    return command;
  }
}

export function createKnowledgeExtractor(
  options: KnowledgeExtractorOptions,
): KnowledgeExtractor {
  return new KnowledgeExtractor(options);
}

export function isKnowledgeWindowError(cause: unknown): cause is KnowledgeWindowError {
  return cause instanceof KnowledgeWindowError;
}
