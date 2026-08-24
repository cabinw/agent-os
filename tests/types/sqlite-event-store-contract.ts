import type { EventInput, EventOf } from "../../packages/event-core/src/index.js";
import type {
  BackupEvidence,
  EventStoreAppendError,
  SqliteEventStore,
} from "../../packages/event-store-sqlite/src/index.js";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? true
  : false;
type Assert<Condition extends true> = Condition;

declare const store: SqliteEventStore;
declare const input: EventInput<"task.started">;

const stored = store.append(input, { token: "command-token" });
type _AppendPreservesDiscriminant = Assert<Equal<typeof stored, EventOf<"task.started">>>;
const executor: string = stored.payload.executor;
void executor;

// @ts-expect-error every append requires explicit idempotency metadata
store.append(input, {});
// @ts-expect-error a producer cannot supply a stored event in place of EventInput
store.append(stored, { token: "wrong-shape" });

declare const evidence: BackupEvidence;
const eventCount: number = evidence.eventCount;
void eventCount;

declare const failure: EventStoreAppendError;
const retryable: boolean = failure.retryable;
void retryable;
