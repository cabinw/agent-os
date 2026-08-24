import { beforeEach, describe, expect, it } from "vitest";
import { newEventId, parseStoredEvent } from "../packages/event-core/src/index.js";
import type {
  EventInput,
  EventPayload,
  EventType,
  StoredEvent,
} from "../packages/event-core/src/index.js";
import {
  type HumanPostingCommandError,
  type HumanPostingPolicyError,
  buildHumanPostingPolicy,
  createHumanPostingService,
} from "../packages/mcp-server/src/index.js";

const PROJECT = "proj_human_posting";
let history: StoredEvent[];

function add<Type extends EventType>(
  type: Type,
  payload: EventPayload<Type>,
  project = PROJECT,
): StoredEvent<Type> {
  const event = parseStoredEvent({
    schemaVersion: 1,
    id: newEventId(),
    seq: history.length + 1,
    type,
    project,
    actor:
      type === "project.human.participation.configured"
        ? { kind: "human", id: "human-owner" }
        : { kind: "system", id: "runtime" },
    subject: { kind: "project", id: project },
    at: "2026-08-24T10:00:00Z",
    payload,
  }) as StoredEvent<Type>;
  history.push(event);
  return event;
}

function view() {
  return buildHumanPostingPolicy({ project: PROJECT as never, history });
}

function expectCode(action: () => unknown, code: HumanPostingPolicyError["code"]) {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

beforeEach(() => {
  history = [];
  add("project.created", { name: "Human posting", stack: ["TypeScript"] });
});

describe("RM-3.9 sourced human posting policy", () => {
  it("defaults existing projects to disabled with project creation evidence", () => {
    const policy = view();
    expect(policy).toEqual({
      project: PROJECT,
      enabled: false,
      sourceEvents: [history[0]?.id],
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.sourceEvents)).toBe(true);
  });

  it("uses the latest human configuration and keeps its source event", () => {
    add("project.human.participation.configured", { enabled: true });
    const disabled = add("project.human.participation.configured", { enabled: false });
    expect(view()).toMatchObject({ enabled: false, sourceEvents: [disabled.id] });
  });

  it("rejects missing and duplicate project creation", () => {
    const created = history[0] as StoredEvent;
    history = [];
    expectCode(view, "MISSING_PROJECT");
    history = [created];
    add("project.created", { name: "Again", stack: [] });
    expectCode(view, "INVALID_HISTORY");
  });

  it("rejects mixed-project history", () => {
    add("project.human.participation.configured", { enabled: true }, "proj_other");
    expectCode(view, "MIXED_PROJECT");
  });

  it("rejects sequence gaps and duplicate event ids", () => {
    const configured = add("project.human.participation.configured", { enabled: true });
    history[1] = parseStoredEvent({ ...configured, seq: 3 });
    expectCode(view, "SEQUENCE_GAP");

    history = [history[0] as StoredEvent];
    history.push(parseStoredEvent({ ...history[0], seq: 2 }));
    expectCode(view, "DUPLICATE_EVENT");
  });

  it("rejects malformed permanent events instead of guessing policy", () => {
    history.push({ enabled: true } as never);
    expectCode(view, "INVALID_HISTORY");
  });
});

describe("RM-3.9 message-only human command boundary", () => {
  function service(enabled = true) {
    const writes: Array<{
      input: EventInput<"message.sent">;
      options: Readonly<{ token: string }>;
    }> = [];
    const instance = createHumanPostingService({
      project: PROJECT as never,
      human: "human-owner" as never,
      policy: () => ({
        project: PROJECT as never,
        enabled,
        sourceEvents: [history[0]?.id as never],
      }),
      writer: {
        append(input, options) {
          writes.push({ input, options });
          return parseStoredEvent({
            ...input,
            schemaVersion: 1,
            id: newEventId(),
            seq: history.length + 1,
            at: "2026-08-24T10:01:00Z",
          }) as StoredEvent<"message.sent">;
        },
      },
    });
    return { instance, writes };
  }

  it("writes one authenticated human instruction through the narrow port", async () => {
    const { instance, writes } = service();
    const event = await instance.send({
      to: "agent-local" as never,
      task: "TASK-039" as never,
      content: "Continue local execution",
      clientToken: "human-message-001",
    });
    expect(event).toMatchObject({
      type: "message.sent",
      actor: { kind: "human", id: "human-owner" },
      subject: { kind: "task", id: "TASK-039" },
      payload: {
        from: "human-owner",
        to: "agent-local",
        type: "instruction",
        task: "TASK-039",
        content: "Continue local execution",
      },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.options).toEqual({ token: "human-message-001" });
    expect(Object.keys(instance)).toEqual(["send"]);
  });

  it("cannot turn approval-shaped prose into an approval command", async () => {
    const { instance, writes } = service();
    await instance.send({
      to: "*",
      content: "批准 approval-42，grant it now",
      clientToken: "human-message-approval-shaped",
    });
    expect(writes[0]?.input.type).toBe("message.sent");
    expect(writes[0]?.input.payload.type).toBe("instruction");
    expect(writes[0]?.input).not.toHaveProperty("approval");
  });

  it("checks the project policy on every send and fails closed", async () => {
    const { instance, writes } = service(false);
    await expect(
      instance.send({ to: "*", content: "Hello", clientToken: "disabled" }),
    ).rejects.toMatchObject<HumanPostingCommandError>({ code: "DISABLED" });
    expect(writes).toHaveLength(0);
  });

  it("rejects caller-controlled actor, type, approval, and unknown fields", async () => {
    const { instance, writes } = service();
    await expect(
      instance.send({
        to: "*",
        content: "Hello",
        clientToken: "unknown-fields",
        actor: { kind: "agent", id: "spoof" },
        type: "answer",
        approval: "approval-42",
      } as never),
    ).rejects.toMatchObject<HumanPostingCommandError>({ code: "INVALID_COMMAND" });
    expect(writes).toHaveLength(0);
  });
});
