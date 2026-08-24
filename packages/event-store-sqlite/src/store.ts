import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  EVENT_SCHEMA_VERSION,
  createEventDraft,
  newEventId,
  parseEventInput,
  parseStoredEvent,
  projectIdSchema,
} from "@agent-os/event-core";
import type {
  EventAppendInput,
  EventId,
  EventInput,
  EventType,
  ProjectId,
  StoredEvent,
} from "@agent-os/event-core";
import Database from "better-sqlite3";

/** ASCII `AOSE`, reserved for the Agent OS event-store file format. */
export const EVENT_STORE_APPLICATION_ID = 0x414f5345;
export const EVENT_STORE_FORMAT_VERSION = 1;

const MAX_CLIENT_TOKEN_BYTES = 256;
const MAX_SAFE_SEQUENCE = Number.MAX_SAFE_INTEGER;
const META_TABLE_SQL = `CREATE TABLE event_store_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  created_at TEXT NOT NULL
) STRICT`;
const SEQUENCE_TABLE_SQL = `CREATE TABLE project_sequences (
  project TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL CHECK (last_seq > 0 AND last_seq <= ${MAX_SAFE_SEQUENCE})
) STRICT, WITHOUT ROWID`;
const EVENTS_TABLE_SQL = `CREATE TABLE events (
  project TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0 AND seq <= ${MAX_SAFE_SEQUENCE}),
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = ${EVENT_SCHEMA_VERSION}),
  client_token TEXT NOT NULL CHECK (length(client_token) > 0),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  input_sha256 TEXT NOT NULL CHECK (
    length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  PRIMARY KEY (project, seq),
  UNIQUE (project, client_token)
) STRICT, WITHOUT ROWID`;
const NO_UPDATE_TRIGGER_SQL = `CREATE TRIGGER events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END`;
const NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END`;

const SCHEMA_STATEMENTS = Object.freeze([
  META_TABLE_SQL,
  SEQUENCE_TABLE_SQL,
  EVENTS_TABLE_SQL,
  NO_UPDATE_TRIGGER_SQL,
  NO_DELETE_TRIGGER_SQL,
]);
const SCHEMA_SQL = `${SCHEMA_STATEMENTS.join(";\n\n")};`;

function normalizeSchemaSql(value: string): string {
  return value.replace(/\s+/gu, " ").trim().replace(/;$/u, "");
}

const EXPECTED_OBJECT_SQL = new Map([
  ["table:event_store_meta:event_store_meta", normalizeSchemaSql(META_TABLE_SQL)],
  ["table:events:events", normalizeSchemaSql(EVENTS_TABLE_SQL)],
  ["table:project_sequences:project_sequences", normalizeSchemaSql(SEQUENCE_TABLE_SQL)],
  ["trigger:events_no_delete:events", normalizeSchemaSql(NO_DELETE_TRIGGER_SQL)],
  ["trigger:events_no_update:events", normalizeSchemaSql(NO_UPDATE_TRIGGER_SQL)],
]);

type SqliteCode =
  | "CLOSED"
  | "CONFLICT"
  | "INTEGRITY"
  | "INVALID_OPTIONS"
  | "OPEN_FAILED"
  | "APPEND_FAILED"
  | "BACKUP_FAILED"
  | "BACKUP_IN_PROGRESS";

export class SqliteEventStoreError extends Error {
  readonly code: SqliteCode;

  constructor(code: SqliteCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SqliteEventStoreError";
    this.code = code;
  }
}

export class EventStoreOpenError extends SqliteEventStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("OPEN_FAILED", message, options);
    this.name = "EventStoreOpenError";
  }
}

export class EventStoreIntegrityError extends SqliteEventStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("INTEGRITY", message, options);
    this.name = "EventStoreIntegrityError";
  }
}

export class EventStoreClosedError extends SqliteEventStoreError {
  constructor() {
    super("CLOSED", "SQLite event store is closed");
    this.name = "EventStoreClosedError";
  }
}

function sqliteErrorCode(cause: unknown): string | null {
  if (cause === null || typeof cause !== "object" || !("code" in cause)) return null;
  return typeof cause.code === "string" ? cause.code : null;
}

function retryableSqliteError(cause: unknown): boolean {
  const code = sqliteErrorCode(cause);
  return (
    code?.startsWith("SQLITE_BUSY") === true || code?.startsWith("SQLITE_LOCKED") === true
  );
}

export class EventStoreAppendError extends SqliteEventStoreError {
  readonly retryable: boolean;

  constructor(cause: unknown) {
    super("APPEND_FAILED", "SQLite event append failed", { cause });
    this.name = "EventStoreAppendError";
    this.retryable = retryableSqliteError(cause);
  }
}

export class EventStoreBackupError extends SqliteEventStoreError {
  readonly retryable: boolean;

  constructor(cause: unknown) {
    super("BACKUP_FAILED", "SQLite event-store backup failed", { cause });
    this.name = "EventStoreBackupError";
    this.retryable = retryableSqliteError(cause);
  }
}

export class BackupInProgressError extends SqliteEventStoreError {
  constructor() {
    super("BACKUP_IN_PROGRESS", "SQLite event store backup is already running");
    this.name = "BackupInProgressError";
  }
}

export class IdempotencyConflictError extends SqliteEventStoreError {
  readonly project: ProjectId;

  constructor(project: ProjectId) {
    super(
      "CONFLICT",
      `idempotency token already represents another command in ${project}`,
    );
    this.name = "IdempotencyConflictError";
    this.project = project;
  }
}

export type OpenSqliteEventStoreOptions = Readonly<{
  path: string;
  busyTimeoutMs?: number;
  idFactory?: () => EventId;
  now?: () => Date;
}>;

export type SqliteEventStoreAppendOptions = Readonly<{ token: string }>;
export type ReadEventsOptions = Readonly<{ afterSeq?: number }>;

export type BackupEvidence = Readonly<{
  path: string;
  eventCount: number;
  projectCount: number;
  totalPages: number;
}>;

type ExistingEventRow = {
  readonly project: string;
  readonly seq: number;
  readonly id: string;
  readonly schema_version: number;
  readonly input_json: string;
  readonly input_sha256: string;
  readonly event_json: string;
};
type SequenceRow = { readonly seq: number };
type CountRow = { readonly count: number };
type ReadEventRow = { readonly seq: number; readonly event_json: string };
type ObjectRow = {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
};
type MetaRow = {
  readonly singleton: number;
  readonly format_version: number;
  readonly created_at: string;
};

function simplePragma(database: Database.Database, source: string): unknown {
  return database.pragma(source, { simple: true });
}

function integerPragma(database: Database.Database, source: string): number {
  const value = simplePragma(database, source);
  if (!Number.isSafeInteger(value)) {
    throw new EventStoreIntegrityError(`PRAGMA ${source} did not return a safe integer`);
  }
  return value as number;
}

const SQLITE_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function isRetryableSqliteLock(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false;
  const code = (cause as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    (code === "SQLITE_LOCKED" || code.startsWith("SQLITE_BUSY"))
  );
}

function withBusyRetry<T>(timeoutMs: number, operation: () => T): T {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 1;
  for (;;) {
    try {
      return operation();
    } catch (cause) {
      const remaining = deadline - Date.now();
      if (!isRetryableSqliteLock(cause) || remaining <= 0) throw cause;
      Atomics.wait(SQLITE_RETRY_SIGNAL, 0, 0, Math.min(delayMs, remaining));
      delayMs = Math.min(delayMs * 2, 25);
    }
  }
}

function assertSafeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new EventStoreIntegrityError(`${label} is not a non-negative safe integer`);
  }
  return value as number;
}

function parseAfterSequence(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SqliteEventStoreError(
      "INVALID_OPTIONS",
      "afterSeq must be a non-negative safe integer",
    );
  }
  return value as number;
}

function exactColumns(
  database: Database.Database,
  table: string,
  expected: string[],
): void {
  const rows = database
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
  if (JSON.stringify(rows) !== JSON.stringify(expected)) {
    throw new EventStoreIntegrityError(`unexpected ${table} column contract`);
  }
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

function isEmptyDatabase(database: Database.Database): boolean {
  return (
    integerPragma(database, "application_id") === 0 &&
    integerPragma(database, "user_version") === 0 &&
    databaseObjects(database).length === 0
  );
}

function verifyOwnedDatabase(database: Database.Database): void {
  if (integerPragma(database, "application_id") !== EVENT_STORE_APPLICATION_ID) {
    throw new EventStoreIntegrityError("foreign SQLite application_id");
  }
  if (integerPragma(database, "user_version") !== EVENT_STORE_FORMAT_VERSION) {
    throw new EventStoreIntegrityError("unknown SQLite event-store format version");
  }

  const objects = databaseObjects(database);
  const objectKeys = objects.map((row) => `${row.type}:${row.name}:${row.tbl_name}`);
  if (JSON.stringify(objectKeys) !== JSON.stringify([...EXPECTED_OBJECT_SQL.keys()])) {
    throw new EventStoreIntegrityError(
      "unexpected or incomplete SQLite event-store objects",
    );
  }
  for (const row of objects) {
    const key = `${row.type}:${row.name}:${row.tbl_name}`;
    const expected = EXPECTED_OBJECT_SQL.get(key);
    if (row.sql === null || normalizeSchemaSql(row.sql) !== expected) {
      throw new EventStoreIntegrityError(`SQLite object ${row.name} has unexpected DDL`);
    }
  }
  exactColumns(database, "event_store_meta", [
    "singleton",
    "format_version",
    "created_at",
  ]);
  exactColumns(database, "project_sequences", ["project", "last_seq"]);
  exactColumns(database, "events", [
    "project",
    "seq",
    "id",
    "schema_version",
    "client_token",
    "input_json",
    "input_sha256",
    "event_json",
  ]);

  const meta = database
    .prepare<[], MetaRow>(
      "SELECT singleton, format_version, created_at FROM event_store_meta",
    )
    .all();
  if (
    meta.length !== 1 ||
    meta[0]?.singleton !== 1 ||
    meta[0].format_version !== EVENT_STORE_FORMAT_VERSION ||
    !Number.isFinite(Date.parse(meta[0].created_at))
  ) {
    throw new EventStoreIntegrityError("invalid SQLite event-store metadata row");
  }

  if (simplePragma(database, "integrity_check") !== "ok") {
    throw new EventStoreIntegrityError("SQLite integrity_check failed");
  }

  const brokenSequence = database
    .prepare<[], { project: string }>(
      `WITH actual AS (
         SELECT project, COUNT(*) AS event_count, MIN(seq) AS min_seq, MAX(seq) AS max_seq
         FROM events
         GROUP BY project
       )
       SELECT sequences.project
       FROM project_sequences AS sequences
       LEFT JOIN actual ON actual.project = sequences.project
       WHERE actual.project IS NULL
          OR actual.min_seq <> 1
          OR actual.max_seq <> actual.event_count
          OR sequences.last_seq <> actual.max_seq
       UNION ALL
       SELECT actual.project
       FROM actual
       LEFT JOIN project_sequences AS sequences ON sequences.project = actual.project
       WHERE sequences.project IS NULL
       LIMIT 1`,
    )
    .get();
  if (brokenSequence) {
    throw new EventStoreIntegrityError("project sequence ledger is inconsistent");
  }

  const rows = database
    .prepare<[], ExistingEventRow>(
      `SELECT project, seq, id, schema_version, input_json, input_sha256, event_json
       FROM events
       ORDER BY project, seq`,
    )
    .iterate();
  for (const row of rows) {
    let parsedInput: EventInput;
    let parsedEvent: StoredEvent;
    try {
      parsedInput = parseEventInput(JSON.parse(row.input_json));
      parsedEvent = parseStoredEvent(JSON.parse(row.event_json));
    } catch (cause) {
      throw new EventStoreIntegrityError("stored event or idempotency input is invalid", {
        cause,
      });
    }
    const canonicalInput = JSON.stringify(parsedInput);
    const digest = createHash("sha256").update(canonicalInput).digest("hex");
    if (
      canonicalInput !== row.input_json ||
      digest !== row.input_sha256 ||
      parsedEvent.project !== row.project ||
      parsedEvent.seq !== row.seq ||
      parsedEvent.id !== row.id ||
      parsedEvent.schemaVersion !== row.schema_version
    ) {
      throw new EventStoreIntegrityError("stored event columns disagree with their JSON");
    }
  }
}

function configureConnection(database: Database.Database, busyTimeoutMs: number): void {
  database.pragma(`busy_timeout = ${busyTimeoutMs}`);
  database.pragma("foreign_keys = ON");
  database.pragma("trusted_schema = OFF");
  database.pragma("recursive_triggers = ON");
  const journalMode = withBusyRetry(busyTimeoutMs, () =>
    simplePragma(database, "journal_mode = WAL"),
  );
  if (journalMode !== "wal") {
    throw new EventStoreOpenError("SQLite refused WAL journal mode");
  }
  database.pragma("synchronous = FULL");
  if (integerPragma(database, "synchronous") !== 2) {
    throw new EventStoreOpenError("SQLite refused synchronous=FULL");
  }
  if (integerPragma(database, "foreign_keys") !== 1) {
    throw new EventStoreOpenError("SQLite refused foreign_keys=ON");
  }
  if (integerPragma(database, "trusted_schema") !== 0) {
    throw new EventStoreOpenError("SQLite refused trusted_schema=OFF");
  }
  if (integerPragma(database, "recursive_triggers") !== 1) {
    throw new EventStoreOpenError("SQLite refused recursive_triggers=ON");
  }
}

function canonicalDatabasePath(path: string): string {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new SqliteEventStoreError(
      "INVALID_OPTIONS",
      "SQLite event-store path must be absolute",
    );
  }
  if (path.includes("\0")) {
    throw new SqliteEventStoreError("INVALID_OPTIONS", "SQLite path contains NUL");
  }
  const normalized = resolve(path);
  const parent = realpathSync(dirname(normalized));
  if (!statSync(parent).isDirectory()) {
    throw new SqliteEventStoreError(
      "INVALID_OPTIONS",
      "SQLite parent is not a directory",
    );
  }
  const canonical = join(parent, basename(normalized));
  if (existsSync(canonical)) {
    const entry = lstatSync(canonical);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
      throw new EventStoreOpenError(
        "SQLite event-store file must be one regular unlinked file",
      );
    }
  }
  return canonical;
}

function parseBusyTimeout(value: number | undefined): number {
  const timeout = value ?? 5_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new SqliteEventStoreError(
      "INVALID_OPTIONS",
      "busyTimeoutMs must be an integer from 1 through 60000",
    );
  }
  return timeout;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function parseClientToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    containsControlCharacter(value) ||
    Buffer.byteLength(value, "utf8") > MAX_CLIENT_TOKEN_BYTES
  ) {
    throw new SqliteEventStoreError(
      "INVALID_OPTIONS",
      "client token must be canonical non-empty UTF-8 of at most 256 bytes",
    );
  }
  return value;
}

function openReadOnlyAndVerify(path: string, busyTimeoutMs: number): void {
  let database: Database.Database | null = null;
  try {
    database = new Database(path, {
      readonly: true,
      fileMustExist: true,
      timeout: busyTimeoutMs,
    });
    verifyOwnedDatabase(database);
  } catch (cause) {
    if (cause instanceof SqliteEventStoreError) throw cause;
    throw new EventStoreOpenError("cannot verify existing SQLite event store", { cause });
  } finally {
    database?.close();
  }
}

function initializeOrVerify(database: Database.Database, createdAt: string): void {
  database
    .transaction(() => {
      if (!isEmptyDatabase(database)) {
        verifyOwnedDatabase(database);
        return;
      }
      database.exec(SCHEMA_SQL);
      database.pragma(`application_id = ${EVENT_STORE_APPLICATION_ID}`);
      database.pragma(`user_version = ${EVENT_STORE_FORMAT_VERSION}`);
      database
        .prepare<[number, string]>(
          "INSERT INTO event_store_meta(singleton, format_version, created_at) VALUES (1, ?, ?)",
        )
        .run(EVENT_STORE_FORMAT_VERSION, createdAt);
      verifyOwnedDatabase(database);
    })
    .exclusive();
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function bestEffortRemove(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

export class SqliteEventStore {
  readonly path: string;
  readonly #database: Database.Database;
  readonly #idFactory: () => EventId;
  readonly #now: () => Date;
  readonly #lookupToken: Database.Statement<[string, string], ExistingEventRow>;
  readonly #allocateSequence: Database.Statement<[string], SequenceRow>;
  readonly #insertEvent: Database.Statement<
    [string, number, string, number, string, string, string, string]
  >;
  readonly #readEvents: Database.Statement<[string, number], ReadEventRow>;
  readonly #appendTransaction: Database.Transaction<
    (
      input: EventInput,
      token: string,
      canonicalInput: string,
      digest: string,
    ) => StoredEvent
  >;
  #closed = false;
  #backupActive = false;

  constructor(options: OpenSqliteEventStoreOptions) {
    if (options === null || typeof options !== "object") {
      throw new SqliteEventStoreError("INVALID_OPTIONS", "store options are required");
    }
    const path = canonicalDatabasePath(options.path);
    const busyTimeoutMs = parseBusyTimeout(options.busyTimeoutMs);
    const existed = existsSync(path);
    const wasEmpty = existed && statSync(path).size === 0;
    if (existed && !wasEmpty) openReadOnlyAndVerify(path, busyTimeoutMs);

    let database: Database.Database | null = null;
    try {
      database = new Database(path, { timeout: busyTimeoutMs });
      database.pragma(`busy_timeout = ${busyTimeoutMs}`);
      database.pragma("foreign_keys = ON");
      database.pragma("trusted_schema = OFF");
      database.pragma("recursive_triggers = ON");
      initializeOrVerify(database, (options.now ?? (() => new Date()))().toISOString());
      configureConnection(database, busyTimeoutMs);
      verifyOwnedDatabase(database);
      chmodSync(path, 0o600);
    } catch (cause) {
      database?.close();
      if (cause instanceof SqliteEventStoreError) throw cause;
      throw new EventStoreOpenError("cannot open SQLite event store", { cause });
    }
    if (database === null) {
      throw new EventStoreOpenError("SQLite driver returned no database");
    }

    this.path = path;
    this.#database = database;
    this.#idFactory = options.idFactory ?? newEventId;
    this.#now = options.now ?? (() => new Date());
    this.#lookupToken = database.prepare<[string, string], ExistingEventRow>(
      `SELECT project, seq, id, schema_version, input_json, input_sha256, event_json
       FROM events
       WHERE project = ? AND client_token = ?`,
    );
    this.#allocateSequence = database.prepare<[string], SequenceRow>(
      `INSERT INTO project_sequences(project, last_seq)
       VALUES (?, 1)
       ON CONFLICT(project) DO UPDATE SET last_seq = last_seq + 1
       WHERE last_seq < ${MAX_SAFE_SEQUENCE}
       RETURNING last_seq AS seq`,
    );
    this.#insertEvent = database.prepare(
      `INSERT INTO events(
         project, seq, id, schema_version, client_token,
         input_json, input_sha256, event_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#readEvents = database.prepare<[string, number], ReadEventRow>(
      `SELECT seq, event_json
       FROM events
       WHERE project = ? AND seq > ?
       ORDER BY seq`,
    );
    this.#appendTransaction = database.transaction(
      (input, token, canonicalInput, digest) =>
        this.#appendInsideTransaction(input, token, canonicalInput, digest),
    );
  }

  get closed(): boolean {
    return this.#closed;
  }

  append<Type extends EventType>(
    input: EventAppendInput<Type>,
    options: SqliteEventStoreAppendOptions,
  ): StoredEvent<Type> {
    this.#assertOpen();
    const admitted = parseEventInput(input) as EventInput<Type>;
    const token = parseClientToken(options?.token);
    const canonicalInput = JSON.stringify(admitted);
    const digest = createHash("sha256").update(canonicalInput).digest("hex");
    try {
      return this.#appendTransaction.immediate(
        admitted,
        token,
        canonicalInput,
        digest,
      ) as StoredEvent<Type>;
    } catch (cause) {
      if (cause instanceof SqliteEventStoreError) throw cause;
      throw new EventStoreAppendError(cause);
    }
  }

  read(project: ProjectId, options: ReadEventsOptions = {}): readonly StoredEvent[] {
    this.#assertOpen();
    if (options === null || typeof options !== "object") {
      throw new SqliteEventStoreError(
        "INVALID_OPTIONS",
        "read options must be an object",
      );
    }
    const admittedProject = projectIdSchema.safeParse(project);
    if (!admittedProject.success) {
      throw new SqliteEventStoreError("INVALID_OPTIONS", "invalid project id", {
        cause: admittedProject.error,
      });
    }
    const afterSeq = parseAfterSequence(options?.afterSeq);
    const events: StoredEvent[] = [];
    let expectedSeq = afterSeq + 1;
    for (const row of this.#readEvents.iterate(admittedProject.data, afterSeq)) {
      if (row.seq !== expectedSeq) {
        throw new EventStoreIntegrityError(
          `event sequence gap: expected ${expectedSeq}, found ${row.seq}`,
        );
      }
      let event: StoredEvent;
      try {
        event = parseStoredEvent(JSON.parse(row.event_json));
      } catch (cause) {
        throw new EventStoreIntegrityError("stored event cannot be replayed", { cause });
      }
      if (event.project !== admittedProject.data || event.seq !== row.seq) {
        throw new EventStoreIntegrityError(
          "stored event columns disagree with replay JSON",
        );
      }
      events.push(event);
      expectedSeq += 1;
    }
    return Object.freeze(events);
  }

  async backup(destination: string): Promise<BackupEvidence> {
    this.#assertOpen();
    if (this.#backupActive) throw new BackupInProgressError();
    this.#backupActive = true;
    let temporaryPath: string | null = null;
    let reservationPath: string | null = null;
    try {
      const finalPath = this.#backupDestination(destination);
      const parent = dirname(finalPath);
      temporaryPath = join(
        parent,
        `.${basename(finalPath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      const reservationDescriptor = openSync(finalPath, "wx", 0o600);
      const reservationIdentity = fstatSync(reservationDescriptor);
      closeSync(reservationDescriptor);
      reservationPath = finalPath;

      const metadata = await this.#database.backup(temporaryPath);
      chmodSync(temporaryPath, 0o600);
      fsyncFile(temporaryPath);

      const backupDatabase = new Database(temporaryPath, {
        readonly: true,
        fileMustExist: true,
      });
      let eventCount: number;
      let projectCount: number;
      try {
        verifyOwnedDatabase(backupDatabase);
        eventCount = assertSafeCount(
          backupDatabase
            .prepare<[], CountRow>("SELECT COUNT(*) AS count FROM events")
            .get()?.count,
          "backup event count",
        );
        projectCount = assertSafeCount(
          backupDatabase
            .prepare<[], CountRow>("SELECT COUNT(*) AS count FROM project_sequences")
            .get()?.count,
          "backup project count",
        );
      } finally {
        backupDatabase.close();
      }

      const reservation = lstatSync(finalPath);
      if (
        !reservation.isFile() ||
        reservation.size !== 0 ||
        reservation.nlink !== 1 ||
        reservation.dev !== reservationIdentity.dev ||
        reservation.ino !== reservationIdentity.ino
      ) {
        throw new EventStoreIntegrityError(
          "backup destination reservation changed before publication",
        );
      }
      renameSync(temporaryPath, finalPath);
      temporaryPath = null;
      reservationPath = null;
      fsyncDirectory(parent);
      return Object.freeze({
        path: finalPath,
        eventCount,
        projectCount,
        totalPages: metadata.totalPages,
      });
    } catch (cause) {
      if (cause instanceof SqliteEventStoreError) throw cause;
      throw new EventStoreBackupError(cause);
    } finally {
      if (temporaryPath !== null) bestEffortRemove(temporaryPath);
      if (reservationPath !== null) bestEffortRemove(reservationPath);
      this.#backupActive = false;
    }
  }

  close(): void {
    if (this.#closed) return;
    if (this.#backupActive) throw new BackupInProgressError();
    this.#closed = true;
    this.#database.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new EventStoreClosedError();
  }

  #appendInsideTransaction(
    input: EventInput,
    token: string,
    canonicalInput: string,
    digest: string,
  ): StoredEvent {
    const existing = this.#lookupToken.get(input.project, token);
    if (existing) {
      if (existing.input_sha256 !== digest || existing.input_json !== canonicalInput) {
        throw new IdempotencyConflictError(input.project);
      }
      try {
        return parseStoredEvent(JSON.parse(existing.event_json));
      } catch (cause) {
        throw new EventStoreIntegrityError("idempotency row contains an invalid event", {
          cause,
        });
      }
    }

    const allocated = this.#allocateSequence.get(input.project);
    if (!allocated || !Number.isSafeInteger(allocated.seq) || allocated.seq < 1) {
      throw new EventStoreIntegrityError("project sequence exhausted or unavailable");
    }
    const draft = createEventDraft(input, {
      idFactory: this.#idFactory,
      now: this.#now,
    });
    const event = parseStoredEvent({ ...draft, seq: allocated.seq });
    this.#insertEvent.run(
      event.project,
      event.seq,
      event.id,
      event.schemaVersion,
      token,
      canonicalInput,
      digest,
      JSON.stringify(event),
    );
    return event;
  }

  #backupDestination(destination: string): string {
    if (typeof destination !== "string" || !isAbsolute(destination)) {
      throw new SqliteEventStoreError(
        "INVALID_OPTIONS",
        "backup destination must be absolute",
      );
    }
    const normalized = resolve(destination);
    const parent = realpathSync(dirname(normalized));
    const finalPath = join(parent, basename(normalized));
    if (finalPath === this.path) {
      throw new SqliteEventStoreError(
        "INVALID_OPTIONS",
        "backup destination must differ from the source",
      );
    }
    if (existsSync(finalPath)) {
      throw new SqliteEventStoreError(
        "INVALID_OPTIONS",
        "backup destination already exists",
      );
    }
    return finalPath;
  }
}

export function openSqliteEventStore(
  options: OpenSqliteEventStoreOptions,
): SqliteEventStore {
  return new SqliteEventStore(options);
}
