import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEventBus,
  newEventId,
  parseStoredEvent,
} from "../packages/event-core/src/index.js";
import type {
  Actor,
  EventAppendInput,
  EventPayload,
  EventType,
  StoredEvent,
} from "../packages/event-core/src/index.js";
import { openSqliteEventStore } from "../packages/event-store-sqlite/src/index.js";
import {
  ConversationProjectionError,
  PROJECT_THREAD_KEY,
  emptyConversationProjectState,
  parseConversationProjectState,
  reduceConversationProject,
  registerConversationReducer,
} from "../packages/task-engine/src/index.js";

const PROJECT = "proj_conversation" as never;
const TASK_ONE = "TASK-001" as never;
const TASK_TWO = "TASK-002" as never;
const AGENT = "codex" as never;
const AGENT_TWO = "claude" as never;
const HUMAN = "owner" as never;

let sequence = 0;
const scratchRoots: string[] = [];

beforeEach(() => {
  sequence = 0;
});

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratchPath(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-os-conversation-")));
  scratchRoots.push(root);
  return join(root, "events.sqlite");
}

function stored<Type extends EventType>(
  type: Type,
  payload: EventPayload<Type>,
  subject: { kind: string; id: string },
  actor: Actor = { kind: "agent", id: AGENT },
): StoredEvent<Type> {
  sequence += 1;
  return parseStoredEvent({
    schemaVersion: 1,
    id: newEventId(),
    type,
    seq: sequence,
    project: PROJECT,
    actor,
    subject,
    at: `2026-08-24T10:${String(sequence).padStart(2, "0")}:00Z`,
    payload,
  }) as StoredEvent<Type>;
}

function created(task = TASK_ONE, title = "Implement reducer") {
  return stored(
    "task.created",
    {
      title,
      goal: "GOAL-001" as never,
      requires: ["coding"],
      priority: "high",
      dependsOn: [],
      requiresApproval: false,
    },
    { kind: "task", id: task },
  );
}

function assigned(task = TASK_ONE, executor = AGENT) {
  return stored(
    "task.assigned",
    { executor, matchedBy: "explicit" },
    { kind: "task", id: task },
  );
}

function message(
  content: string,
  options: {
    task?: typeof TASK_ONE;
    type?: EventPayload<"message.sent">["type"];
    from?: typeof AGENT;
    to?: typeof AGENT | "*";
    replyTo?: string;
    actor?: Actor;
  } = {},
) {
  const from = options.from ?? AGENT;
  const payload: EventPayload<"message.sent"> = {
    from,
    to: options.to ?? AGENT_TWO,
    type: options.type ?? "report",
    content,
    ...(options.task === undefined ? {} : { task: options.task }),
    ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo as never }),
  };
  return stored(
    "message.sent",
    payload,
    options.task === undefined
      ? { kind: "project", id: PROJECT }
      : { kind: "task", id: options.task },
    options.actor ?? { kind: "agent", id: from },
  );
}

function fold(events: readonly StoredEvent[]) {
  return events.reduce(reduceConversationProject, emptyConversationProjectState());
}

function toInput(event: StoredEvent): EventAppendInput {
  const { schemaVersion: _schemaVersion, id: _id, seq: _seq, at: _at, ...input } = event;
  return input as EventAppendInput;
}

