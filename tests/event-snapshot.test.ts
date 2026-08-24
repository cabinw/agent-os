import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus, parseEventInput } from "../packages/event-core/src/index.js";
import type { EventInput, StoredEvent } from "../packages/event-core/src/index.js";
import {
  SNAPSHOT_STORE_APPLICATION_ID,
  SNAPSHOT_STORE_FORMAT_VERSION,
  SnapshotStoreError,
  openSqliteEventStore,
  openSqliteSnapshotStore,
} from "../packages/event-store-sqlite/src/index.js";

const requireFromAdapter = createRequire(
  new URL("../packages/event-store-sqlite/package.json", import.meta.url),
);
const Database = requireFromAdapter("better-sqlite3") as typeof BetterSqlite3;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-os-snapshot-")));
  roots.push(root);
  return {
    root,
    events: join(root, "events.sqlite"),
    snapshots: join(root, "snapshots.sqlite"),
  };
}

function projectCreated(name: string): EventInput<"project.created"> {
  return parseEventInput({
    type: "project.created",
    project: "proj_snapshot",
    actor: { kind: "system", id: "runtime" },
    subject: { kind: "project", id: "proj_snapshot" },
    payload: { name, stack: ["TypeScript"] },
  }) as EventInput<"project.created">;
}

function sequenceReducer(state: readonly number[], event: StoredEvent): number[] {
  return [...state, event.seq];
}

function parseSequenceState(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => !Number.isSafeInteger(item) || item <= 0)
  ) {
    throw new TypeError("invalid sequence projection");
  }
  return [...value] as number[];
}

function registerSequence(
  bus: ReturnType<typeof createEventBus>,
  calls?: { count: number },
  version = "1",
) {
  return bus.registerReducer(
    "sequence",
    () => [] as number[],
    (state, event) => {
      if (calls) calls.count += 1;
      return sequenceReducer(state, event);
    },
    { version, parseState: parseSequenceState },
  );
}

function appendFive(bus: ReturnType<typeof createEventBus>): void {
  for (let index = 1; index <= 5; index += 1) {
    bus.append(projectCreated(`event-${index}`), { token: `event-${index}` });
  }
}

