import { spawn } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const requireFromAdapter = createRequire(
  new URL("../packages/event-store-sqlite/package.json", import.meta.url),
);
const Database = requireFromAdapter("better-sqlite3") as typeof BetterSqlite3;
import {
  EVENT_SCHEMA_VERSION,
  parseEventInput,
} from "../packages/event-core/src/index.js";
import type { EventId, EventInput } from "../packages/event-core/src/index.js";
import {
  BackupInProgressError,
  EVENT_STORE_APPLICATION_ID,
  EVENT_STORE_FORMAT_VERSION,
  EventStoreAppendError,
  EventStoreClosedError,
  EventStoreIntegrityError,
  IdempotencyConflictError,
  SqliteEventStoreError,
  openSqliteEventStore,
} from "../packages/event-store-sqlite/src/index.js";

const FIXED_AT = new Date("2026-08-24T02:40:00.000Z");
const EVENT_ID_A = "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV" as EventId;
const EVENT_ID_B = "evt_01ARZ3NDEKTSV4RRFFQ69G5FAW" as EventId;
const STORE_MODULE_URL = new URL(
  "../packages/event-store-sqlite/dist/index.js",
  import.meta.url,
).href;

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-os-event-store-")));
  scratchRoots.push(root);
  return { root, path: join(root, "events.sqlite") };
}

function projectCreated(
  project = "proj_alpha",
  name = "Alpha",
): EventInput<"project.created"> {
  return parseEventInput({
    type: "project.created",
    project,
    actor: { kind: "system", id: "runtime" },
    subject: { kind: "project", id: project },
    payload: { name, stack: ["TypeScript", "SQLite"] },
  }) as EventInput<"project.created">;
}

function scalar(database: BetterSqlite3.Database, pragma: string): unknown {
  return database.pragma(pragma, { simple: true });
}

function childScript(body: string): string {
  return `
    import { openSqliteEventStore } from ${JSON.stringify(STORE_MODULE_URL)};
    ${body}
  `;
}

function runChild(
  script: string,
  environment: Record<string, string>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, output }));
  });
}

