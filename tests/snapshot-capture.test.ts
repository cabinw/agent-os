import { beforeEach, describe, expect, it } from "vitest";
import {
  type EventInput,
  type StoredEvent,
  newEventId,
  parseStoredEvent,
} from "../packages/event-core/src/index.js";
import {
  type ProjectSnapshotCaptureError,
  connectProjectSnapshotCapture,
  createProjectSnapshotCapture,
} from "../packages/mcp-server/src/index.js";

const PROJECT = "proj_snapshot_capture";
const AT = "2026-08-24T11:00:00Z";
const SOURCE = "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function knowledge(type: "milestone" | "decision" = "milestone") {
  return parseStoredEvent({
    schemaVersion: 1,
    id: newEventId(),
    seq: 5,
    type: "knowledge.created",
    project: PROJECT,
    actor: { kind: "agent", id: "agent-memory" },
    subject: { kind: "knowledge", id: "KN-043" },
    at: "2026-08-24T10:59:00Z",
    payload: {
      type,
      title: "Local flow milestone",
      summary: "The local Agent flow passed its gate.",
      sourceEvents: [SOURCE],
      ...(type === "decision" ? { rationale: "The evidence supports this choice." } : {}),
    },
  }) as StoredEvent<"knowledge.created">;
}

describe("RM-4.3 milestone snapshot capture", () => {
  let renders: StoredEvent<"knowledge.created">[];
  let persisted: Uint8Array[];
  let writes: Array<{
    input: EventInput<"project.snapshot.captured">;
    token: string;
  }>;

  beforeEach(() => {
    renders = [];
    persisted = [];
    writes = [];
  });

  function service(uri = "snapshots/proj_snapshot_capture/milestone-5.png") {
    return createProjectSnapshotCapture({
      actor: "snapshot-runtime" as never,
      now: () => AT,
      renderer: {
        capture(input) {
          renders.push(input.milestone);
          return {
            mediaType: "image/png",
            bytes: new Uint8Array([137, 80, 78, 71]),
            width: 1440,
            height: 900,
          };
        },
      },
      storage: {
        persist(input) {
          persisted.push(input.frame.bytes);
          return { uri };
        },
      },
      writer: {
        append(input, options) {
          writes.push({ input, token: options.token });
          return parseStoredEvent({
            ...input,
            schemaVersion: 1,
            id: newEventId(),
            seq: 6,
            at: AT,
          }) as StoredEvent<"project.snapshot.captured">;
        },
      },
    });
  }

  it("captures, persists, and appends one sourced snapshot for a milestone", async () => {
    const milestone = knowledge();
    const result = await service().handle(milestone);
    expect(renders).toEqual([milestone]);
    expect(persisted[0]).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      token: `snapshot:${milestone.id}`,
      input: {
        type: "project.snapshot.captured",
        project: PROJECT,
        actor: { kind: "system", id: "snapshot-runtime" },
        subject: { kind: "project", id: PROJECT },
        causedBy: milestone.id,
        payload: {
          label: "Local flow milestone",
          image: "snapshots/proj_snapshot_capture/milestone-5.png",
          at: AT,
        },
      },
    });
    expect(result?.type).toBe("project.snapshot.captured");
  });

  it("ignores every non-milestone event without touching capture or storage", async () => {
    expect(await service().handle(knowledge("decision"))).toBeNull();
    expect(renders).toHaveLength(0);
    expect(persisted).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("uses the milestone id as the stable retry token", async () => {
    const milestone = knowledge();
    const capture = service();
    await capture.handle(milestone);
    await capture.handle(milestone);
    expect(writes.map((write) => write.token)).toEqual([
      `snapshot:${milestone.id}`,
      `snapshot:${milestone.id}`,
    ]);
  });

  it("connects the capture service to an immutable event source", async () => {
    const capture = service();
    let handler: ((event: StoredEvent) => void | Promise<void>) | undefined;
    let unsubscribed = false;
    const unsubscribe = connectProjectSnapshotCapture(
      {
        subscribe(candidate) {
          handler = candidate;
          return () => {
            unsubscribed = true;
          };
        },
      },
      capture,
    );
    await handler?.(knowledge());
    expect(writes).toHaveLength(1);
    unsubscribe();
    expect(unsubscribed).toBe(true);
  });

  it.each([
    "../outside.png",
    "/absolute.png",
    "https://example.com/snapshot.png",
    "snapshots//double.png",
  ])("rejects unsafe storage URI %s before event append", async (uri) => {
    await expect(
      service(uri).handle(knowledge()),
    ).rejects.toMatchObject<ProjectSnapshotCaptureError>({ code: "INVALID_URI" });
    expect(writes).toHaveLength(0);
  });

  it("rejects malformed permanent input before invoking adapters", async () => {
    await expect(
      service().handle({ ...knowledge(), seq: null } as never),
    ).rejects.toThrow();
    expect(renders).toHaveLength(0);
  });
});
