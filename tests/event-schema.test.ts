import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  createEventDraft,
  eventPayloadSchemas,
  parseEventDraft,
  parseEventId,
  parseEventInput,
  parseEventPayload,
  parseStoredEvent,
  storedEventSchema,
} from "../packages/event-core/src/index.js";
import type { EventType } from "../packages/event-core/src/index.js";

const EVENT_ID = "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CAUSE_ID = "evt_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const SOURCE_ID = "evt_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const AT = "2026-08-23T21:00:00+08:00";
const OBSERVED_AT = "2026-08-23T20:59:00+08:00";

const INTEGRATION = {
  participates: true,
  streaming: true,
  reasoning: false,
  session: true,
  usage: true,
};

const VALID_PAYLOADS: Record<EventType, unknown> = {
  "agent.registered": {
    id: "codex-developer",
    name: "Codex",
    provider: "provider-name",
    role: "developer",
    concurrency: 2,
    host: "wk-macbook",
    capabilities: ["coding", "testing"],
    integration: INTEGRATION,
  },
  "agent.status.changed": {
    host: "wk-macbook",
    from: "idle",
    to: "working",
  },
  "agent.disconnected": {
    id: "codex-developer",
    host: "wk-macbook",
    graceful: true,
  },
  "task.created": {
    title: "Implement event schemas",
    goal: "GOAL-003",
    requires: ["coding", "testing"],
    priority: "high",
    dependsOn: ["TASK-001"],
    requiresApproval: false,
  },
  "task.assigned": { executor: "codex-developer", matchedBy: "capability" },
  "task.started": { executor: "codex-developer" },
  "task.progress.updated": { progress: 65.5 },
  "task.blocked": {
    reason: "Need a decision",
    severity: "high",
    needs: "human",
  },
  "task.unblocked": { resolution: "Decision recorded" },
  "task.review.requested": { summary: "Schemas implemented", outputs: [] },
  "task.completed": { acceptedBy: "human-owner" },
  "task.failed": { reason: "Unrecoverable", attempts: 2 },
  "task.cancelled": { by: "human-owner", reason: "No longer needed" },
  "message.sent": {
    from: "human-owner",
    to: "codex-developer",
    type: "instruction",
    content: "Implement the schema contract",
  },
  "approval.requested": {
    action: "Publish the schema",
    risk: "medium",
    reversible: true,
    requestedBy: "codex-developer",
    detail: "Publishes only the versioned schema package",
  },
  "approval.granted": { by: "human-owner" },
  "approval.rejected": { by: "human-owner", reason: "Needs revision" },
  "approval.expired": { after: OBSERVED_AT },
  "knowledge.created": {
    type: "decision",
    title: "Version event contracts",
    summary: "Permanent events use explicit schema versions",
    sourceEvents: [SOURCE_ID],
    rationale: "Strict replay cannot guess how an old payload should parse",
  },
  "knowledge.linked": {
    from: "KN-001",
    to: "measurement-retention-d30",
    relation: "validated-by",
  },
  "knowledge.superseded": { old: "KN-001", new: "KN-002" },
  "project.created": { name: "Agent OS", stack: ["TypeScript", "SQLite"] },
  "project.state.changed": { from: "paused", to: "active" },
  "project.snapshot.captured": {
    label: "Event Core baseline",
    image: "artifacts/snapshot.png",
    at: OBSERVED_AT,
  },
  "project.revived": {
    dormantDays: 31,
    plan: [
      {
        title: "Verify the environment",
        estimateMinutes: 30,
        detail: "Run the complete quality gate",
      },
    ],
  },
  "artifact.produced": {
    path: "artifacts/event-contract.md",
    kind: "document",
    task: "TASK-002",
  },
  "artifact.derived": {
    path: "artifacts/developer-digest.md",
    from: ["artifacts/corpus-a.md"],
    lens: "developer",
  },
  "measurement.recorded": {
    metric: "retention.d30",
    value: 42.5,
    unit: "percent",
    source: "analytics-export-2026-08-23",
    at: OBSERVED_AT,
  },
  "pulse.story.generated": {
    headline: "Event Core contract frozen",
    body: "All permanent event shapes now parse strictly.",
    sourceEvents: [SOURCE_ID],
  },
};

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function withoutField(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== field));
}

