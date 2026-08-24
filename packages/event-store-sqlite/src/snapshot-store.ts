import { createHash } from "node:crypto";
import { chmodSync, existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { eventIdSchema, projectIdSchema } from "@agent-os/event-core";
import type {
  EventId,
  ProjectId,
  ProjectionSnapshot,
  ProjectionSnapshotCache,
} from "@agent-os/event-core";
import Database from "better-sqlite3";

/** ASCII `AOSS`, reserved for discardable Agent OS projection snapshots. */
export const SNAPSHOT_STORE_APPLICATION_ID = 0x414f5353;
export const SNAPSHOT_STORE_FORMAT_VERSION = 1;

const META_SQL = `CREATE TABLE snapshot_store_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  created_at TEXT NOT NULL
) STRICT`;
const SNAPSHOTS_SQL = `CREATE TABLE projection_snapshots (
  project TEXT NOT NULL,
  manifest TEXT NOT NULL CHECK (length(manifest) > 0),
  through_seq INTEGER NOT NULL CHECK (through_seq > 0),
  through_event_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  state_sha256 TEXT NOT NULL CHECK (
    length(state_sha256) = 64 AND state_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project, manifest)
) STRICT, WITHOUT ROWID`;
const SCHEMA_SQL = `${META_SQL};\n\n${SNAPSHOTS_SQL};`;

type SnapshotStoreCode = "CLOSED" | "INTEGRITY" | "INVALID_OPTIONS" | "OPEN_FAILED";

export class SnapshotStoreError extends Error {
  readonly code: SnapshotStoreCode;

  constructor(code: SnapshotStoreCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SnapshotStoreError";
    this.code = code;
  }
}

export type OpenSqliteSnapshotStoreOptions = Readonly<{
  path: string;
  now?: () => Date;
}>;

type SnapshotRow = {
  readonly through_seq: number;
  readonly through_event_id: string;
  readonly state_json: string;
  readonly state_sha256: string;
};

type ObjectRow = {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
};

function normalizeSql(value: string): string {
  return value.replace(/\s+/gu, " ").trim().replace(/;$/u, "");
}

function simplePragma(database: Database.Database, source: string): unknown {
  return database.pragma(source, { simple: true });
}

function exactPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    throw new SnapshotStoreError(
      "INVALID_OPTIONS",
      "snapshot cache path must be absolute",
    );
  }
  if (value.includes("\0")) {
    throw new SnapshotStoreError("INVALID_OPTIONS", "snapshot path contains NUL");
  }
  const path = resolve(value);
  const parent = realpathSync(dirname(path));
  if (!statSync(parent).isDirectory()) {
    throw new SnapshotStoreError("INVALID_OPTIONS", "snapshot parent is not a directory");
  }
  const canonical = resolve(parent, basename(path));
  if (existsSync(canonical)) {
    const file = statSync(canonical);
    if (!file.isFile() || file.nlink !== 1 || realpathSync(canonical) !== canonical) {
      throw new SnapshotStoreError(
        "INVALID_OPTIONS",
        "snapshot cache must be one canonical regular file",
      );
    }
  }
  return canonical;
}