describe("RM-1.5b · conversation reducer", () => {
  it("creates one project thread and one derived thread per task", () => {
    const events = [
      created(),
      assigned(),
      stored("task.started", { executor: AGENT }, { kind: "task", id: TASK_ONE }),
      stored(
        "task.progress.updated",
        { progress: 42, note: "Parser complete" },
        { kind: "task", id: TASK_ONE },
      ),
      message("Project note"),
      message("Task report", { task: TASK_ONE }),
    ];
    const state = fold(events);

    expect(Object.keys(state.threads).sort()).toEqual([PROJECT_THREAD_KEY, TASK_ONE]);
    expect(state.threads[TASK_ONE]).toMatchObject({
      task: TASK_ONE,
      title: "Implement reducer",
      status: "running",
      progress: 42,
      executor: AGENT,
    });
    expect(state.threads[TASK_ONE]?.items).toHaveLength(2);
    expect(state.threads[PROJECT_THREAD_KEY]?.items).toHaveLength(1);
  });

  it("interleaves the canonical lifecycle and rejects illegal transitions", () => {
    const events = [
      created(),
      assigned(),
      stored("task.started", { executor: AGENT }, { kind: "task", id: TASK_ONE }),
      stored(
        "task.blocked",
        { reason: "Need a decision", severity: "high", needs: "human" },
        { kind: "task", id: TASK_ONE },
      ),
      stored(
        "task.unblocked",
        { resolution: "Decision recorded" },
        { kind: "task", id: TASK_ONE },
      ),
      stored(
        "task.review.requested",
        { summary: "Done", outputs: ["result.md"] },
        { kind: "task", id: TASK_ONE },
      ),
      stored("task.completed", { acceptedBy: HUMAN }, { kind: "task", id: TASK_ONE }),
    ];
    const state = fold(events);
    expect(state.threads[TASK_ONE]?.items.map((item) => item.kind)).toEqual([
      "divider",
      "divider",
      "divider",
      "divider",
      "divider",
    ]);
    expect(state.threads[TASK_ONE]?.status).toBe("completed");

    expect(() =>
      fold([
        created(TASK_TWO),
        stored("task.completed", { acceptedBy: HUMAN }, { kind: "task", id: TASK_TWO }),
      ]),
    ).toThrow("illegal task transition");
  });

  it("keeps cancellation as a terminal divider", () => {
    const state = fold([
      created(),
      stored(
        "task.cancelled",
        { by: HUMAN, reason: "No longer needed" },
        { kind: "task", id: TASK_ONE },
        { kind: "human", id: HUMAN },
      ),
    ]);
    expect(state.threads[TASK_ONE]).toMatchObject({ status: "cancelled" });
    expect(state.threads[TASK_ONE]?.items[0]).toMatchObject({
      kind: "divider",
      event: { type: "task.cancelled" },
    });
  });

  it("carries approval attribution from request to its terminal decision", () => {
    const request = stored(
      "approval.requested",
      {
        action: "Publish",
        risk: "high",
        reversible: true,
        requestedBy: AGENT,
        task: TASK_ONE,
        detail: "Publish release",
      },
      { kind: "approval", id: "approval-001" },
    );
    const granted = stored(
      "approval.granted",
      { by: HUMAN, note: "Reviewed" },
      { kind: "approval", id: "approval-001" },
      { kind: "human", id: HUMAN },
    );
    const state = fold([created(), request, granted]);
    expect(state.approvals["approval-001"]).toEqual({
      thread: TASK_ONE,
      status: "granted",
    });
    expect(state.threads[TASK_ONE]?.items.map((item) => item.kind)).toEqual([
      "divider",
      "divider",
    ]);
  });

  it("places taskless approvals in the project thread", () => {
    const request = stored(
      "approval.requested",
      {
        action: "Archive project",
        risk: "critical",
        reversible: false,
        requestedBy: AGENT,
        detail: "Archive all active work",
      },
      { kind: "approval", id: "approval-project" },
    );
    const state = fold([request]);
    expect(state.approvals["approval-project"]?.thread).toBe(PROJECT_THREAD_KEY);
    expect(state.threads[PROJECT_THREAD_KEY]?.items).toHaveLength(1);
  });

  it("fans related knowledge into each named task and defaults to project", () => {
    const related = stored(
      "knowledge.created",
      {
        type: "decision",
        title: "Use event attribution",
        summary: "Threads remain derived",
        sourceEvents: [newEventId()],
        rationale: "Avoid a second source of truth",
        relatedTasks: [TASK_ONE, TASK_TWO],
      },
      { kind: "knowledge", id: "KN-001" },
      { kind: "system", id: "memory" },
    );
    const projectKnowledge = stored(
      "knowledge.created",
      {
        type: "technical-note",
        title: "Project note",
        summary: "No task attribution",
        sourceEvents: [newEventId()],
      },
      { kind: "knowledge", id: "KN-002" },
      { kind: "system", id: "memory" },
    );
    const state = fold([
      created(),
      created(TASK_TWO, "Test reducer"),
      related,
      projectKnowledge,
    ]);
    expect(state.threads[TASK_ONE]?.items[0]).toMatchObject({
      event: { id: related.id },
    });
    expect(state.threads[TASK_TWO]?.items[0]).toMatchObject({
      event: { id: related.id },
    });
    expect(state.threads[PROJECT_THREAD_KEY]?.items[0]).toMatchObject({
      event: { id: projectKnowledge.id },
    });
  });

  it("collapses only adjacent progress from the same sender and recipient", () => {
    const first = message("10%", { task: TASK_ONE, type: "progress" });
    const second = message("20%", { task: TASK_ONE, type: "progress" });
    const otherSender = message("Reviewing", {
      task: TASK_ONE,
      type: "progress",
      from: AGENT_TWO,
      to: AGENT,
    });
    const report = message("Checkpoint", { task: TASK_ONE, type: "report" });
    const state = fold([created(), first, second, otherSender, report]);
    const items = state.threads[TASK_ONE]?.items ?? [];
    expect(items.map((item) => item.kind)).toEqual([
      "progress-run",
      "message",
      "message",
    ]);
    expect(items[0]).toMatchObject({
      kind: "progress-run",
      events: [{ id: first.id }, { id: second.id }],
    });
  });

  it("a divider closes a progress run without dropping either message", () => {
    const first = message("10%", { task: TASK_ONE, type: "progress" });
    const second = message("20%", { task: TASK_ONE, type: "progress" });
    const state = fold([
      created(),
      assigned(),
      first,
      stored("task.started", { executor: AGENT }, { kind: "task", id: TASK_ONE }),
      second,
    ]);
    expect(state.threads[TASK_ONE]?.items.map((item) => item.kind)).toEqual([
      "message",
      "divider",
      "message",
    ]);
  });

  it("allows only prior replies in the same thread", () => {
    const question = message("Which policy?", {
      task: TASK_ONE,
      type: "question",
    });
    const answer = message("Strict", {
      task: TASK_ONE,
      type: "answer",
      replyTo: question.id,
    });
    expect(fold([created(), question, answer]).threads[TASK_ONE]?.items).toHaveLength(2);

    const projectMessage = message("Project question", { type: "question" });
    const crossThread = message("Wrong thread", {
      task: TASK_ONE,
      type: "answer",
      replyTo: projectMessage.id,
    });
    expect(() => fold([created(), projectMessage, crossThread])).toThrow(
      ConversationProjectionError,
    );
  });

  it("fails closed for missing task, approval and sender relationships", () => {
    expect(() => fold([message("orphan", { task: TASK_ONE })])).toThrow("does not exist");
    expect(() =>
      fold([
        stored(
          "approval.rejected",
          { by: HUMAN, reason: "No" },
          { kind: "approval", id: "approval-missing" },
          { kind: "human", id: HUMAN },
        ),
      ]),
    ).toThrow("has no request attribution");
    expect(() =>
      fold([
        message("spoofed", {
          actor: { kind: "human", id: HUMAN },
        }),
      ]),
    ).toThrow("sender must match");
  });

  it("rejects duplicate and post-terminal approval events", () => {
    const request = stored(
      "approval.requested",
      {
        action: "Publish",
        risk: "high",
        reversible: true,
        requestedBy: AGENT,
        detail: "Publish",
      },
      { kind: "approval", id: "approval-terminal" },
    );
    const expired = stored(
      "approval.expired",
      { after: "2026-08-24T10:01:00Z" },
      { kind: "approval", id: "approval-terminal" },
      { kind: "system", id: "runtime" },
    );
    const rejected = stored(
      "approval.rejected",
      { by: HUMAN, reason: "Too late" },
      { kind: "approval", id: "approval-terminal" },
      { kind: "human", id: HUMAN },
    );
    expect(() => fold([request, request])).toThrow("already has thread attribution");
    expect(() => fold([request, expired, rejected])).toThrow("already expired");
  });

  it("strictly restores canonical snapshots and rejects index drift", () => {
    const first = message("10%", { task: TASK_ONE, type: "progress" });
    const second = message("20%", { task: TASK_ONE, type: "progress" });
    const state = fold([created(), first, second]);
    const serialized = JSON.parse(JSON.stringify(state));
    expect(parseConversationProjectState(serialized, PROJECT)).toEqual(state);

    serialized.messageThreads[first.id] = PROJECT_THREAD_KEY;
    expect(() => parseConversationProjectState(serialized, PROJECT)).toThrow(
      "message thread index does not match",
    );
  });

  it("rejects noncanonical progress snapshots and unknown fields", () => {
    const first = message("10%", { task: TASK_ONE, type: "progress" });
    const second = message("20%", { task: TASK_ONE, type: "progress" });
    const state = JSON.parse(JSON.stringify(fold([created(), first, second])));
    const run = state.threads[TASK_ONE].items[0];
    state.threads[TASK_ONE].items = run.events.map((event: unknown) => ({
      kind: "message",
      event,
    }));
    expect(() => parseConversationProjectState(state, PROJECT)).toThrow(
      "uncollapsed progress run",
    );

    const unknown = JSON.parse(JSON.stringify(fold([created()])));
    unknown.extra = true;
    expect(() => parseConversationProjectState(unknown, PROJECT)).toThrow(
      "unknown field extra",
    );
  });

  it("full Event Bus replay equals the incremental projection", () => {
    const events = [
      created(),
      assigned(),
      stored("task.started", { executor: AGENT }, { kind: "task", id: TASK_ONE }),
      message("10%", { task: TASK_ONE, type: "progress" }),
      message("20%", { task: TASK_ONE, type: "progress" }),
      stored(
        "task.review.requested",
        { summary: "Done", outputs: ["result.md"] },
        { kind: "task", id: TASK_ONE },
      ),
    ];
    const store = openSqliteEventStore({ path: scratchPath() });
    const liveBus = createEventBus({ store });
    const live = registerConversationReducer(liveBus);
    events.forEach((event, index) => {
      liveBus.append(toInput(event), { token: `conversation-${index}` });
    });
    const incremental = live.get(PROJECT);

    const replayBus = createEventBus({ store });
    const replayed = registerConversationReducer(replayBus);
    replayBus.replay(PROJECT);
    expect(replayed.get(PROJECT)).toEqual(incremental);
    store.close();
  });
});
