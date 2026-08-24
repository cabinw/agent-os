import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EventReplayError,
  ReducerExecutionError,
  ReducerRegistrationError,
  createEventBus,
  parseEventInput,
} from "../packages/event-core/src/index.js";
import type { EventInput, StoredEvent } from "../packages/event-core/src/index.js";
import { openSqliteEventStore } from "../packages/event-store-sqlite/src/index.js";

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratchPath(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-os-event-bus-")));
  scratchRoots.push(root);
  return join(root, "events.sqlite");
}

function projectCreated(
  name: string,
  project = "proj_bus",
): EventInput<"project.created"> {
  return parseEventInput({
    type: "project.created",
    project,
    actor: { kind: "system", id: "runtime" },
    subject: { kind: "project", id: project },
    payload: { name, stack: ["TypeScript"] },
  }) as EventInput<"project.created">;
}

function sequenceReducer(state: readonly number[], event: StoredEvent): number[] {
  return [...state, event.seq];
}

describe("RM-1.1c · Event Bus, replay and reducer registration", () => {
  it("reads an immutable ordered tail from SQLite", () => {
    const store = openSqliteEventStore({ path: scratchPath() });
    store.append(projectCreated("one"), { token: "one" });
    store.append(projectCreated("two"), { token: "two" });
    store.append(projectCreated("other", "proj_other"), { token: "other" });

    const all = store.read("proj_bus");
    expect(all.map((event) => event.seq)).toEqual([1, 2]);
    expect(store.read("proj_bus", { afterSeq: 1 }).map((event) => event.seq)).toEqual([
      2,
    ]);
    expect(store.read("proj_bus", { afterSeq: 2 })).toEqual([]);
    expect(Object.isFrozen(all)).toBe(true);
    expect(() => store.read("proj_bus", { afterSeq: -1 })).toThrow(
      "non-negative safe integer",
    );
    expect(() => store.read("proj_bus", null as never)).toThrow(
      "read options must be an object",
    );
    store.close();
  });

  it("full replay exactly reproduces incremental projection", () => {
    const store = openSqliteEventStore({ path: scratchPath() });
    const incremental = createEventBus({ store });
    const live = incremental.registerReducer(
      "sequence",
      () => [] as number[],
      sequenceReducer,
    );
    incremental.append(projectCreated("one"), { token: "one" });
    incremental.append(projectCreated("two"), { token: "two" });
    incremental.append(projectCreated("three"), { token: "three" });
    const expected = live.get("proj_bus");

    const restarted = createEventBus({ store });
    const replayed = restarted.registerReducer(
      "sequence",
      () => [] as number[],
      sequenceReducer,
    );
    expect(restarted.replay("proj_bus")).toEqual({
      project: "proj_bus",
      eventCount: 3,
      throughSeq: 3,
      reducerCount: 1,
    });
    expect(replayed.get("proj_bus")).toEqual(expected);
    expect(Object.isFrozen(replayed.get("proj_bus"))).toBe(true);
    store.close();
  });

  it("idempotent append retry is neither reduced nor notified twice", () => {
    const store = openSqliteEventStore({ path: scratchPath() });
    const bus = createEventBus({ store });
    const state = bus.registerReducer("sequence", () => [] as number[], sequenceReducer);
    const notified: number[] = [];
    bus.subscribe((event) => notified.push(event.seq));

    const first = bus.append(projectCreated("same"), { token: "same-command" });
    const retry = bus.append(projectCreated("same"), { token: "same-command" });
    expect(retry).toEqual(first);
    expect(state.get("proj_bus")).toEqual([1]);
    expect(notified).toEqual([1]);
    store.close();
  });

  it("isolates sync and async subscriber failures from append and peers", async () => {
    const failures: unknown[] = [];
    const store = openSqliteEventStore({ path: scratchPath() });
    const bus = createEventBus({
      store,
      onSubscriberError: (cause) => failures.push(cause),
    });
    const observed: number[] = [];
    bus.subscribe(() => {
      throw new Error("sync observer failed");
    });
    bus.subscribe(async () => {
      throw new Error("async observer failed");
    });
    bus.subscribe((event) => observed.push(event.seq));

    expect(bus.append(projectCreated("one"), { token: "one" }).seq).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(observed).toEqual([1]);
    expect(failures).toHaveLength(2);
    store.close();
  });

  it("queues reentrant append notifications behind the current sequence", () => {
    const store = openSqliteEventStore({ path: scratchPath() });
    const bus = createEventBus({ store });
    const observed: string[] = [];
    bus.subscribe((event) => {
      observed.push(`a${event.seq}`);
      if (event.seq === 1) {
        bus.append(projectCreated("reentrant"), { token: "reentrant" });
      }
    });
    bus.subscribe((event) => observed.push(`b${event.seq}`));

    bus.append(projectCreated("outer"), { token: "outer" });
    expect(observed).toEqual(["a1", "b1", "a2", "b2"]);
    store.close();
  });

  it("publishes no reducer candidate when a peer reducer fails", () => {
    const store = openSqliteEventStore({ path: scratchPath() });
    const bus = createEventBus({ store });
    const good = bus.registerReducer("good", () => [] as number[], sequenceReducer);
    bus.registerReducer(
      "guard",
      () => 0,
      (state, event) => {
        if (event.seq === 2) throw new Error("projection bug");
        return state + 1;
      },
    );
    const notified: number[] = [];
    bus.subscribe((event) => notified.push(event.seq));
    bus.append(projectCreated("one"), { token: "one" });

    expect(() => bus.append(projectCreated("two"), { token: "two" })).toThrow(
      ReducerExecutionError,
    );
    expect(good.get("proj_bus")).toEqual([1]);
    expect(notified).toEqual([1]);
    expect(store.read("proj_bus").map((event) => event.seq)).toEqual([1, 2]);
    store.close();
  });

  it("rejects async and duplicate reducers without publishing registration", () => {
    const store = openSqliteEventStore({ path: scratchPath() });
    const bus = createEventBus({ store });
    expect(() =>
      bus.registerReducer(
        "declared-async",
        () => 0,
        (async (state) => state + 1) as never,
      ),
    ).toThrow(ReducerRegistrationError);
    bus.append(projectCreated("one"), { token: "one" });
    expect(() =>
      bus.registerReducer("async", () => 0, (() => Promise.resolve(1)) as never),
    ).toThrow(ReducerExecutionError);
    const recovered = bus.registerReducer(
      "async",
      () => 0,
      (state) => state + 1,
    );
    expect(recovered.get("proj_bus")).toBe(1);

    bus.registerReducer(
      "unique",
      () => 0,
      (state) => state,
    );
    expect(() =>
      bus.registerReducer(
        "unique",
        () => 0,
        (state) => state,
      ),
    ).toThrow(ReducerRegistrationError);
    store.close();
  });

  it("late registration replays observed projects through their published sequence", () => {
    const store = openSqliteEventStore({ path: scratchPath() });
    const bus = createEventBus({ store });
    bus.append(projectCreated("one"), { token: "one" });
    bus.append(projectCreated("two"), { token: "two" });

    const late = bus.registerReducer("late", () => [] as number[], sequenceReducer);
    expect(late.get("proj_bus")).toEqual([1, 2]);
    store.close();
  });

  it("catches up commits from another connection before its own event", () => {
    const path = scratchPath();
    const primary = openSqliteEventStore({ path });
    const peer = openSqliteEventStore({ path });
    const bus = createEventBus({ store: primary });
    const state = bus.registerReducer("sequence", () => [] as number[], sequenceReducer);
    const observed: number[] = [];
    bus.subscribe((event) => observed.push(event.seq));
    bus.append(projectCreated("one"), { token: "one" });
    peer.append(projectCreated("two"), { token: "two" });

    bus.append(projectCreated("three"), { token: "three" });
    expect(state.get("proj_bus")).toEqual([1, 2, 3]);
    expect(observed).toEqual([1, 2, 3]);
    peer.close();
    primary.close();
  });

  it("supports project filters and idempotent unsubscribe", () => {
    const store = openSqliteEventStore({ path: scratchPath() });
    const bus = createEventBus({ store });
    const observed: string[] = [];
    const unsubscribe = bus.subscribe((event) => observed.push(event.project), {
      project: "proj_bus",
    });
    bus.append(projectCreated("one"), { token: "one" });
    bus.append(projectCreated("other", "proj_other"), { token: "other" });
    unsubscribe();
    unsubscribe();
    bus.append(projectCreated("two"), { token: "two" });

    expect(observed).toEqual(["proj_bus"]);
    store.close();
  });

  it("replay is strict and never emits historical events to live subscribers", () => {
    const store = openSqliteEventStore({ path: scratchPath() });
    const event = store.append(projectCreated("one"), { token: "one" });
    const observed: number[] = [];
    const bus = createEventBus({ store });
    bus.subscribe((stored) => observed.push(stored.seq));
    bus.replay("proj_bus");
    expect(observed).toEqual([]);

    const malformed = createEventBus({
      store: {
        append: store.append.bind(store),
        read: () => [{ ...event, seq: 2 }],
      },
    });
    expect(() => malformed.replay("proj_bus")).toThrow(EventReplayError);
    store.close();
  });

  it("contains a failure even when the subscriber error sink also throws", () => {
    const store = openSqliteEventStore({ path: scratchPath() });
    const bus = createEventBus({
      store,
      onSubscriberError: () => {
        throw new Error("broken error sink");
      },
    });
    bus.subscribe(() => {
      throw new Error("broken subscriber");
    });
    expect(bus.append(projectCreated("one"), { token: "one" }).seq).toBe(1);
    store.close();
  });
});