function databaseObjects(database: Database.Database): ObjectRow[] {
  return database
    .prepare<[], ObjectRow>(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all();
}

function verify(database: Database.Database): void {
  if (simplePragma(database, "application_id") !== SNAPSHOT_STORE_APPLICATION_ID) {
    throw new SnapshotStoreError("INTEGRITY", "foreign snapshot application_id");
  }
  if (simplePragma(database, "user_version") !== SNAPSHOT_STORE_FORMAT_VERSION) {
    throw new SnapshotStoreError("INTEGRITY", "unknown snapshot cache format");
  }
  const expected = new Map([
    ["table:projection_snapshots:projection_snapshots", normalizeSql(SNAPSHOTS_SQL)],
    ["table:snapshot_store_meta:snapshot_store_meta", normalizeSql(META_SQL)],
  ]);
  const objects = databaseObjects(database);
  if (
    JSON.stringify(objects.map((row) => `${row.type}:${row.name}:${row.tbl_name}`)) !==
    JSON.stringify([...expected.keys()])
  ) {
    throw new SnapshotStoreError("INTEGRITY", "unexpected snapshot cache objects");
  }
  for (const row of objects) {
    const key = `${row.type}:${row.name}:${row.tbl_name}`;
    if (row.sql === null || normalizeSql(row.sql) !== expected.get(key)) {
      throw new SnapshotStoreError(
        "INTEGRITY",
        `snapshot object ${row.name} has unexpected DDL`,
      );
    }
  }
  if (simplePragma(database, "integrity_check") !== "ok") {
    throw new SnapshotStoreError("INTEGRITY", "snapshot integrity_check failed");
  }
  const meta = database
    .prepare<[], { singleton: number; format_version: number; created_at: string }>(
      "SELECT singleton, format_version, created_at FROM snapshot_store_meta",
    )
    .all();
  if (
    meta.length !== 1 ||
    meta[0]?.singleton !== 1 ||
    meta[0].format_version !== SNAPSHOT_STORE_FORMAT_VERSION ||
    !Number.isFinite(Date.parse(meta[0].created_at))
  ) {
    throw new SnapshotStoreError("INTEGRITY", "invalid snapshot metadata row");
  }
}

function configure(database: Database.Database): void {
  database.pragma("busy_timeout = 5000");
  database.pragma("trusted_schema = OFF");
  if (simplePragma(database, "journal_mode = WAL") !== "wal") {
    throw new SnapshotStoreError("OPEN_FAILED", "snapshot cache refused WAL mode");
  }
  database.pragma("synchronous = FULL");
  if (simplePragma(database, "synchronous") !== 2) {
    throw new SnapshotStoreError(
      "OPEN_FAILED",
      "snapshot cache refused synchronous=FULL",
    );
  }
  if (simplePragma(database, "trusted_schema") !== 0) {
    throw new SnapshotStoreError(
      "OPEN_FAILED",
      "snapshot cache refused trusted_schema=OFF",
    );
  }
}

function parseProject(value: unknown): ProjectId {
  const result = projectIdSchema.safeParse(value);
  if (!result.success) {
    throw new SnapshotStoreError("INVALID_OPTIONS", "invalid snapshot project", {
      cause: result.error,
    });
  }
  return result.data;
}

function parseManifest(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 4096
  ) {
    throw new SnapshotStoreError(
      "INVALID_OPTIONS",
      "snapshot manifest must be 1-4096 UTF-8 bytes",
    );
  }
  return value;
}

function parseSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new SnapshotStoreError(
      "INVALID_OPTIONS",
      "snapshot sequence must be a positive safe integer",
    );
  }
  return value as number;
}

function normalizeJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SnapshotStoreError("INVALID_OPTIONS", "snapshot state is not JSON");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new SnapshotStoreError("INVALID_OPTIONS", "snapshot state is not JSON");
  }
  if (seen.has(value)) {
    throw new SnapshotStoreError("INVALID_OPTIONS", "snapshot state contains a cycle");
  }
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, seen));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SnapshotStoreError(
      "INVALID_OPTIONS",
      "snapshot state must contain only plain objects",
    );
  }
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalizeJson((value as Record<string, unknown>)[key], seen);
  }
  return normalized;
}

export class SqliteSnapshotStore implements ProjectionSnapshotCache {
  readonly path: string;
  readonly #database: Database.Database;
  readonly #now: () => Date;
  readonly #load: Database.Statement<[string, string], SnapshotRow>;
  #closed = false;

