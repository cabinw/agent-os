export {
  EVENT_STORE_APPLICATION_ID,
  EVENT_STORE_FORMAT_VERSION,
  BackupInProgressError,
  EventStoreAppendError,
  EventStoreBackupError,
  EventStoreClosedError,
  EventStoreIntegrityError,
  EventStoreOpenError,
  IdempotencyConflictError,
  SqliteEventStore,
  SqliteEventStoreError,
  openSqliteEventStore,
} from "./store.js";
export type {
  BackupEvidence,
  OpenSqliteEventStoreOptions,
  ReadEventsOptions,
  SqliteEventStoreAppendOptions,
} from "./store.js";

export const PACKAGE = "event-store-sqlite" as const;

export {
  SNAPSHOT_STORE_APPLICATION_ID,
  SNAPSHOT_STORE_FORMAT_VERSION,
  SnapshotStoreError,
  SqliteSnapshotStore,
  openSqliteSnapshotStore,
} from "./snapshot-store.js";
export type { OpenSqliteSnapshotStoreOptions } from "./snapshot-store.js";