function subjectFor(type: EventType, payload: unknown = VALID_PAYLOADS[type]) {
  const [domain] = type.split(".");
  if (domain === "task") return { kind: "task", id: "TASK-002" };
  if (domain === "agent") return { kind: "agent", id: "codex-developer" };
  if (domain === "project") return { kind: "project", id: "proj_test" };
  if (domain === "message") {
    const task = (payload as { task?: string }).task;
    return task ? { kind: "task", id: task } : { kind: "project", id: "proj_test" };
  }
  return { kind: domain, id: `${domain}-001` };
}

function inputFor(type: EventType) {
  const payload = clone(VALID_PAYLOADS[type]);
  return {
    type,
    project: "proj_test",
    actor: { kind: "system", id: "runtime" },
    subject: subjectFor(type, payload),
    causedBy: CAUSE_ID,
    payload,
  };
}

function draftFor(type: EventType) {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: EVENT_ID,
    seq: null,
    at: AT,
    ...inputFor(type),
  };
}

describe("RM-1.1a · versioned strict event contract", () => {
  it("exports exactly the 29 canonical event types in catalog order", () => {
    const catalog = readFileSync("docs/protocol/event-catalog.md", "utf8");
    const catalogTypes = [...catalog.matchAll(/^\| `([a-z]+(?:\.[a-z]+)+)`/gmu)].map(
      (match) => match[1],
    );

    expect(EVENT_TYPES).toHaveLength(29);
    expect([...EVENT_TYPES]).toEqual(catalogTypes);
    expect(Object.isFrozen(EVENT_TYPES)).toBe(true);
    expect(Object.isFrozen(eventPayloadSchemas)).toBe(true);
  });

  it.each(EVENT_TYPES)("parses the minimal %s input, draft and stored event", (type) => {
    expect(parseEventPayload(type, clone(VALID_PAYLOADS[type]))).toEqual(
      VALID_PAYLOADS[type],
    );
    expect(parseEventInput(inputFor(type)).type).toBe(type);
    expect(parseEventDraft(draftFor(type)).seq).toBeNull();
    expect(parseStoredEvent({ ...draftFor(type), seq: 1 }).seq).toBe(1);
  });

  it.each(EVENT_TYPES)("binds %s to its canonical subject kind", (type) => {
    const input = inputFor(type);
    const expectedKind = input.subject.kind;
    const wrongKind = expectedKind === "agent" ? "project" : "agent";
    const candidate = { ...input, subject: { ...input.subject, kind: wrongKind } };

    expect(() => parseEventInput(candidate)).toThrow();
    expect(() =>
      parseEventDraft({
        schemaVersion: 1,
        id: EVENT_ID,
        seq: null,
        at: AT,
        ...candidate,
      }),
    ).toThrow();
    expect(() =>
      parseStoredEvent({
        schemaVersion: 1,
        id: EVENT_ID,
        seq: 1,
        at: AT,
        ...candidate,
      }),
    ).toThrow();
  });

  it("binds message subject to payload.task or envelope.project", () => {
    const projectMessage = inputFor("message.sent");
    expect(parseEventInput(projectMessage).subject).toEqual({
      kind: "project",
      id: "proj_test",
    });
    expect(() =>
      parseEventInput({
        ...projectMessage,
        subject: { kind: "project", id: "another-project" },
      }),
    ).toThrow();

    const taskMessage = {
      ...projectMessage,
      subject: { kind: "task", id: "TASK-009" },
      payload: { ...(projectMessage.payload as object), task: "TASK-009" },
    };
    expect(parseEventInput(taskMessage).subject).toEqual({
      kind: "task",
      id: "TASK-009",
    });
    expect(() =>
      parseEventInput({ ...taskMessage, subject: { kind: "task", id: "TASK-010" } }),
    ).toThrow();
    expect(() =>
      parseEventInput({ ...taskMessage, subject: { kind: "project", id: "proj_test" } }),
    ).toThrow();
  });

  it("binds canonical task, project and duplicated agent subject ids", () => {
    const task = inputFor("task.started");
    expect(() =>
      parseEventInput({ ...task, subject: { kind: "task", id: "task-2" } }),
    ).toThrow();

    const project = inputFor("project.state.changed");
    expect(() =>
      parseEventInput({
        ...project,
        subject: { kind: "project", id: "another-project" },
      }),
    ).toThrow();

    for (const type of ["agent.registered", "agent.disconnected"] as const) {
      const agent = inputFor(type);
      expect(() =>
        parseEventInput({
          ...agent,
          subject: { kind: "agent", id: "different-agent" },
        }),
      ).toThrow();
    }
  });

  it("rejects task self-dependency before draft construction", () => {
    const task = inputFor("task.created");
    expect(() =>
      parseEventInput({
        ...task,
        payload: { ...(task.payload as object), dependsOn: ["TASK-002"] },
      }),
    ).toThrow();
  });

  it.each(EVENT_TYPES)("rejects every missing required %s payload field", (type) => {
    const payload = VALID_PAYLOADS[type] as Record<string, unknown>;
    for (const field of Object.keys(payload)) {
      const candidate = clone(payload);
      delete candidate[field];
      expect(
        () => parseEventPayload(type, candidate),
        `${type}.${field} unexpectedly became optional`,
      ).toThrow();
    }
  });

  it.each(EVENT_TYPES)("rejects an extra field in %s payload", (type) => {
    expect(() =>
      parseEventPayload(type, { ...(VALID_PAYLOADS[type] as object), invented: true }),
    ).toThrow();
  });

  it("rejects unknown types before they can enter a permanent log", () => {
    expect(() =>
      parseEventDraft({
        ...draftFor("task.started"),
        type: "task.future.invented",
      }),
    ).toThrow();
  });

  it("rejects unknown schema versions rather than silently replaying them", () => {
    expect(() =>
      parseStoredEvent({ ...draftFor("task.started"), schemaVersion: 2, seq: 1 }),
    ).toThrow();
  });

  it("dispatches persisted parsers by schema version before event type", () => {
    const invalidVersion = storedEventSchema.safeParse({
      ...draftFor("task.started"),
      schemaVersion: 2,
      type: "task.future.invented",
      seq: 1,
    });
    expect(invalidVersion.success).toBe(false);
    if (!invalidVersion.success) {
      expect(invalidVersion.error.issues[0]?.path).toEqual(["schemaVersion"]);
    }

    const invalidType = storedEventSchema.safeParse({
      ...draftFor("task.started"),
      type: "task.future.invented",
      seq: 1,
    });
    expect(invalidType.success).toBe(false);
    if (!invalidType.success) {
      expect(invalidType.error.issues[0]?.path).toEqual(["type"]);
    }
  });

  it("keeps draft and stored sequence domains disjoint", () => {
    const draft = draftFor("task.started");
    expect(() => parseEventDraft({ ...draft, seq: 1 })).toThrow();
    for (const seq of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseStoredEvent({ ...draft, seq })).toThrow();
    }
  });

  it("rejects extra fields at every envelope nesting level", () => {
    const draft = draftFor("agent.registered");
    expect(() => parseEventDraft({ ...draft, extra: true })).toThrow();
    expect(() =>
      parseEventDraft({ ...draft, actor: { ...draft.actor, extra: true } }),
    ).toThrow();
    expect(() =>
      parseEventDraft({ ...draft, subject: { ...draft.subject, extra: true } }),
    ).toThrow();
    expect(() =>
      parseEventDraft({
        ...draft,
        payload: {
          ...(draft.payload as Record<string, unknown>),
          integration: { ...INTEGRATION, extra: true },
        },
      }),
    ).toThrow();
    const revived = draftFor("project.revived");
    const revivedPayload = revived.payload as {
      dormantDays: number;
      plan: readonly Record<string, unknown>[];
    };
    expect(() =>
      parseEventDraft({
        ...revived,
        payload: {
          ...revivedPayload,
          plan: [{ ...revivedPayload.plan[0], invented: true }],
        },
      }),
    ).toThrow();
  });

  it("does not treat null as an omitted optional field", () => {
    const message = draftFor("message.sent");
    expect(() =>
      parseEventDraft({
        ...message,
        payload: { ...(message.payload as object), task: null },
      }),
    ).toThrow();
  });

  it("accepts omission and rejects null for every optional payload field", () => {
    const optionalFields: readonly {
      type: EventType;
      field: string;
      value: unknown;
      override?: Record<string, unknown>;
    }[] = [
      { type: "agent.registered", field: "parentAgent", value: "supervisor" },
      { type: "agent.status.changed", field: "reason", value: "Work assigned" },
      { type: "task.created", field: "description", value: "Full detail" },
      { type: "task.progress.updated", field: "note", value: "Halfway" },
      { type: "message.sent", field: "task", value: "TASK-002" },
      { type: "message.sent", field: "replyTo", value: SOURCE_ID },
      { type: "message.sent", field: "attachments", value: ["artifact://one"] },
      { type: "approval.requested", field: "task", value: "TASK-002" },
      { type: "approval.granted", field: "note", value: "Approved" },
      {
        type: "knowledge.created",
        field: "rationale",
        value: "Evidence",
        override: { type: "research" },
      },
      {
        type: "knowledge.created",
        field: "alternatives",
        value: ["Alternative A"],
      },
      {
        type: "knowledge.created",
        field: "relatedTasks",
        value: ["TASK-002"],
      },
    ];

    for (const { type, field, value, override } of optionalFields) {
      const base = {
        ...(clone(VALID_PAYLOADS[type]) as Record<string, unknown>),
        ...override,
      };
      delete base[field];
      expect(
        parseEventPayload(type, base),
        `${type}.${field} should accept omission`,
      ).toBeDefined();
      expect(
        () => parseEventPayload(type, { ...base, [field]: null }),
        `${type}.${field} should reject null`,
      ).toThrow();
      expect(
        () => parseEventPayload(type, { ...base, [field]: undefined }),
        `${type}.${field} should reject explicit undefined`,
      ).toThrow();
      expect(
        parseEventPayload(type, { ...base, [field]: value }),
        `${type}.${field} should accept a legal value`,
      ).toBeDefined();
    }
  });

  it("rejects missing, extra and null optional fields on all envelope stages", () => {
    const stages = [
      {
        name: "input",
        value: inputFor("task.started"),
        required: ["type", "project", "actor", "subject", "payload"],
        parse: parseEventInput,
      },
      {
        name: "draft",
        value: draftFor("task.started"),
        required: [
          "schemaVersion",
          "id",
          "type",
          "seq",
          "project",
          "actor",
          "subject",
          "at",
          "payload",
        ],
        parse: parseEventDraft,
      },
      {
        name: "stored",
        value: { ...draftFor("task.started"), seq: 1 },
        required: [
          "schemaVersion",
          "id",
          "type",
          "seq",
          "project",
          "actor",
          "subject",
          "at",
          "payload",
        ],
        parse: parseStoredEvent,
      },
    ] as const;

    for (const stage of stages) {
      for (const field of stage.required) {
        const missing = clone(stage.value) as Record<string, unknown>;
        delete missing[field];
        expect(
          () => stage.parse(missing),
          `${stage.name}.${field} is required`,
        ).toThrow();
      }
      expect(() => stage.parse({ ...stage.value, extra: true })).toThrow();
      expect(() => stage.parse({ ...stage.value, causedBy: null })).toThrow();
      expect(() => stage.parse({ ...stage.value, causedBy: undefined })).toThrow();
      const withoutCause = withoutField(
        clone(stage.value) as Record<string, unknown>,
        "causedBy",
      );
      expect(stage.parse(withoutCause)).toBeDefined();
    }
  });

  it("enforces answer reply semantics without trusting replyTo as causedBy", () => {
    const answer = {
      ...VALID_PAYLOADS["message.sent"],
      type: "answer",
    };
    expect(() => parseEventPayload("message.sent", answer)).toThrow();
    expect(
      parseEventPayload("message.sent", { ...answer, replyTo: SOURCE_ID }),
    ).toMatchObject({ type: "answer", replyTo: SOURCE_ID });
  });

  it("rejects duplicates, non-finite measurements and whitespace-only text", () => {
    expect(() =>
      parseEventPayload("task.created", {
        ...VALID_PAYLOADS["task.created"],
        requires: ["coding", "coding"],
      }),
    ).toThrow();
    expect(() =>
      parseEventPayload("measurement.recorded", {
        ...VALID_PAYLOADS["measurement.recorded"],
        value: Number.POSITIVE_INFINITY,
      }),
    ).toThrow();
    expect(() =>
      parseEventPayload("task.blocked", {
        ...VALID_PAYLOADS["task.blocked"],
        reason: "   ",
      }),
    ).toThrow();
  });

  it("enforces every payload cross-field invariant", () => {
    const invalidPayloads: readonly [EventType, Record<string, unknown>][] = [
      [
        "agent.status.changed",
        { ...(VALID_PAYLOADS["agent.status.changed"] as object), to: "idle" },
      ],
      [
        "knowledge.created",
        (() => {
          return withoutField(
            clone(VALID_PAYLOADS["knowledge.created"]) as Record<string, unknown>,
            "rationale",
          );
        })(),
      ],
      [
        "knowledge.linked",
        { ...(VALID_PAYLOADS["knowledge.linked"] as object), to: "KN-001" },
      ],
      ["knowledge.superseded", { old: "KN-001", new: "KN-001" }],
      ["project.state.changed", { from: "active", to: "active" }],
      [
        "artifact.derived",
        {
          ...(VALID_PAYLOADS["artifact.derived"] as object),
          from: ["artifacts/developer-digest.md"],
        },
      ],
    ];

    for (const [type, payload] of invalidPayloads) {
      expect(() => parseEventPayload(type, payload), type).toThrow();
    }
  });

  it("accepts RFC3339 Z/offset values and rejects local or date-only values", () => {
    expect(
      parseEventDraft({ ...draftFor("task.started"), at: "2026-08-23T13:00:00Z" }),
    ).toBeDefined();
    for (const at of [
      "2026-08-23",
      "2026-08-23T13:00Z",
      "2026-08-23T13:00:00",
      "not-a-date",
      0,
    ]) {
      expect(() => parseEventDraft({ ...draftFor("task.started"), at })).toThrow();
    }
  });

  it.each([
    ["approval.expired", "after"],
    ["project.snapshot.captured", "at"],
    ["measurement.recorded", "at"],
  ] as const)("requires RFC3339 seconds in %s.%s", (type, field) => {
    expect(() =>
      parseEventPayload(type, {
        ...(VALID_PAYLOADS[type] as object),
        [field]: "2026-08-23T13:00Z",
      }),
    ).toThrow();
  });

  it("rejects impossible same-event references and future observed times", () => {
    expect(() =>
      parseEventDraft({ ...draftFor("task.started"), causedBy: EVENT_ID }),
    ).toThrow();
    const measurement = draftFor("measurement.recorded");
    expect(() =>
      parseEventDraft({
        ...measurement,
        payload: { ...(measurement.payload as object), at: "2026-08-23T22:00:00+08:00" },
      }),
    ).toThrow();
  });

  it("rejects every impossible same-event reference", () => {
    const task = draftFor("task.created");
    expect(() =>
      parseEventDraft({
        ...task,
        payload: { ...(task.payload as object), dependsOn: ["TASK-002"] },
      }),
    ).toThrow();

    for (const type of ["knowledge.created", "pulse.story.generated"] as const) {
      const event = draftFor(type);
      expect(() =>
        parseEventDraft({
          ...event,
          payload: { ...(event.payload as object), sourceEvents: [EVENT_ID] },
        }),
      ).toThrow();
    }

    const message = draftFor("message.sent");
    expect(() =>
      parseEventDraft({
        ...message,
        payload: { ...(message.payload as object), replyTo: EVENT_ID },
      }),
    ).toThrow();
    expect(
      parseEventDraft({
        ...message,
        payload: { ...(message.payload as object), replyTo: SOURCE_ID },
      }).payload,
    ).toMatchObject({ replyTo: SOURCE_ID });
  });

  it.each([
    ["approval.expired", "after"],
    ["project.snapshot.captured", "at"],
    ["measurement.recorded", "at"],
  ] as const)("rejects a sub-millisecond future %s.%s instant", (type, field) => {
    const event = draftFor(type);
    expect(() =>
      parseEventDraft({
        ...event,
        at: "2026-08-23T13:00:00.0000Z",
        payload: {
          ...(event.payload as object),
          [field]: "2026-08-23T13:00:00.0001Z",
        },
      }),
    ).toThrow();
  });

  it.each([
    ["approval.expired", "after"],
    ["project.snapshot.captured", "at"],
    ["measurement.recorded", "at"],
  ] as const)(
    "accepts the same %s.%s instant across offset and precision",
    (type, field) => {
      const event = draftFor(type);
      expect(
        parseEventDraft({
          ...event,
          at: "2026-08-23T13:00:00.1000Z",
          payload: {
            ...(event.payload as object),
            [field]: "2026-08-23T21:00:00.1+08:00",
          },
        }),
      ).toBeDefined();
    },
  );

  it("deep-freezes parsed values without freezing caller input", () => {
    const callerInput = inputFor("agent.registered");
    const event = parseEventInput(callerInput);
    const payload = event.payload as {
      capabilities: readonly string[];
      integration: Readonly<Record<string, boolean>>;
    };

    expect(Object.isFrozen(callerInput)).toBe(false);
    expect(Object.isFrozen(callerInput.payload)).toBe(false);
    for (const value of [
      event,
      event.actor,
      event.subject,
      event.payload,
      payload.capabilities,
      payload.integration,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => (payload.capabilities as string[]).push("ops")).toThrow(TypeError);
    expect(() => {
      (payload.integration as Record<string, boolean>).usage = false;
    }).toThrow(TypeError);

    const revived = eventPayloadSchemas["project.revived"].parse(
      clone(VALID_PAYLOADS["project.revived"]),
    ) as { readonly plan: readonly Readonly<Record<string, unknown>>[] };
    expect(Object.isFrozen(revived)).toBe(true);
    expect(Object.isFrozen(revived.plan)).toBe(true);
    expect(Object.isFrozen(revived.plan[0])).toBe(true);
    expect(() => {
      (revived.plan[0] as Record<string, unknown>).title = "Mutated";
    }).toThrow(TypeError);
  });

  it("constructs a deterministic validated draft from admitted input", () => {
    const input = parseEventInput(inputFor("task.started"));
    const draft = createEventDraft(input, {
      idFactory: () => parseEventId(EVENT_ID),
      now: () => new Date("2026-08-23T13:00:00Z"),
    });

    expect(draft).toEqual({
      schemaVersion: 1,
      id: EVENT_ID,
      seq: null,
      at: "2026-08-23T13:00:00.000Z",
      ...input,
    });
  });
});
