import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  KNOWLEDGE_TYPES,
  newEventId,
  parseStoredEvent,
} from "../packages/event-core/src/index.js";
import type {
  EventPayload,
  EventType,
  StoredEvent,
} from "../packages/event-core/src/index.js";
import {
  KNOWLEDGE_TRIGGER_KINDS,
  classifyKnowledgeEvent,
  knowledgeDraftSchema,
  parseKnowledgeDraft,
} from "../packages/memory-core/src/index.js";

const PROJECT = "proj_memory";
const AT = "2026-08-24T12:00:00Z";
const SOURCE = "evt_01ARZ3NDEKTSV4RRFFQ69G5FAX";

const PAYLOADS: Record<EventType, unknown> = {
  "agent.registered": {
    id: "agent-memory",
    name: "Memory Agent",
    provider: "provider",
    role: "researcher",
    concurrency: 1,
    host: "host-memory",
    capabilities: ["research"],
    integration: {
      participates: true,
      streaming: false,
      reasoning: true,
      session: true,
      usage: true,
    },
  },
  "agent.status.changed": {
    host: "host-memory",
    from: "idle",
    to: "working",
  },
  "agent.disconnected": {
    id: "agent-memory",
    host: "host-memory",
    graceful: true,
  },
  "task.created": {
    title: "Research memory",
    goal: "goal-memory",
    requires: ["research"],
    priority: "high",
    dependsOn: [],
    requiresApproval: false,
  },
  "task.assigned": { executor: "agent-memory", matchedBy: "capability" },
  "task.started": { executor: "agent-memory" },
  "task.progress.updated": { progress: 50, note: "halfway" },
  "task.blocked": { reason: "Need data", severity: "high", needs: "resource" },
  "task.unblocked": { resolution: "Dataset restored" },
  "task.review.requested": {
    summary: "Research complete",
    outputs: ["artifacts/research.md"],
  },
  "task.completed": { acceptedBy: "human-owner" },
  "task.failed": { reason: "Dataset corrupt", attempts: 2 },
  "task.cancelled": { by: "human-owner", reason: "Goal changed" },
  "message.sent": {
    from: "agent-memory",
    to: "human-owner",
    type: "report",
    content: "The evidence supports option A.",
  },
  "approval.requested": {
    action: "Adopt option A",
    risk: "medium",
    reversible: true,
    requestedBy: "agent-memory",
    detail: "Changes the storage layout.",
  },
  "approval.granted": { by: "human-owner" },
  "approval.rejected": { by: "human-owner", reason: "Need more evidence" },
  "approval.expired": { after: AT },
  "knowledge.created": {
    type: "research",
    title: "Storage evidence",
    summary: "Option A has lower write amplification.",
    sourceEvents: [SOURCE],
  },
  "knowledge.linked": { from: "KN-001", to: "TASK-001", relation: "informs" },
  "knowledge.superseded": { old: "KN-001", new: "KN-002" },
  "project.created": { name: "Memory Project", stack: ["TypeScript"] },
  "project.state.changed": { from: "paused", to: "active" },
  "project.snapshot.captured": {
    label: "Memory baseline",
    image: "artifacts/memory.png",
    at: AT,
  },
  "project.revived": {
    dormantDays: 31,
    plan: [{ title: "Inspect memory", estimateMinutes: 20, detail: "Replay events" }],
  },
  "artifact.produced": {
    path: "artifacts/research.md",
    kind: "document",
    task: "TASK-001",
  },
  "artifact.derived": {
    path: "artifacts/research-digest.md",
    from: ["artifacts/research.md"],
    lens: "researcher",
  },
  "measurement.recorded": {
    metric: "write-amplification",
    value: 1.5,
    unit: "ratio",
    source: "benchmark",
    at: AT,
  },
  "pulse.story.generated": {
    headline: "Research completed",
    body: "The storage research reached review.",
    sourceEvents: [SOURCE],
  },
};

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function subjectFor(type: EventType, payload: unknown) {
  const domain = type.split(".")[0];
  if (domain === "task") return { kind: "task", id: "TASK-001" };
  if (domain === "agent") return { kind: "agent", id: "agent-memory" };
  if (domain === "project") return { kind: "project", id: PROJECT };
  if (domain === "message") {
    const task = (payload as { task?: string }).task;
    return task === undefined
      ? { kind: "project", id: PROJECT }
      : { kind: "task", id: task };
  }
  const ids: Record<string, string> = {
    approval: "approval-memory",
    knowledge: "KN-001",
    artifact: "artifact-memory",
    measurement: "measurement-memory",
    pulse: "pulse-memory",
  };
  return { kind: domain, id: ids[domain ?? ""] };
}

function eventFor<Type extends EventType>(
  type: Type,
  payload: EventPayload<Type> = clone(PAYLOADS[type]) as EventPayload<Type>,
): StoredEvent<Type> {
  return parseStoredEvent({
    schemaVersion: 1,
    id: newEventId(),
    seq: 1,
    type,
    project: PROJECT,
    actor: { kind: "system", id: "memory-runtime" },
    subject: subjectFor(type, payload),
    at: AT,
    payload,
  }) as StoredEvent<Type>;
}

function message(type: EventPayload<"message.sent">["type"], content: string) {
  const payload: EventPayload<"message.sent"> = {
    from: "agent-memory" as never,
    to: "human-owner" as never,
    type,
    content,
    ...(type === "answer" ? { replyTo: SOURCE as never } : {}),
  };
  return eventFor("message.sent", payload);
}

