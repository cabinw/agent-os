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
  SqliteEventStoreAppendOptions,
} from "./store.js";

export const PACKAGE = "event-store-sqlite" as const;
