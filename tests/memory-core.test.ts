import { describe, expect, it, vi } from "vitest";
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
  KnowledgeExtractionError,
  KnowledgeWindowError,
  buildKnowledgeWindow,
  classifyKnowledgeEvent,
  createKnowledgeExtractor,
  knowledgeDraftSchema,
  parseKnowledgeDraft,
} from "../packages/memory-core/src/index.js";
import type {
  KnowledgeAdmissionCommand,
  KnowledgeExtractionRequest,
  KnowledgeSummarizerInput,
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

function historyEvent<Type extends EventType>(
  seq: number,
  type: Type,
  payload: EventPayload<Type>,
  options: {
    id?: string;
    project?: string;
    causedBy?: string;
  } = {},
): StoredEvent<Type> {
  return parseStoredEvent({
    schemaVersion: 1,
    id: options.id ?? newEventId(),
    seq,
    type,
    project: options.project ?? PROJECT,
    actor: { kind: "system", id: "memory-runtime" },
    subject: subjectFor(type, payload),
    at: AT,
    ...(options.causedBy === undefined ? {} : { causedBy: options.causedBy }),
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

describe("RM-2.2 · deterministic causal windows", () => {
  it("unites backward causes and full direct task scope without sequence neighbors", () => {
    const goal = historyEvent(1, "message.sent", {
      from: "human-owner" as never,
      to: "agent-memory" as never,
      type: "instruction",
      content: "Research the storage choice.",
    });
    const created = historyEvent(
      2,
      "task.created",
      clone(PAYLOADS["task.created"]) as EventPayload<"task.created">,
      { causedBy: goal.id },
    );
    const progress = historyEvent(
      3,
      "task.progress.updated",
      { progress: 50, note: "Benchmarks complete" },
      { causedBy: created.id },
    );
    const unrelated = historyEvent(4, "project.state.changed", {
      from: "paused",
      to: "active",
    });
    const review = historyEvent(
      5,
      "task.review.requested",
      { summary: "Option A wins", outputs: ["artifacts/research.md"] },
      { causedBy: progress.id },
    );
    const afterAnchor = historyEvent(6, "project.snapshot.captured", {
      label: "after extraction",
      image: "artifacts/after.png",
      at: AT,
    });

    const window = buildKnowledgeWindow(
      [goal, created, progress, unrelated, review, afterAnchor],
      review.id,
    );
    expect(window.events.map((event) => event.id)).toEqual([
      goal.id,
      created.id,
      progress.id,
      review.id,
    ]);
    expect(window.sourceEvents).toEqual(window.events.map((event) => event.id));
    expect(window.relatedTasks).toEqual(["TASK-001"]);
    expect(window.events.at(-1)?.id).toBe(review.id);
    expect(Object.isFrozen(window)).toBe(true);
    expect(Object.isFrozen(window.events)).toBe(true);
    expect(Object.isFrozen(window.sourceEvents)).toBe(true);
  });

  it("keeps reply semantics separate from runtime cause", () => {
    const question = historyEvent(1, "message.sent", {
      from: "human-owner" as never,
      to: "agent-memory" as never,
      type: "question",
      content: "Which store should we use?",
    });
    const runtimeCause = historyEvent(2, "agent.status.changed", {
      host: "host-memory",
      from: "idle",
      to: "working",
    });
    const answer = historyEvent(
      3,
      "message.sent",
      {
        from: "agent-memory" as never,
        to: "human-owner" as never,
        type: "answer",
        content: "Use option A.",
        replyTo: question.id,
      },
      { causedBy: runtimeCause.id },
    );
    const window = buildKnowledgeWindow([question, runtimeCause, answer], answer.id);
    expect(window.sourceEvents).toEqual([question.id, runtimeCause.id, answer.id]);
    expect(window.relatedTasks).toEqual([]);
  });

  it("matches approval decisions to their request and task history", () => {
    const created = historyEvent(
      1,
      "task.created",
      clone(PAYLOADS["task.created"]) as EventPayload<"task.created">,
    );
    const request = historyEvent(
      2,
      "approval.requested",
      {
        action: "Adopt option A",
        risk: "high",
        reversible: false,
        requestedBy: "agent-memory" as never,
        task: "TASK-001" as never,
        detail: "Changes durable storage.",
      },
      { causedBy: created.id },
    );
    const blocked = historyEvent(
      3,
      "task.blocked",
      { reason: "Awaiting approval", severity: "high", needs: "human" },
      { causedBy: request.id },
    );
    const granted = historyEvent(
      4,
      "approval.granted",
      { by: "human-owner" as never },
      { causedBy: request.id },
    );
    const window = buildKnowledgeWindow([created, request, blocked, granted], granted.id);
    expect(window.sourceEvents).toEqual([created.id, request.id, blocked.id, granted.id]);
    expect(window.relatedTasks).toEqual(["TASK-001"]);
    expect(window.trigger).toBe("decision-recorded");
  });

  it("follows transitive artifact lineage and derives its task", () => {
    const source = historyEvent(1, "artifact.produced", {
      path: "artifacts/raw.md",
      kind: "corpus",
      task: "TASK-001" as never,
    });
    const digest = historyEvent(2, "artifact.derived", {
      path: "artifacts/digest.md",
      from: ["artifacts/raw.md"],
      lens: "researcher",
    });
    const conclusion = historyEvent(3, "artifact.derived", {
      path: "artifacts/conclusion.md",
      from: ["artifacts/digest.md", "external/no-event.md"],
      lens: "architect",
    });
    const window = buildKnowledgeWindow([source, digest, conclusion], conclusion.id);
    expect(window.sourceEvents).toEqual([source.id, digest.id, conclusion.id]);
    expect(window.relatedTasks).toEqual(["TASK-001"]);
  });

  it("does not let a multi-task knowledge context expand into another task history", () => {
    const taskTwo = historyEvent(1, "task.created", {
      ...(clone(PAYLOADS["task.created"]) as EventPayload<"task.created">),
      title: "Unrelated task",
    });
    const taskOne = historyEvent(
      2,
      "task.created",
      clone(PAYLOADS["task.created"]) as EventPayload<"task.created">,
    );
    const priorKnowledge = historyEvent(
      3,
      "knowledge.created",
      {
        type: "technical-note",
        title: "Shared note",
        summary: "The note mentions both tasks.",
        sourceEvents: [taskOne.id],
        relatedTasks: ["TASK-001", "TASK-002"] as never,
      },
      { causedBy: taskOne.id },
    );
    const completed = historyEvent(
      4,
      "task.completed",
      { acceptedBy: "human-owner" as never },
      { causedBy: priorKnowledge.id },
    );
    const window = buildKnowledgeWindow(
      [
        { ...taskTwo, subject: { kind: "task", id: "TASK-002" } },
        taskOne,
        priorKnowledge,
        completed,
      ],
      completed.id,
    );
    expect(window.sourceEvents).toContain(priorKnowledge.id);
    expect(window.sourceEvents).not.toContain(taskTwo.id);
    expect(window.relatedTasks).toEqual(["TASK-001"]);
  });

  it.each([
    ["empty history", [], SOURCE, "INVALID_HISTORY"],
    ["bad anchor", [eventFor("task.completed")], "evt_bad", "INVALID_ANCHOR"],
    [
      "missing anchor",
      [eventFor("task.completed")],
      "evt_01ARZ3NDEKTSV4RRFFQ69G5FAY",
      "INVALID_ANCHOR",
    ],
    ["noise anchor", [eventFor("task.progress.updated")], null, "NOT_CANDIDATE"],
  ] as const)("rejects %s", (_label, history, anchor, code) => {
    const actualAnchor = anchor ?? (history[0] as StoredEvent).id;
    expect(() => buildKnowledgeWindow(history, actualAnchor)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("rejects gaps, mixed projects, duplicate ids and malformed durable events", () => {
    const one = historyEvent(1, "task.created", PAYLOADS["task.created"] as never);
    const three = historyEvent(3, "task.completed", PAYLOADS["task.completed"] as never);
    expect(() => buildKnowledgeWindow([one, three], three.id)).toThrowError(
      expect.objectContaining({ code: "SEQUENCE_GAP" }),
    );
    const other = historyEvent(2, "task.completed", PAYLOADS["task.completed"] as never, {
      project: "proj_other",
    });
    expect(() => buildKnowledgeWindow([one, other], other.id)).toThrowError(
      expect.objectContaining({ code: "MIXED_PROJECT" }),
    );
    const duplicate = historyEvent(
      2,
      "task.completed",
      PAYLOADS["task.completed"] as never,
      { id: one.id },
    );
    expect(() => buildKnowledgeWindow([one, duplicate], duplicate.id)).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_EVENT" }),
    );
    expect(() => buildKnowledgeWindow([{ ...one, injected: true }], one.id)).toThrowError(
      expect.objectContaining({ code: "INVALID_HISTORY" }),
    );
  });

  it("rejects missing/future causes and invalid reply targets or threads", () => {
    const futureId = newEventId();
    const first = historyEvent(1, "task.created", PAYLOADS["task.created"] as never, {
      causedBy: futureId,
    });
    const anchor = historyEvent(
      2,
      "task.completed",
      PAYLOADS["task.completed"] as never,
      { id: futureId },
    );
    expect(() => buildKnowledgeWindow([first, anchor], anchor.id)).toThrowError(
      expect.objectContaining({ code: "INVALID_REFERENCE" }),
    );

    const nonMessage = historyEvent(1, "task.created", PAYLOADS["task.created"] as never);
    const reply = historyEvent(2, "message.sent", {
      from: "agent-memory" as never,
      to: "human-owner" as never,
      type: "answer",
      content: "Answer",
      replyTo: nonMessage.id,
    });
    expect(() => buildKnowledgeWindow([nonMessage, reply], reply.id)).toThrowError(
      expect.objectContaining({ code: "INVALID_REFERENCE" }),
    );

    const taskQuestion = historyEvent(1, "message.sent", {
      from: "human-owner" as never,
      to: "agent-memory" as never,
      type: "question",
      task: "TASK-001" as never,
      content: "Question",
    });
    const projectAnswer = historyEvent(2, "message.sent", {
      from: "agent-memory" as never,
      to: "human-owner" as never,
      type: "answer",
      content: "Answer",
      replyTo: taskQuestion.id,
    });
    expect(() =>
      buildKnowledgeWindow([taskQuestion, projectAnswer], projectAnswer.id),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REFERENCE" }));
  });

  it("requires one approval request and at least one supporting event", () => {
    const decision = historyEvent(1, "approval.granted", {
      by: "human-owner" as never,
    });
    expect(() => buildKnowledgeWindow([decision], decision.id)).toThrowError(
      expect.objectContaining({ code: "INVALID_REFERENCE" }),
    );
    const lone = historyEvent(1, "measurement.recorded", {
      metric: "retention",
      value: 1,
      unit: "ratio",
      source: "analytics",
      at: AT,
    });
    expect(() => buildKnowledgeWindow([lone], lone.id)).toThrowError(
      expect.objectContaining({ code: "INSUFFICIENT_CONTEXT" }),
    );
  });

  it("exports typed window errors", () => {
    try {
      buildKnowledgeWindow([], SOURCE);
    } catch (cause) {
      expect(cause).toBeInstanceOf(KnowledgeWindowError);
      expect((cause as KnowledgeWindowError).code).toBe("INVALID_HISTORY");
    }
  });
});

describe("RM-2.2 · sourced summarization and admission", () => {
  function extractionHistory() {
    const created = historyEvent(
      1,
      "task.created",
      clone(PAYLOADS["task.created"]) as EventPayload<"task.created">,
    );
    const review = historyEvent(
      2,
      "task.review.requested",
      { summary: "Option A wins", outputs: ["artifacts/research.md"] },
      { causedBy: created.id },
    );
    return { created, review, history: [created, review] };
  }

  function extractorHarness(
    output: unknown = {
      type: "task-summary",
      title: "Storage research completed",
      summary: "Option A wins the benchmark.",
    },
  ) {
    const modelInputs: KnowledgeSummarizerInput[] = [];
    const admitted: KnowledgeAdmissionCommand[] = [];
    const summarizer = {
      summarize: vi.fn((input: KnowledgeSummarizerInput) => {
        modelInputs.push(input);
        return output;
      }),
    };
    const admission = {
      admit: vi.fn((command: KnowledgeAdmissionCommand) => {
        admitted.push(command);
      }),
    };
    return {
      extractor: createKnowledgeExtractor({ summarizer, admission }),
      summarizer,
      admission,
      modelInputs,
      admitted,
    };
  }

  it("keeps source authority out of the model and admits one canonical draft", async () => {
    const { created, review, history } = extractionHistory();
    const harness = extractorHarness();
    const command = await harness.extractor.extract({
      project: PROJECT as never,
      history,
      anchor: review.id,
      operationToken: "memory-extract-001",
    });
    expect(harness.summarizer.summarize).toHaveBeenCalledOnce();
    expect(harness.admission.admit).toHaveBeenCalledOnce();
    expect(harness.modelInputs[0]).not.toHaveProperty("sourceEvents");
    expect(harness.modelInputs[0]).not.toHaveProperty("relatedTasks");
    expect(harness.modelInputs[0]).not.toHaveProperty("operationToken");
    expect(harness.modelInputs[0]).not.toHaveProperty("actor");
    expect(Object.isFrozen(harness.modelInputs[0])).toBe(true);
    expect(Object.isFrozen(harness.modelInputs[0]?.outputSchema)).toBe(true);
    expect(command).toEqual({
      project: PROJECT,
      causedBy: review.id,
      operationToken: "memory-extract-001",
      draft: {
        type: "task-summary",
        title: "Storage research completed",
        summary: "Option A wins the benchmark.",
        sourceEvents: [created.id, review.id],
        relatedTasks: ["TASK-001"],
      },
    });
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.draft)).toBe(true);
    expect(harness.admitted).toEqual([command]);
  });

  it.each([
    ["unknown field", { injected: true }],
    ["caller sources", { sourceEvents: [SOURCE] }],
    ["caller tasks", { relatedTasks: ["TASK-999"] }],
    ["caller actor", { actor: "model" }],
    ["blank summary", { summary: " " }],
  ])("rejects model %s with zero admission", async (_label, injected) => {
    const { review, history } = extractionHistory();
    const harness = extractorHarness({
      type: "task-summary",
      title: "Storage research completed",
      summary: "Option A wins.",
      ...injected,
    });
    await expect(
      harness.extractor.extract({
        project: PROJECT as never,
        history,
        anchor: review.id,
        operationToken: "memory-invalid-model",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SUMMARY" });
    expect(harness.admission.admit).not.toHaveBeenCalled();
  });

  it("rejects a structurally valid but anchor-disallowed type", async () => {
    const { review, history } = extractionHistory();
    const harness = extractorHarness({
      type: "decision",
      title: "Adopt option A",
      summary: "Option A wins.",
      rationale: "It has lower amplification.",
    });
    await expect(
      harness.extractor.extract({
        project: PROJECT as never,
        history,
        anchor: review.id,
        operationToken: "memory-disallowed-type",
      }),
    ).rejects.toMatchObject({ code: "DISALLOWED_TYPE" });
    expect(harness.admission.admit).not.toHaveBeenCalled();
  });

  it("maps model and admission failures without partial success", async () => {
    const { review, history } = extractionHistory();
    const modelFailure = createKnowledgeExtractor({
      summarizer: { summarize: vi.fn(() => Promise.reject(new Error("offline"))) },
      admission: { admit: vi.fn() },
    });
    await expect(
      modelFailure.extract({
        project: PROJECT as never,
        history,
        anchor: review.id,
        operationToken: "memory-model-failure",
      }),
    ).rejects.toMatchObject({ code: "MODEL_FAILURE" });

    const admission = vi.fn(() => Promise.reject(new Error("store unavailable")));
    const admissionFailure = createKnowledgeExtractor({
      summarizer: {
        summarize: () => ({
          type: "task-summary",
          title: "Storage research completed",
          summary: "Option A wins.",
        }),
      },
      admission: { admit: admission },
    });
    await expect(
      admissionFailure.extract({
        project: PROJECT as never,
        history,
        anchor: review.id,
        operationToken: "memory-admission-failure",
      }),
    ).rejects.toMatchObject({ code: "ADMISSION_FAILURE" });
    expect(admission).toHaveBeenCalledOnce();
  });

  it("fails invalid windows/projects before model or admission", async () => {
    const { review, history } = extractionHistory();
    const harness = extractorHarness();
    await expect(
      harness.extractor.extract({
        project: "proj_other" as never,
        history,
        anchor: review.id,
        operationToken: "memory-wrong-project",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(harness.summarizer.summarize).not.toHaveBeenCalled();
    expect(harness.admission.admit).not.toHaveBeenCalled();

    await expect(
      harness.extractor.extract({
        project: PROJECT as never,
        history: [review],
        anchor: review.id,
        operationToken: "memory-bad-window",
      }),
    ).rejects.toMatchObject({ code: "WINDOW_FAILURE" });
  });

  it("rejects invalid options and request authority", async () => {
    expect(() => createKnowledgeExtractor(null as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_OPTIONS" }),
    );
    expect(() =>
      createKnowledgeExtractor({ summarizer: {} as never, admission: {} as never }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_OPTIONS" }));
    const { review, history } = extractionHistory();
    const harness = extractorHarness();
    await expect(
      harness.extractor.extract({
        project: PROJECT as never,
        history,
        anchor: review.id,
        operationToken: " ",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      harness.extractor.extract({
        project: PROJECT as never,
        history,
        anchor: review.id,
        operationToken: "valid",
        injected: true,
      } as KnowledgeExtractionRequest),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("exposes stable domain errors", () => {
    const error = new KnowledgeExtractionError("MODEL_FAILURE", "failed");
    expect(error).toMatchObject({
      name: "KnowledgeExtractionError",
      code: "MODEL_FAILURE",
    });
  });
});
