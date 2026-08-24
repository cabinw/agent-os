import { describe, expect, it } from "vitest";
import { newEventId, parseStoredEvent } from "../packages/event-core/src/index.js";
import type {
  Capability,
  EventPayload,
  EventType,
  StoredEvent,
} from "../packages/event-core/src/index.js";
import {
  AgentCatalogError,
  AgentRoutingInputError,
  agentPlacementKey,
  parseAgentCatalogState,
  rankAgentPlacements,
  reduceAgentCatalog,
  selectAgentPlacement,
} from "../packages/task-engine/src/index.js";
import type {
  AgentCatalogState,
  LivePlacement,
  TaskProjectState,
  TaskState,
  TaskStatus,
} from "../packages/task-engine/src/index.js";

const PROJECT = "proj_routing";
const INTEGRATION = {
  participates: true,
  streaming: true,
  reasoning: false,
  session: true,
  usage: true,
} as const;
let sequence = 0;

function event<Type extends EventType>(
  type: Type,
  agent: string,
  payload: EventPayload<Type>,
): StoredEvent<Type> {
  sequence += 1;
  return parseStoredEvent({
    schemaVersion: 1,
    id: newEventId(),
    type,
    seq: sequence,
    project: PROJECT,
    actor: { kind: "system", id: "runtime" },
    subject: { kind: "agent", id: agent },
    at: `2026-08-24T05:${String(sequence).padStart(2, "0")}:00Z`,
    payload,
  }) as StoredEvent<Type>;
}

function registration(
  agent: string,
  host: string,
  capabilities: readonly Capability[],
  concurrency = 1,
  overrides: Partial<EventPayload<"agent.registered">> = {},
): StoredEvent<"agent.registered"> {
  return event("agent.registered", agent, {
    id: agent,
    name: agent.toUpperCase(),
    provider: `display-${agent}`,
    role: "developer",
    concurrency,
    host,
    capabilities: [...capabilities],
    integration: INTEGRATION,
    ...overrides,
  });
}

function catalog(...registrations: StoredEvent<"agent.registered">[]): AgentCatalogState {
  return registrations.reduce(reduceAgentCatalog, { placements: {} });
}

function task(id: string, executor: string, status: TaskStatus): TaskState {
  return { id, executor, status } as TaskState;
}

function tasks(...items: TaskState[]): TaskProjectState {
  return { tasks: Object.fromEntries(items.map((item) => [item.id, item])) };
}

function live(agent: string, host: string, active = 0, accepting = true): LivePlacement {
  return { agent, host, active, accepting } as LivePlacement;
}