describe("RM-2.1 · strict knowledge item draft", () => {
  it("accepts exactly the six canonical types through the Event Core schema", () => {
    expect(KNOWLEDGE_TYPES).toEqual([
      "decision",
      "research",
      "technical-note",
      "task-summary",
      "milestone",
      "discussion",
    ]);
    for (const type of KNOWLEDGE_TYPES) {
      const parsed = parseKnowledgeDraft({
        type,
        title: `Knowledge ${type}`,
        summary: `Strict ${type} conclusion`,
        sourceEvents: [SOURCE],
        ...(type === "decision" ? { rationale: "The evidence selects A." } : {}),
      });
      expect(parsed.type).toBe(type);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.sourceEvents)).toBe(true);
    }
    expect(knowledgeDraftSchema).toBeDefined();
  });

  it.each([
    ["unknown type", { type: "fact" }],
    ["empty source set", { sourceEvents: [] }],
    ["duplicate sources", { sourceEvents: [SOURCE, SOURCE] }],
    ["invalid source id", { sourceEvents: ["evt_bad"] }],
    ["missing decision rationale", { type: "decision" }],
    ["blank title", { title: "  " }],
    ["duplicate alternatives", { alternatives: ["A", "A"] }],
    ["duplicate related tasks", { relatedTasks: ["TASK-001", "TASK-001"] }],
    ["unknown authority field", { author: "caller" }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      parseKnowledgeDraft({
        type: "research",
        title: "Storage evidence",
        summary: "Option A is supported.",
        sourceEvents: [SOURCE],
        ...override,
      }),
    ).toThrow();
  });
});

describe("RM-2.1 · structural extraction triggers", () => {
  const candidateEventTypes = new Set<EventType>([
    "task.unblocked",
    "task.review.requested",
    "task.completed",
    "task.failed",
    "task.cancelled",
    "message.sent",
    "approval.granted",
    "approval.rejected",
    "artifact.produced",
    "artifact.derived",
    "measurement.recorded",
  ]);

  it("classifies every canonical event type without an unowned gap", () => {
    expect(EVENT_TYPES).toHaveLength(29);
    for (const type of EVENT_TYPES) {
      const classified = classifyKnowledgeEvent(eventFor(type));
      expect(classified.kind, type).toBe(
        candidateEventTypes.has(type) ? "candidate" : "noise",
      );
      expect(Object.isFrozen(classified)).toBe(true);
      expect(Object.isFrozen(classified.event)).toBe(true);
    }
  });

  it.each([
    ["approval.granted", "decision-recorded", ["decision", "discussion"]],
    [
      "task.completed",
      "result-recorded",
      ["task-summary", "milestone", "technical-note"],
    ],
    ["task.unblocked", "blocker-resolved", ["technical-note", "task-summary"]],
    ["artifact.produced", "research-produced", ["research", "technical-note"]],
    [
      "measurement.recorded",
      "result-recorded",
      ["task-summary", "milestone", "technical-note"],
    ],
  ] as const)(
    "maps %s to its frozen trigger contract",
    (type, trigger, possibleTypes) => {
      const classified = classifyKnowledgeEvent(eventFor(type));
      expect(classified).toMatchObject({ kind: "candidate", trigger, possibleTypes });
      if (classified.kind === "candidate") {
        expect(Object.isFrozen(classified.possibleTypes)).toBe(true);
      }
    },
  );

  it("treats answer/report/review as conclusions and other messages as context", () => {
    for (const type of ["answer", "report", "review"] as const) {
      expect(classifyKnowledgeEvent(message(type, "ordinary text"))).toMatchObject({
        kind: "candidate",
        trigger: "discussion-concluded",
      });
    }
    for (const type of ["instruction", "question", "progress", "warning"] as const) {
      expect(
        classifyKnowledgeEvent(message(type, "Decision approved; research complete.")),
      ).toMatchObject({ kind: "noise", reason: "unresolved-context" });
    }
  });

  it("uses structure rather than free-form keywords", () => {
    expect(
      classifyKnowledgeEvent(message("report", "progress chatter only")),
    ).toMatchObject({ kind: "candidate" });
    expect(
      classifyKnowledgeEvent(message("progress", "final decision and research result")),
    ).toMatchObject({ kind: "noise" });
    expect(
      classifyKnowledgeEvent(
        eventFor("artifact.produced", {
          path: "artifacts/progress.txt",
          kind: "temporary chatter",
          task: "TASK-001" as never,
        }),
      ),
    ).toMatchObject({ kind: "candidate", trigger: "research-produced" });
  });

  it.each([
    ["task.progress.updated", "transient-operation"],
    ["task.blocked", "unresolved-context"],
    ["project.snapshot.captured", "administrative"],
    ["knowledge.created", "derived-output"],
    ["knowledge.linked", "derived-output"],
    ["knowledge.superseded", "derived-output"],
    ["project.revived", "derived-output"],
    ["pulse.story.generated", "derived-output"],
  ] as const)("filters %s as %s", (type, reason) => {
    expect(classifyKnowledgeEvent(eventFor(type))).toMatchObject({
      kind: "noise",
      reason,
    });
  });

  it("rejects malformed or non-durable input before classification", () => {
    const valid = eventFor("task.completed");
    expect(() => classifyKnowledgeEvent({ ...valid, seq: null })).toThrow();
    expect(() => classifyKnowledgeEvent({ ...valid, schemaVersion: 2 })).toThrow();
    expect(() => classifyKnowledgeEvent({ ...valid, injected: true })).toThrow();
  });

  it("publishes the five controlled trigger names", () => {
    expect(KNOWLEDGE_TRIGGER_KINDS).toEqual([
      "decision-recorded",
      "result-recorded",
      "blocker-resolved",
      "discussion-concluded",
      "research-produced",
    ]);
    expect(Object.isFrozen(KNOWLEDGE_TRIGGER_KINDS)).toBe(true);
  });
});
