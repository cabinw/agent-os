import { describe, expect, it } from "vitest";
import { newEventId, parseStoredEvent } from "../packages/event-core/src/index.js";
import type {
  EntityId,
  EventId,
  EventPayload,
  EventType,
  KnowledgeId,
  ProjectId,
  StoredEvent,
} from "../packages/event-core/src/index.js";
import {
  MemoryGraphError,
  MemoryQueryError,
  buildMemoryGraph,
  emptyKnowledgeProjectState,
  parseKnowledgeProjectState,
  queryMemory,
  reduceKnowledgeProject,
} from "../packages/memory-core/src/index.js";
import type {
  KnowledgeProjectState,
  MemoryQuery,
} from "../packages/memory-core/src/index.js";

const PROJECT = "proj_memory_graph" as ProjectId;
const ACTOR = { kind: "agent" as const, id: "memory-agent" as EntityId };

function stored<Type extends EventType>(
  seq: number,
  type: Type,
  subject: { kind: StoredEvent<Type>["subject"]["kind"]; id: string },
  payload: EventPayload<Type>,
  options: Readonly<{
    id?: EventId;
    causedBy?: EventId;
    project?: ProjectId;
    at?: string;
  }> = {},
): StoredEvent<Type> {
  return parseStoredEvent({
    schemaVersion: 1,
    id: options.id ?? newEventId(),
    type,
    seq,
    project: options.project ?? PROJECT,
    actor: ACTOR,
    subject,
    at: options.at ?? `2026-08-${String(seq).padStart(2, "0")}T12:00:00Z`,
    ...(options.causedBy === undefined ? {} : { causedBy: options.causedBy }),
    payload,
  }) as StoredEvent<Type>;
}

function knowledgeCreated(
  seq: number,
  idValue: string,
  source: EventId,
  options: Readonly<{
    type?: "decision" | "research";
    relatedTasks?: readonly string[];
    causedBy?: EventId;
    at?: string;
  }> = {},
): StoredEvent<"knowledge.created"> {
  const type = options.type ?? "decision";
  return stored(
    seq,
    "knowledge.created",
    { kind: "knowledge", id: idValue },
    {
      type,
      title: `${idValue} PostgreSQL`,
      summary: `${idValue} stores relational joins`,
      sourceEvents: [source],
      ...(type === "decision" ? { rationale: "Strong relational integrity" } : {}),
      ...(options.relatedTasks === undefined
        ? {}
        : { relatedTasks: options.relatedTasks as never }),
    },
    { causedBy: options.causedBy, at: options.at },
  );
}

function fold(events: readonly StoredEvent[]): KnowledgeProjectState {
  return events.reduce(reduceKnowledgeProject, emptyKnowledgeProjectState());
}

function query(state: KnowledgeProjectState, value: MemoryQuery = {}) {
  return queryMemory({ project: PROJECT, state, query: value });
}

function fixture() {
  const root = stored(
    1,
    "project.created",
    { kind: "project", id: PROJECT },
    { name: "Memory graph", stack: ["TypeScript"] },
  );
  const old = knowledgeCreated(2, "KN-001", root.id, {
    causedBy: root.id,
    relatedTasks: ["TASK-001"],
    at: "2026-08-02T12:00:00Z",
  });
  const next = knowledgeCreated(3, "KN-002", old.id, {
    causedBy: old.id,
    relatedTasks: ["TASK-001"],
    at: "2026-08-03T12:00:00Z",
  });
  const superseded = stored(
    4,
    "knowledge.superseded",
    { kind: "knowledge", id: "KN-001" },
    { old: "KN-001" as KnowledgeId, new: "KN-002" as KnowledgeId },
    { causedBy: next.id },
  );
  const research = knowledgeCreated(5, "KN-003", superseded.id, {
    type: "research",
    causedBy: superseded.id,
    at: "2026-08-05T12:00:00Z",
  });
  const measurement = stored(
    6,
    "measurement.recorded",
    { kind: "measurement", id: "measurement-retention" },
    {
      metric: "retention",
      value: 91,
      unit: "percent",
      source: "production",
      at: "2026-08-06T11:00:00Z",
    },
    { causedBy: research.id },
  );
  const linked = stored(
    7,
    "knowledge.linked",
    { kind: "knowledge", id: "KN-002" },
    {
      from: "KN-002" as EntityId,
      to: "measurement-retention" as EntityId,
      relation: "validated-by",
    },
    { causedBy: measurement.id },
  );
  const history = [root, old, next, superseded, research, measurement, linked];
  return { history, linked, measurement, next, old, root, state: fold(history) };
}