describe("RM-1.1b · SQLite append-only event store", () => {
  it("initializes one identified STRICT WAL database with guarded event rows", () => {
    const target = scratch();
    const store = openSqliteEventStore({ path: target.path, now: () => FIXED_AT });

    expect(store.path).toBe(target.path);
    expect(statSync(target.path).mode & 0o777).toBe(0o600);

    const database = new Database(target.path, { readonly: true, fileMustExist: true });
    try {
      expect(scalar(database, "application_id")).toBe(EVENT_STORE_APPLICATION_ID);
      expect(scalar(database, "user_version")).toBe(EVENT_STORE_FORMAT_VERSION);
      expect(scalar(database, "journal_mode")).toBe("wal");
      const objects = database
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      expect(objects).toEqual([
        "event_store_meta",
        "events",
        "events_no_delete",
        "events_no_update",
        "project_sequences",
      ]);
    } finally {
      database.close();
      store.close();
    }
  });

  it("allocates project-local sequences and retries one token without regenerating runtime fields", () => {
    const target = scratch();
    let idCalls = 0;
    const store = openSqliteEventStore({
      path: target.path,
      idFactory: () => {
        idCalls += 1;
        return EVENT_ID_A;
      },
      now: () => FIXED_AT,
    });
    const input = projectCreated();

    const first = store.append(input, { token: "create-project" });
    const reordered = {
      payload: { stack: ["TypeScript", "SQLite"], name: "Alpha" },
      subject: { id: "proj_alpha", kind: "project" },
      actor: { id: "runtime", kind: "system" },
      project: "proj_alpha",
      type: "project.created",
    } as unknown as EventInput<"project.created">;
    const retry = store.append(reordered, { token: "create-project" });

    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: EVENT_ID_A,
      seq: 1,
      at: FIXED_AT.toISOString(),
    });
    expect(idCalls).toBe(1);
    store.close();
  });

  it("rejects a conflicting project token without consuming a sequence", () => {
    const target = scratch();
    const ids = [EVENT_ID_A, EVENT_ID_B];
    const store = openSqliteEventStore({
      path: target.path,
      idFactory: () => ids.shift() as EventId,
      now: () => FIXED_AT,
    });
    store.append(projectCreated(), { token: "command-1" });

    expect(() =>
      store.append(projectCreated("proj_alpha", "Different"), { token: "command-1" }),
    ).toThrow(IdempotencyConflictError);
    expect(
      store.append(projectCreated("proj_alpha", "Second"), { token: "command-2" }),
    ).toMatchObject({ seq: 2, id: EVENT_ID_B });
    store.close();
  });

  it("scopes tokens and sequences by project while keeping event ids globally unique", () => {
    const target = scratch();
    const store = openSqliteEventStore({ path: target.path, now: () => FIXED_AT });
    const alpha = store.append(projectCreated("proj_alpha", "Alpha"), {
      token: "same-token",
    });
    const beta = store.append(projectCreated("proj_beta", "Beta"), {
      token: "same-token",
    });

    expect(alpha.seq).toBe(1);
    expect(beta.seq).toBe(1);
    expect(alpha.id).not.toBe(beta.id);
    store.close();
  });

  it("atomically appends and idempotently replays one same-project event group", () => {
    const target = scratch();
    const store = openSqliteEventStore({ path: target.path, now: () => FIXED_AT });
    const group = [
      { input: projectCreated("proj_group", "One"), options: { token: "group:1" } },
      { input: projectCreated("proj_group", "Two"), options: { token: "group:2" } },
    ];
    const first = store.appendGroup(group);
    const retry = store.appendGroup(group);

    expect(first.map((event) => event.seq)).toEqual([1, 2]);
    expect(retry).toEqual(first);
    expect(store.read("proj_group" as never)).toEqual(first);
    store.close();
  });

  it("rejects partial group retries without appending the new members", () => {
    const target = scratch();
    const store = openSqliteEventStore({ path: target.path, now: () => FIXED_AT });
    const existing = {
      input: projectCreated("proj_group", "One"),
      options: { token: "partial:1" },
    };
    store.append(existing.input, existing.options);

    expect(() =>
      store.appendGroup([
        existing,
        {
          input: projectCreated("proj_group", "Two"),
          options: { token: "partial:2" },
        },
      ]),
    ).toThrow(IdempotencyConflictError);
    expect(store.read("proj_group" as never)).toHaveLength(1);
    store.close();
  });

  it("persists idempotency across reopen and rejects non-canonical tokens", () => {
    const target = scratch();
    const firstStore = openSqliteEventStore({ path: target.path, now: () => FIXED_AT });
    const original = firstStore.append(projectCreated(), { token: "durable-command" });
    firstStore.close();

    const reopened = openSqliteEventStore({ path: target.path, now: () => FIXED_AT });
    expect(reopened.append(projectCreated(), { token: "durable-command" })).toEqual(
      original,
    );
    for (const token of ["", " padded", "line\nbreak", "x".repeat(257)]) {
      expect(() => reopened.append(projectCreated(), { token })).toThrow(
        SqliteEventStoreError,
      );
    }
    reopened.close();
  });

  it("fails closed on a foreign database without changing its bytes", () => {
    const target = scratch();
    const foreign = new Database(target.path);
    foreign.exec("CREATE TABLE foreign_truth(id INTEGER PRIMARY KEY, value TEXT)");
    foreign.prepare("INSERT INTO foreign_truth(value) VALUES (?)").run("keep-me");
    foreign.close();
    const before = readFileSync(target.path);

    expect(() => openSqliteEventStore({ path: target.path })).toThrow(
      EventStoreIntegrityError,
    );
    expect(readFileSync(target.path)).toEqual(before);
  });

  it("mechanically rejects UPDATE, DELETE and INSERT OR REPLACE", () => {
    const target = scratch();
    const store = openSqliteEventStore({ path: target.path, now: () => FIXED_AT });
    store.append(projectCreated(), { token: "immutable" });
    store.close();

    const database = new Database(target.path);
    database.pragma("recursive_triggers = ON");
    try {
      expect(() => database.exec("UPDATE events SET event_json = event_json")).toThrow(
        /append-only/,
      );
      expect(() => database.exec("DELETE FROM events")).toThrow(/append-only/);
      expect(() =>
        database.exec("INSERT OR REPLACE INTO events SELECT * FROM events"),
      ).toThrow(/append-only/);
      expect(
        database
          .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM events")
          .get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("rejects a same-name trigger whose DDL was replaced", () => {
    const target = scratch();
    const store = openSqliteEventStore({ path: target.path });
    store.close();

    const database = new Database(target.path);
    database.exec(`
      DROP TRIGGER events_no_update;
      CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT 1; END;
    `);
    database.close();

    expect(() => openSqliteEventStore({ path: target.path })).toThrow(
      EventStoreIntegrityError,
    );
  });

  it("keeps one gap-free sequence across two live connections", () => {
    const target = scratch();
    const first = openSqliteEventStore({ path: target.path, now: () => FIXED_AT });
    const second = openSqliteEventStore({ path: target.path, now: () => FIXED_AT });
    for (let index = 0; index < 40; index += 1) {
      const store = index % 2 === 0 ? first : second;
      expect(
        store.append(projectCreated("proj_parallel", `Project ${index}`), {
          token: `parallel-${index}`,
        }).seq,
      ).toBe(index + 1);
    }
    first.close();
    second.close();

    const database = new Database(target.path, { readonly: true });
    try {
      const sequences = database
        .prepare<[], { seq: number }>(
          "SELECT seq FROM events WHERE project = 'proj_parallel' ORDER BY seq",
        )
        .all()
        .map((row) => row.seq);
      expect(sequences).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    } finally {
      database.close();
    }
  });

  it("keeps one gap-free sequence across four real writer processes", async () => {
    const target = scratch();
    const script = childScript(`
        const store = openSqliteEventStore({ path: process.env.TEST_DB_PATH, busyTimeoutMs: 30000 });
        const worker = process.env.TEST_WORKER;
        for (let index = 0; index < 25; index += 1) {
          store.append({
            type: "project.created",
            project: "proj_multiprocess",
            actor: { kind: "system", id: "runtime" },
            subject: { kind: "project", id: "proj_multiprocess" },
            payload: { name: \`Worker \${worker} event \${index}\`, stack: ["SQLite"] },
          }, { token: \`worker-\${worker}-\${index}\` });
        }
        store.close();
      `);
    const children = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        runChild(script, {
          TEST_DB_PATH: target.path,
          TEST_WORKER: String(index),
        }),
      ),
    );
    expect(children).toEqual(children.map(() => ({ code: 0, signal: null, output: "" })));

    const database = new Database(target.path, { readonly: true });
    try {
      const sequences = database
        .prepare<[], { seq: number }>(
          "SELECT seq FROM events WHERE project = 'proj_multiprocess' ORDER BY seq",
        )
        .all()
        .map((row) => row.seq);
      expect(sequences).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    } finally {
      database.close();
    }
  }, 15_000);

  it("linearizes one token across competing processes", async () => {
    const target = scratch();
    const script = childScript(`
        const store = openSqliteEventStore({ path: process.env.TEST_DB_PATH, busyTimeoutMs: 30000 });
        const event = store.append({
          type: "project.created",
          project: "proj_same_token",
          actor: { kind: "system", id: "runtime" },
          subject: { kind: "project", id: "proj_same_token" },
          payload: { name: "One command", stack: ["SQLite"] },
        }, { token: "same-command" });
        process.stdout.write(JSON.stringify({ id: event.id, seq: event.seq }));
        store.close();
      `);
    const children = await Promise.all(
      Array.from({ length: 6 }, () => runChild(script, { TEST_DB_PATH: target.path })),
    );
    expect(children.every((child) => child.code === 0 && child.signal === null)).toBe(
      true,
    );
    const results = children.map((child) => JSON.parse(child.output));
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.every((result) => result.seq === 1)).toBe(true);

    const database = new Database(target.path, { readonly: true });
    try {
      expect(
        database
          .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM events")
          .get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  }, 15_000);

  it("rolls back a process killed after sequence allocation and before insert", async () => {
    const target = scratch();
    const killed = await runChild(
      childScript(`
          const store = openSqliteEventStore({
            path: process.env.TEST_DB_PATH,
            idFactory: () => {
              process.kill(process.pid, "SIGKILL");
              return "${EVENT_ID_A}";
            },
          });
          store.append({
            type: "project.created",
            project: "proj_kill_before_insert",
            actor: { kind: "system", id: "runtime" },
            subject: { kind: "project", id: "proj_kill_before_insert" },
            payload: { name: "Killed", stack: ["SQLite"] },
          }, { token: "killed-command" });
        `),
      { TEST_DB_PATH: target.path },
    );
    expect(killed.signal).toBe("SIGKILL");

    const store = openSqliteEventStore({ path: target.path, now: () => FIXED_AT });
    expect(
      store.append(projectCreated("proj_kill_before_insert", "Recovered"), {
        token: "recovered-command",
      }).seq,
    ).toBe(1);
    store.close();
  }, 15_000);

  it("returns the committed event when the first caller dies before observing its result", async () => {
    const target = scratch();
    const killed = await runChild(
      childScript(`
          const store = openSqliteEventStore({ path: process.env.TEST_DB_PATH });
          store.append({
            type: "project.created",
            project: "proj_ambiguous_ack",
            actor: { kind: "system", id: "runtime" },
            subject: { kind: "project", id: "proj_ambiguous_ack" },
            payload: { name: "Committed", stack: ["TypeScript", "SQLite"] },
          }, { token: "ambiguous-command" });
          process.kill(process.pid, "SIGKILL");
        `),
      { TEST_DB_PATH: target.path },
    );
    expect(killed.signal).toBe("SIGKILL");

    const store = openSqliteEventStore({ path: target.path });
    const retried = store.append(projectCreated("proj_ambiguous_ack", "Committed"), {
      token: "ambiguous-command",
    });
    expect(retried.seq).toBe(1);
    store.close();

    const database = new Database(target.path, { readonly: true });
    try {
      expect(
        database
          .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM events")
          .get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  }, 15_000);

  it("rolls back sequence allocation when the global id uniqueness check fails", () => {
    const target = scratch();
    const ids = [EVENT_ID_A, EVENT_ID_A, EVENT_ID_B];
    const store = openSqliteEventStore({
      path: target.path,
      idFactory: () => ids.shift() as EventId,
      now: () => FIXED_AT,
    });
    store.append(projectCreated("proj_collision", "One"), { token: "one" });
    expect(() =>
      store.append(projectCreated("proj_collision", "Two"), { token: "two" }),
    ).toThrow(EventStoreAppendError);
    expect(
      store.append(projectCreated("proj_collision", "Three"), { token: "three" }),
    ).toMatchObject({ seq: 2, id: EVENT_ID_B });
    store.close();
  });

  it("publishes a verified online backup without replacing existing evidence", async () => {
    const target = scratch();
    const backupPath = join(target.root, "backup.sqlite");
    const otherBackup = join(target.root, "other.sqlite");
    const store = openSqliteEventStore({ path: target.path, now: () => FIXED_AT });
    const original = store.append(projectCreated(), { token: "backed-up" });
    store.append(projectCreated("proj_beta", "Beta"), { token: "beta" });

    const running = store.backup(backupPath);
    await expect(store.backup(otherBackup)).rejects.toBeInstanceOf(BackupInProgressError);
    expect(() => store.close()).toThrow(BackupInProgressError);
    const evidence = await running;
    expect(evidence).toMatchObject({
      path: backupPath,
      eventCount: 2,
      projectCount: 2,
    });
    expect(evidence.totalPages).toBeGreaterThan(0);
    expect(readdirSync(target.root).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    store.append(projectCreated("proj_alpha", "After backup"), { token: "after" });
    store.close();
    const restored = openSqliteEventStore({ path: backupPath, now: () => FIXED_AT });
    expect(restored.append(projectCreated(), { token: "backed-up" })).toEqual(original);
    restored.close();

    const reopenedSource = openSqliteEventStore({ path: target.path });
    await expect(reopenedSource.backup(backupPath)).rejects.toBeInstanceOf(
      SqliteEventStoreError,
    );
    reopenedSource.close();
  });

  it("makes close idempotent and rejects all later writes", () => {
    const target = scratch();
    const store = openSqliteEventStore({ path: target.path });
    store.close();
    store.close();
    expect(store.closed).toBe(true);
    expect(() => store.append(projectCreated(), { token: "after-close" })).toThrow(
      EventStoreClosedError,
    );
  });
});