describe("RM-1.1d · discardable projection snapshots", () => {
  it("creates one identified 0600 STRICT WAL sidecar and supports clear", () => {
    const paths = scratch();
    const cache = openSqliteSnapshotStore({ path: paths.snapshots });
    expect(statSync(paths.snapshots).mode & 0o777).toBe(0o600);
    const database = new Database(paths.snapshots, { readonly: true });
    expect(database.pragma("application_id", { simple: true })).toBe(
      SNAPSHOT_STORE_APPLICATION_ID,
    );
    expect(database.pragma("user_version", { simple: true })).toBe(
      SNAPSHOT_STORE_FORMAT_VERSION,
    );
    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    database.close();
    cache.save({
      project: "proj_snapshot",
      throughSeq: 2,
      throughEventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      manifest: "manifest-v1",
      states: { sequence: [1, 2] },
    });
    cache.save({
      project: "proj_snapshot",
      throughSeq: 1,
      throughEventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      manifest: "manifest-v1",
      states: { sequence: [1] },
    });
    expect(cache.load("proj_snapshot", "manifest-v1")?.throughSeq).toBe(2);
    expect(cache.clear()).toBe(1);
    cache.close();
  });

  it("loads the latest boundary then replays only its tail", () => {
    const paths = scratch();
    const events = openSqliteEventStore({ path: paths.events });
    const snapshots = openSqliteSnapshotStore({ path: paths.snapshots });
    const first = createEventBus({ store: events, snapshots, snapshotEvery: 2 });
    registerSequence(first);
    appendFive(first);

    const calls = { count: 0 };
    const restarted = createEventBus({ store: events, snapshots, snapshotEvery: 2 });
    const sequence = registerSequence(restarted, calls);
    expect(sequence.get("proj_snapshot")).toEqual([1, 2, 3, 4, 5]);
    expect(calls.count).toBe(1);
    snapshots.close();
    events.close();
  });

  it("deleting every snapshot preserves state through full replay", () => {
    const paths = scratch();
    const events = openSqliteEventStore({ path: paths.events });
    const snapshots = openSqliteSnapshotStore({ path: paths.snapshots });
    const first = createEventBus({ store: events, snapshots, snapshotEvery: 2 });
    const original = registerSequence(first);
    appendFive(first);
    const expected = original.get("proj_snapshot");
    expect(snapshots.clear()).toBe(1);

    const calls = { count: 0 };
    const restarted = createEventBus({ store: events, snapshots, snapshotEvery: 2 });
    const rebuilt = registerSequence(restarted, calls);
    expect(rebuilt.get("proj_snapshot")).toEqual(expected);
    expect(calls.count).toBe(5);
    snapshots.close();
    events.close();
  });

  it("a reducer cache-version change makes the old row invisible", () => {
    const paths = scratch();
    const events = openSqliteEventStore({ path: paths.events });
    const snapshots = openSqliteSnapshotStore({ path: paths.snapshots });
    const first = createEventBus({ store: events, snapshots, snapshotEvery: 2 });
    registerSequence(first, undefined, "1");
    appendFive(first);

    const calls = { count: 0 };
    const changed = createEventBus({ store: events, snapshots, snapshotEvery: 2 });
    const sequence = registerSequence(changed, calls, "2");
    expect(sequence.get("proj_snapshot")).toEqual([1, 2, 3, 4, 5]);
    expect(calls.count).toBe(5);
    snapshots.close();
    events.close();
  });

  it("rejects parser-invalid cached state and falls back to the complete log", () => {
    const paths = scratch();
    const events = openSqliteEventStore({ path: paths.events });
    const snapshots = openSqliteSnapshotStore({ path: paths.snapshots });
    const writer = createEventBus({ store: events, snapshots, snapshotEvery: 2 });
    registerSequence(writer);
    appendFive(writer);
    const anchor = events.read("proj_snapshot", { afterSeq: 3 })[0] as StoredEvent;
    snapshots.save({
      project: "proj_snapshot",
      throughSeq: 4,
      throughEventId: anchor.id,
      manifest: '[["sequence","1"]]',
      states: { sequence: "not-an-array" },
    });

    const errors: unknown[] = [];
    const restarted = createEventBus({
      store: events,
      snapshots,
      snapshotEvery: 2,
      onSnapshotError: (cause) => errors.push(cause),
    });
    const sequence = registerSequence(restarted);
    expect(sequence.get("proj_snapshot")).toEqual([1, 2, 3, 4, 5]);
    expect(errors).toHaveLength(1);
    snapshots.close();
    events.close();
  });

  it("rejects a validly encoded snapshot anchored to the wrong event", () => {
    const paths = scratch();
    const events = openSqliteEventStore({ path: paths.events });
    const snapshots = openSqliteSnapshotStore({ path: paths.snapshots });
    const writer = createEventBus({ store: events, snapshots, snapshotEvery: 2 });
    registerSequence(writer);
    appendFive(writer);
    const wrong = events.read("proj_snapshot", { afterSeq: 2 })[0] as StoredEvent;
    snapshots.save({
      project: "proj_snapshot",
      throughSeq: 4,
      throughEventId: wrong.id,
      manifest: '[["sequence","1"]]',
      states: { sequence: [1, 2, 3, 4] },
    });

    const errors: unknown[] = [];
    const restarted = createEventBus({
      store: events,
      snapshots,
      snapshotEvery: 2,
      onSnapshotError: (cause) => errors.push(cause),
    });
    expect(registerSequence(restarted).get("proj_snapshot")).toEqual([1, 2, 3, 4, 5]);
    expect(errors).toHaveLength(1);
    snapshots.close();
    events.close();
  });

  it("snapshot load and save failures never hide a durable event", () => {
    const paths = scratch();
    const events = openSqliteEventStore({ path: paths.events });
    const errors: unknown[] = [];
    const broken = {
      load: () => {
        throw new Error("load failed");
      },
      save: () => {
        throw new Error("save failed");
      },
      delete: () => {},
      clear: () => 0,
    };
    const bus = createEventBus({
      store: events,
      snapshots: broken,
      snapshotEvery: 1,
      onSnapshotError: (cause) => errors.push(cause),
    });
    const sequence = registerSequence(bus);
    const notified: number[] = [];
    bus.subscribe((event) => notified.push(event.seq));
    expect(bus.append(projectCreated("one"), { token: "one" }).seq).toBe(1);
    expect(sequence.get("proj_snapshot")).toEqual([1]);
    expect(events.read("proj_snapshot")).toHaveLength(1);
    expect(notified).toEqual([1]);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    events.close();
  });

  it("non-JSON projection state only disables its cache", () => {
    const paths = scratch();
    const events = openSqliteEventStore({ path: paths.events });
    const snapshots = openSqliteSnapshotStore({ path: paths.snapshots });
    const errors: unknown[] = [];
    const bus = createEventBus({
      store: events,
      snapshots,
      snapshotEvery: 1,
      onSnapshotError: (cause) => errors.push(cause),
    });
    const handle = bus.registerReducer(
      "cyclic",
      () => ({ value: 0 }) as { value: number; self?: unknown },
      (_state, event) => {
        const state: { value: number; self?: unknown } = { value: event.seq };
        state.self = state;
        return state;
      },
      {
        version: "1",
        parseState: (value) => value as { value: number; self?: unknown },
      },
    );
    bus.append(projectCreated("one"), { token: "one" });
    expect(handle.get("proj_snapshot").value).toBe(1);
    expect(errors).toHaveLength(1);
    snapshots.close();
    events.close();
  });

  it("detects row tampering before state parsing", () => {
    const paths = scratch();
    const events = openSqliteEventStore({ path: paths.events });
    const snapshots = openSqliteSnapshotStore({ path: paths.snapshots });
    const bus = createEventBus({ store: events, snapshots, snapshotEvery: 1 });
    registerSequence(bus);
    bus.append(projectCreated("one"), { token: "one" });
    snapshots.close();

    const database = new Database(paths.snapshots);
    database
      .prepare("UPDATE projection_snapshots SET state_json = ?")
      .run('{"sequence":[999]}');
    database.close();
    const reopened = openSqliteSnapshotStore({ path: paths.snapshots });
    expect(() => reopened.load("proj_snapshot", '[["sequence","1"]]')).toThrow(
      "checksum mismatch",
    );
    reopened.close();
    events.close();
  });

  it("opens a foreign SQLite file without changing its bytes", () => {
    const paths = scratch();
    const foreign = new Database(paths.snapshots);
    foreign.exec("CREATE TABLE foreign_data(value TEXT)");
    foreign.close();
    chmodSync(paths.snapshots, 0o600);
    const before = readFileSync(paths.snapshots);
    expect(() => openSqliteSnapshotStore({ path: paths.snapshots })).toThrow(
      SnapshotStoreError,
    );
    expect(readFileSync(paths.snapshots)).toEqual(before);
  });
});