describe("RM-2.5 · memory semantic relation projection", () => {
  it("projects an event-identified immutable semantic relation", () => {
    const { linked, state } = fixture();
    expect(state.relations[linked.id]).toEqual({
      event: linked.id,
      eventSeq: 7,
      knowledge: "KN-002",
      from: "KN-002",
      to: "measurement-retention",
      relation: "validated-by",
      at: linked.at,
      actor: ACTOR,
    });
    expect(Object.isFrozen(state.relations[linked.id])).toBe(true);
  });

  it.each([
    ["missing subject", "KN-999", "KN-999", "measurement"],
    ["subject is not endpoint", "KN-001", "KN-002", "measurement"],
  ])("rejects %s", (_label, subject, from, to) => {
    const { old, root } = fixture();
    const base = fold([root, old]);
    const invalid = stored(
      3,
      "knowledge.linked",
      { kind: "knowledge", id: subject },
      { from: from as EntityId, to: to as EntityId, relation: "informs" },
      { causedBy: old.id },
    );
    expect(() => reduceKnowledgeProject(base, invalid)).toThrowError(
      expect.objectContaining({ code: "INVALID_RELATION" }),
    );
  });

  it("strictly rejects malformed relation snapshots", () => {
    const { linked, state } = fixture();
    const relation = state.relations[linked.id];
    expect(() =>
      parseKnowledgeProjectState(
        {
          ...state,
          relations: {
            ...state.relations,
            [linked.id]: { ...relation, to: "KN-002" },
          },
        },
        PROJECT,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
  });
});

describe("RM-2.5 · deterministic memory query", () => {
  it("lists all history by default and composes text, type and inclusive time", () => {
    const { state } = fixture();
    expect(query(state).map((result) => result.item.id)).toEqual([
      "KN-001",
      "KN-002",
      "KN-003",
    ]);
    expect(
      query(state, {
        q: "RELATIONAL",
        type: "decision",
        after: "2026-08-03T12:00:00Z",
        before: "2026-08-03T12:00:00Z",
      }).map((result) => result.item.id),
    ).toEqual(["KN-002"]);
  });

  it("filters active and superseded items without hiding history by default", () => {
    const { state } = fixture();
    expect(query(state, { status: "active" }).map((result) => result.item.id)).toEqual([
      "KN-002",
      "KN-003",
    ]);
    expect(
      query(state, { status: "superseded" }).map((result) => result.item.id),
    ).toEqual(["KN-001"]);
  });

  it("requires one relation descriptor to satisfy entity and label together", () => {
    const { state } = fixture();
    const linked = query(state, {
      relatedTo: "measurement-retention" as EntityId,
      relation: "validated-by",
    });
    expect(linked.map((result) => result.item.id)).toEqual(["KN-002"]);
    expect(linked[0]?.relations).toEqual([
      expect.objectContaining({
        kind: "linked",
        to: "measurement-retention",
        relation: "validated-by",
      }),
    ]);
    expect(
      query(state, {
        relatedTo: "measurement-retention" as EntityId,
        relation: "related-task",
      }),
    ).toEqual([]);
  });

  it("queries task and supersession relations", () => {
    const { state } = fixture();
    expect(
      query(state, { relatedTo: "TASK-001" as EntityId }).map((result) => result.item.id),
    ).toEqual(["KN-001", "KN-002"]);
    expect(
      query(state, { relation: "supersedes" }).map((result) => result.item.id),
    ).toEqual(["KN-002"]);
  });

  it("does not impose a hidden result limit", () => {
    const root = fixture().root;
    const events: StoredEvent[] = [root];
    let cause = root.id;
    for (let index = 1; index <= 150; index += 1) {
      const created = knowledgeCreated(
        index + 1,
        `KN-${String(index).padStart(3, "0")}`,
        root.id,
        {
          type: "research",
          causedBy: cause,
          at: "2026-08-08T12:00:00Z",
        },
      );
      events.push(created);
      cause = created.id;
    }
    expect(query(fold(events))).toHaveLength(150);
  });

  it.each([
    [{ after: "2026-08-04T00:00:00Z", before: "2026-08-03T00:00:00Z" }],
    [{ q: " padded " }],
    [{ injected: true }],
  ] as const)("rejects invalid query %#", (invalid) => {
    expect(() => query(fixture().state, invalid as never)).toThrowError(
      expect.objectContaining({ name: "MemoryQueryError", code: "INVALID_QUERY" }),
    );
  });

  it("maps malformed projection state and freezes results", () => {
    expect(() =>
      queryMemory({ project: PROJECT, state: { injected: true } as never, query: {} }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
    const result = query(fixture().state);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(new MemoryQueryError("INVALID_QUERY", "bad")).toMatchObject({
      name: "MemoryQueryError",
      code: "INVALID_QUERY",
    });
  });
});

describe("RM-2.5 · replay-derived causal graph", () => {
  it("derives only causedBy edges and keeps semantic links separate", () => {
    const { history, linked, measurement, root } = fixture();
    const graph = buildMemoryGraph({ project: PROJECT, history });
    expect(graph.nodes).toHaveLength(7);
    expect(graph.edges).toHaveLength(6);
    expect(graph.edges[0]).toEqual({
      from: history[1]?.id,
      to: root.id,
      relation: "causedBy",
    });
    expect(graph.edges.at(-1)).toEqual({
      from: linked.id,
      to: measurement.id,
      relation: "causedBy",
    });
    expect(graph.edges).not.toContainEqual(
      expect.objectContaining({ from: "KN-002", to: "measurement-retention" }),
    );
    expect(graph.semanticRelations).toEqual([
      expect.objectContaining({ event: linked.id, relation: "validated-by" }),
    ]);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.edges)).toBe(true);
  });

  it.each([
    ["sequence gap", (history: StoredEvent[]) => [{ ...history[0], seq: 2 }]],
    [
      "missing cause",
      (history: StoredEvent[]) => [history[0], { ...history[1], causedBy: newEventId() }],
    ],
    [
      "cross project",
      (history: StoredEvent[]) => [history[0], { ...history[1], project: "proj_other" }],
    ],
    [
      "duplicate event",
      (history: StoredEvent[]) => [history[0], { ...history[1], id: history[0]?.id }],
    ],
  ] as const)("fails closed for %s", (_label, mutate) => {
    const invalid = mutate([...fixture().history]) as unknown[];
    expect(() => buildMemoryGraph({ project: PROJECT, history: invalid })).toThrowError(
      expect.objectContaining({ name: "MemoryGraphError" }),
    );
  });

  it("accepts an empty project graph and exposes stable error identity", () => {
    expect(buildMemoryGraph({ project: PROJECT, history: [] })).toEqual({
      project: PROJECT,
      nodes: [],
      edges: [],
      semanticRelations: [],
    });
    expect(new MemoryGraphError("INVALID_CAUSE", "bad", "evt_bad")).toMatchObject({
      name: "MemoryGraphError",
      code: "INVALID_CAUSE",
      eventId: "evt_bad",
    });
  });
});
