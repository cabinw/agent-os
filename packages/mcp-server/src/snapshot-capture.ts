import {
  type EntityId,
  type EventInput,
  type ProjectId,
  type StoredEvent,
  entityIdSchema,
  parseEventInput,
  parseStoredEvent,
  rfc3339Schema,
} from "@agent-os/event-core";

type Awaitable<Value> = Value | Promise<Value>;

export type SnapshotFrame = Readonly<{
  mediaType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
  width: number;
  height: number;
}>;

export interface ProjectSnapshotRenderer {
  capture(
    input: Readonly<{ project: ProjectId; milestone: StoredEvent<"knowledge.created"> }>,
  ): Awaitable<SnapshotFrame>;
}

export interface ProjectSnapshotStorage {
  persist(
    input: Readonly<{
      project: ProjectId;
      milestone: StoredEvent<"knowledge.created">;
      frame: SnapshotFrame;
    }>,
  ): Awaitable<Readonly<{ uri: string }>>;
}

export interface ProjectSnapshotWriter {
  append(
    input: EventInput<"project.snapshot.captured">,
    options: Readonly<{ token: string }>,
  ): Awaitable<StoredEvent<"project.snapshot.captured">>;
}

export type ProjectSnapshotCaptureOptions = Readonly<{
  renderer: ProjectSnapshotRenderer;
  storage: ProjectSnapshotStorage;
  writer: ProjectSnapshotWriter;
  actor: EntityId;
  now: () => string;
}>;

export interface ProjectSnapshotCapture {
  handle(event: StoredEvent): Promise<StoredEvent<"project.snapshot.captured"> | null>;
}

export interface ProjectSnapshotEventSource {
  subscribe(handler: (event: StoredEvent) => void | Promise<void>): () => void;
}

export class ProjectSnapshotCaptureError extends Error {
  readonly code:
    | "CAPTURE_FAILED"
    | "INVALID_FRAME"
    | "INVALID_OPTIONS"
    | "INVALID_URI"
    | "STORE_FAILED"
    | "WRITE_FAILED";

  constructor(
    code: ProjectSnapshotCaptureError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectSnapshotCaptureError";
    this.code = code;
  }
}

function assertOptions(options: ProjectSnapshotCaptureOptions): EntityId {
  const actor = entityIdSchema.safeParse(options?.actor);
  if (
    !actor.success ||
    typeof options?.renderer?.capture !== "function" ||
    typeof options?.storage?.persist !== "function" ||
    typeof options?.writer?.append !== "function" ||
    typeof options?.now !== "function"
  ) {
    throw new ProjectSnapshotCaptureError(
      "INVALID_OPTIONS",
      "renderer, storage, writer, actor, and clock are required",
    );
  }
  return actor.data;
}

function parseFrame(value: SnapshotFrame): SnapshotFrame {
  if (
    value === null ||
    typeof value !== "object" ||
    (value.mediaType !== "image/png" && value.mediaType !== "image/jpeg") ||
    !(value.bytes instanceof Uint8Array) ||
    value.bytes.byteLength === 0 ||
    value.bytes.byteLength > 25 * 1024 * 1024 ||
    !Number.isSafeInteger(value.width) ||
    value.width <= 0 ||
    value.width > 8192 ||
    !Number.isSafeInteger(value.height) ||
    value.height <= 0 ||
    value.height > 8192
  ) {
    throw new ProjectSnapshotCaptureError(
      "INVALID_FRAME",
      "snapshot frame must be a bounded PNG or JPEG raster",
    );
  }
  return value;
}

function parseUri(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^snapshots\/[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u.test(value) ||
    value.includes("..") ||
    value.includes("//")
  ) {
    throw new ProjectSnapshotCaptureError(
      "INVALID_URI",
      "snapshot storage must return a canonical relative snapshots/ URI",
    );
  }
  return value;
}

export function createProjectSnapshotCapture(
  options: ProjectSnapshotCaptureOptions,
): ProjectSnapshotCapture {
  const actor = assertOptions(options);
  return Object.freeze({
    async handle(value: StoredEvent) {
      const event = parseStoredEvent(value);
      if (event.type !== "knowledge.created" || event.payload.type !== "milestone") {
        return null;
      }
      let frame: SnapshotFrame;
      try {
        frame = parseFrame(
          await options.renderer.capture({ project: event.project, milestone: event }),
        );
      } catch (cause) {
        if (cause instanceof ProjectSnapshotCaptureError) throw cause;
        throw new ProjectSnapshotCaptureError(
          "CAPTURE_FAILED",
          `snapshot capture failed for ${event.id}`,
          { cause },
        );
      }
      let uri: string;
      try {
        uri = parseUri(
          (
            await options.storage.persist({
              project: event.project,
              milestone: event,
              frame,
            })
          ).uri,
        );
      } catch (cause) {
        if (cause instanceof ProjectSnapshotCaptureError) throw cause;
        throw new ProjectSnapshotCaptureError(
          "STORE_FAILED",
          `snapshot storage failed for ${event.id}`,
          { cause },
        );
      }
      const capturedAt = options.now();
      if (!rfc3339Schema.safeParse(capturedAt).success) {
        throw new ProjectSnapshotCaptureError(
          "INVALID_OPTIONS",
          "snapshot clock returned an invalid timestamp",
        );
      }
      const input = parseEventInput({
        type: "project.snapshot.captured",
        project: event.project,
        actor: { kind: "system", id: actor },
        subject: { kind: "project", id: event.project },
        causedBy: event.id,
        payload: { label: event.payload.title, image: uri, at: capturedAt },
      }) as EventInput<"project.snapshot.captured">;
      try {
        return await options.writer.append(input, { token: `snapshot:${event.id}` });
      } catch (cause) {
        throw new ProjectSnapshotCaptureError(
          "WRITE_FAILED",
          `snapshot event append failed for ${event.id}`,
          { cause },
        );
      }
    },
  });
}

export function connectProjectSnapshotCapture(
  source: ProjectSnapshotEventSource,
  capture: ProjectSnapshotCapture,
): () => void {
  if (
    source === null ||
    typeof source !== "object" ||
    typeof source.subscribe !== "function" ||
    capture === null ||
    typeof capture !== "object" ||
    typeof capture.handle !== "function"
  ) {
    throw new ProjectSnapshotCaptureError(
      "INVALID_OPTIONS",
      "snapshot event source and capture service are required",
    );
  }
  const unsubscribe = source.subscribe(async (event) => {
    await capture.handle(event);
  });
  if (typeof unsubscribe !== "function") {
    throw new ProjectSnapshotCaptureError(
      "INVALID_OPTIONS",
      "snapshot event source must return an unsubscribe function",
    );
  }
  return unsubscribe;
}