describe("RM-1.2c · event-derived Agent Catalog", () => {
  it("keeps host-specific capabilities under one consistent logical agent", () => {
    const state = catalog(
      registration("alpha", "mac", ["coding"], 2),
      registration("alpha", "linux", ["coding", "testing"], 2),
    );
    expect(Object.keys(state.placements)).toEqual([
      agentPlacementKey("alpha", "mac"),
      agentPlacementKey("alpha", "linux"),
    ]);
    expect(state.placements[agentPlacementKey("alpha", "linux")]?.capabilities).toEqual([
      "coding",
      "testing",
    ]);
  });

  it("rejects duplicate placements and conflicting logical fields", () => {
    const first = registration("alpha", "mac", ["coding"], 2);
    const state = reduceAgentCatalog({ placements: {} }, first);
    expect(() => reduceAgentCatalog(state, first)).toThrow(AgentCatalogError);
    expect(() =>
      reduceAgentCatalog(state, registration("alpha", "linux", ["testing"], 3)),
    ).toThrowError(expect.objectContaining({ code: "INCONSISTENT_AGENT" }));
  });

  it("enforces exact status replay and disconnect finality", () => {
    const initial = catalog(registration("alpha", "mac", ["coding"]));
    const working = reduceAgentCatalog(
      initial,
      event("agent.status.changed", "alpha", {
        host: "mac",
        from: "idle",
        to: "working",
      }),
    );
    expect(working.placements[agentPlacementKey("alpha", "mac")]?.status).toBe("working");
    expect(() =>
      reduceAgentCatalog(
        working,
        event("agent.status.changed", "alpha", {
          host: "mac",
          from: "idle",
          to: "blocked",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "STALE_STATUS" }));

    const disconnected = reduceAgentCatalog(
      working,
      event("agent.disconnected", "alpha", {
        id: "alpha",
        host: "mac",
        graceful: false,
      }),
    );
    expect(
      disconnected.placements[agentPlacementKey("alpha", "mac")]?.disconnectedAt,
    ).toBeDefined();
    expect(() =>
      reduceAgentCatalog(
        disconnected,
        event("agent.status.changed", "alpha", {
          host: "mac",
          from: "working",
          to: "idle",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "STALE_STATUS" }));
  });

  it("rejects lifecycle events for an unknown placement", () => {
    expect(() =>
      reduceAgentCatalog(
        { placements: {} },
        event("agent.status.changed", "ghost", {
          host: "nowhere",
          from: "idle",
          to: "working",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "MISSING_PLACEMENT" }));
  });

  it("strictly parses snapshots and checks placement keys", () => {
    const state = catalog(registration("alpha", "mac", ["coding"]));
    expect(parseAgentCatalogState(state, PROJECT as never)).toEqual(state);
    const key = agentPlacementKey("alpha", "mac");
    expect(() =>
      parseAgentCatalogState(
        { placements: { wrong: { ...state.placements[key] } } },
        PROJECT as never,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
    expect(() =>
      parseAgentCatalogState(
        {
          placements: {
            [key]: { ...state.placements[key], surprise: true },
          },
        },
        PROJECT as never,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
  });
});

describe("RM-1.2c · deterministic capability routing", () => {
  it("uses lexical agent and host ids as the final stable tie-break", () => {
    const state = catalog(
      registration("beta", "z-host", ["coding"]),
      registration("alpha", "z-host", ["coding"]),
      registration("alpha", "a-host", ["coding"]),
    );
    const ranked = rankAgentPlacements(
      state,
      tasks(),
      [live("beta", "z-host"), live("alpha", "z-host"), live("alpha", "a-host")],
      ["coding"],
    );
    expect(ranked.map((item) => `${item.agent}@${item.host}`)).toEqual([
      "alpha@a-host",
      "alpha@z-host",
      "beta@z-host",
    ]);
    expect(ranked[0]).not.toHaveProperty("provider");
  });

  it("ranks lower logical load before placement load and past outcomes", () => {
    const state = catalog(
      registration("alpha", "a1", ["coding"], 4),
      registration("alpha", "a2", ["coding"], 4),
      registration("beta", "b1", ["coding"], 4),
    );
    const history = tasks(
      task("TASK-001", "alpha", "completed"),
      task("TASK-002", "alpha", "completed"),
      task("TASK-003", "beta", "failed"),
    );
    const ranked = rankAgentPlacements(
      state,
      history,
      [live("alpha", "a1", 1), live("alpha", "a2", 1), live("beta", "b1", 1)],
      ["coding"],
    );
    expect(ranked[0]?.agent).toBe("beta");
    expect(ranked[0]?.logicalActive).toBe(1);
    expect(ranked[1]?.agent).toBe("alpha");
  });

  it("uses placement load then Laplace-smoothed accepted outcomes", () => {
    const state = catalog(
      registration("alpha", "a1", ["coding"], 3),
      registration("alpha", "a2", ["coding"], 3),
      registration("beta", "b1", ["coding"], 3),
    );
    const history = tasks(
      task("TASK-001", "alpha", "completed"),
      task("TASK-002", "beta", "failed"),
      task("TASK-003", "beta", "cancelled"),
    );
    const ranked = rankAgentPlacements(
      state,
      history,
      [live("alpha", "a1", 1), live("alpha", "a2", 0), live("beta", "b1", 1)],
      ["coding"],
    );
    expect(ranked.map((item) => `${item.agent}@${item.host}`)).toEqual([
      "alpha@a2",
      "alpha@a1",
      "beta@b1",
    ]);
    expect(ranked[2]?.outcomes).toEqual({ completed: 0, failed: 1 });
  });

  it("sums active work across hosts and excludes every placement when saturated", () => {
    const state = catalog(
      registration("alpha", "mac", ["coding"], 2),
      registration("alpha", "linux", ["coding"], 2),
    );
    const snapshot = [live("alpha", "mac", 1), live("alpha", "linux", 1)];
    expect(rankAgentPlacements(state, tasks(), snapshot, ["coding"])).toEqual([]);
    expect(selectAgentPlacement(state, tasks(), snapshot, ["coding"])).toEqual({
      matched: false,
      reason: "saturated",
      requiredCapabilities: ["coding"],
    });
  });

  it.each([
    {
      reason: "no-capability",
      capabilities: ["testing"] as Capability[],
      snapshot: [live("alpha", "mac")],
    },
    {
      reason: "unreachable",
      capabilities: ["coding"] as Capability[],
      snapshot: [],
    },
    {
      reason: "unavailable",
      capabilities: ["coding"] as Capability[],
      snapshot: [live("alpha", "mac", 0, false)],
    },
  ])("returns an explicit $reason result", ({ reason, capabilities, snapshot }) => {
    const state = catalog(registration("alpha", "mac", ["coding"]));
    expect(selectAgentPlacement(state, tasks(), snapshot, capabilities)).toEqual({
      matched: false,
      reason,
      requiredCapabilities: capabilities,
    });
  });

  it("rejects duplicate, malformed and unregistered live telemetry", () => {
    const state = catalog(registration("alpha", "mac", ["coding"]));
    expect(() =>
      rankAgentPlacements(
        state,
        tasks(),
        [live("alpha", "mac"), live("alpha", "mac")],
        ["coding"],
      ),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_LIVE_PLACEMENT" }));
    expect(() =>
      rankAgentPlacements(state, tasks(), [live("ghost", "mac")], ["coding"]),
    ).toThrow(AgentRoutingInputError);
    expect(() =>
      rankAgentPlacements(
        state,
        tasks(),
        [{ ...live("alpha", "mac"), active: -1 }],
        ["coding"],
      ),
    ).toThrow(AgentRoutingInputError);
  });
});