  constructor(options: OpenSqliteSnapshotStoreOptions) {
    if (options === null || typeof options !== "object") {
      throw new SnapshotStoreError("INVALID_OPTIONS", "snapshot options are required");
    }
    const path = exactPath(options.path);
    if (existsSync(path) && statSync(path).size > 0) {
      const readonly = new Database(path, { readonly: true, fileMustExist: true });
      try {
        verify(readonly);
      } finally {
        readonly.close();
      }
    }
    let database: Database.Database | null = null;
    try {
      database = new Database(path);
      const empty =
        simplePragma(database, "application_id") === 0 &&
        simplePragma(database, "user_version") === 0 &&
        databaseObjects(database).length === 0;
      if (empty) {
        database
          .transaction(() => {
            database?.exec(SCHEMA_SQL);
            database?.pragma(`application_id = ${SNAPSHOT_STORE_APPLICATION_ID}`);
            database?.pragma(`user_version = ${SNAPSHOT_STORE_FORMAT_VERSION}`);
            database
              ?.prepare(
                "INSERT INTO snapshot_store_meta(singleton, format_version, created_at) VALUES (1, ?, ?)",
              )
              .run(
                SNAPSHOT_STORE_FORMAT_VERSION,
                (options.now ?? (() => new Date()))().toISOString(),
              );
          })
          .exclusive();
      }
      verify(database);
      configure(database);
      chmodSync(path, 0o600);
    } catch (cause) {
      database?.close();
      if (cause instanceof SnapshotStoreError) throw cause;
      throw new SnapshotStoreError("OPEN_FAILED", "cannot open snapshot cache", {
        cause,
      });
    }
    if (database === null) {
      throw new SnapshotStoreError("OPEN_FAILED", "SQLite returned no snapshot cache");
    }
    this.path = path;
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#load = database.prepare<[string, string], SnapshotRow>(
      `SELECT through_seq, through_event_id, state_json, state_sha256
       FROM projection_snapshots
       WHERE project = ? AND manifest = ?`,
    );
  }

  load(project: ProjectId, manifest: string): ProjectionSnapshot | null {
    this.#assertOpen();
    const admittedProject = parseProject(project);
    const admittedManifest = parseManifest(manifest);
    const row = this.#load.get(admittedProject, admittedManifest);
    if (row === undefined) return null;
    const digest = createHash("sha256").update(row.state_json).digest("hex");
    if (digest !== row.state_sha256) {
      throw new SnapshotStoreError("INTEGRITY", "snapshot state checksum mismatch");
    }
    let states: unknown;
    try {
      states = JSON.parse(row.state_json);
    } catch (cause) {
      throw new SnapshotStoreError("INTEGRITY", "snapshot state JSON is invalid", {
        cause,
      });
    }
    const eventId = eventIdSchema.safeParse(row.through_event_id);
    if (!eventId.success) {
      throw new SnapshotStoreError("INTEGRITY", "snapshot event anchor is invalid", {
        cause: eventId.error,
      });
    }
    return Object.freeze({
      project: admittedProject,
      throughSeq: parseSequence(row.through_seq),
      throughEventId: eventId.data,
      manifest: admittedManifest,
      states: states as Readonly<Record<string, unknown>>,
    });
  }

  save(snapshot: ProjectionSnapshot): void {
    this.#assertOpen();
    if (snapshot === null || typeof snapshot !== "object") {
      throw new SnapshotStoreError("INVALID_OPTIONS", "snapshot is required");
    }
    const project = parseProject(snapshot.project);
    const manifest = parseManifest(snapshot.manifest);
    const throughSeq = parseSequence(snapshot.throughSeq);
    const eventId = eventIdSchema.safeParse(snapshot.throughEventId);
    if (!eventId.success) {
      throw new SnapshotStoreError("INVALID_OPTIONS", "invalid snapshot event anchor", {
        cause: eventId.error,
      });
    }
    const stateJson = JSON.stringify(normalizeJson(snapshot.states));
    const digest = createHash("sha256").update(stateJson).digest("hex");
    this.#database
      .prepare(
        `INSERT INTO projection_snapshots(
           project, manifest, through_seq, through_event_id,
           state_json, state_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project, manifest) DO UPDATE SET
           through_seq = excluded.through_seq,
           through_event_id = excluded.through_event_id,
           state_json = excluded.state_json,
           state_sha256 = excluded.state_sha256,
           created_at = excluded.created_at
         WHERE excluded.through_seq >= projection_snapshots.through_seq`,
      )
      .run(
        project,
        manifest,
        throughSeq,
        eventId.data,
        stateJson,
        digest,
        this.#now().toISOString(),
      );
  }

  delete(project: ProjectId, manifest: string): void {
    this.#assertOpen();
    this.#database
      .prepare("DELETE FROM projection_snapshots WHERE project = ? AND manifest = ?")
      .run(parseProject(project), parseManifest(manifest));
  }

  clear(project?: ProjectId): number {
    this.#assertOpen();
    const result =
      project === undefined
        ? this.#database.prepare("DELETE FROM projection_snapshots").run()
        : this.#database
            .prepare("DELETE FROM projection_snapshots WHERE project = ?")
            .run(parseProject(project));
    return result.changes;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new SnapshotStoreError("CLOSED", "snapshot cache is closed");
  }
}

export function openSqliteSnapshotStore(
  options: OpenSqliteSnapshotStoreOptions,
): SqliteSnapshotStore {
  return new SqliteSnapshotStore(options);
}
