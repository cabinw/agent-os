import {
  type EventOf,
  type ProjectId,
  type Seq,
  type StoredEvent,
  type TaskId,
  eventDraftSchema,
  eventInputSchema,
  parseEventDraft,
  parseEventInput,
  parseStoredEvent,
  storedEventSchema,
} from "../../packages/event-core/src/index.js";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? true
  : false;
type Assert<Condition extends true> = Condition;

type TaskSubjectKind = EventOf<"task.started">["subject"]["kind"];
type _TaskSubjectIsStaticallyBound = Assert<Equal<TaskSubjectKind, "task">>;
type _TaskSubjectIdIsBranded = Assert<
  Equal<EventOf<"task.started">["subject"]["id"], TaskId>
>;
type _ProjectSubjectIdIsBranded = Assert<
  Equal<EventOf<"project.state.changed">["subject"]["id"], ProjectId>
>;
type _StoredSequenceIsBranded = Assert<Equal<StoredEvent["seq"], Seq>>;

declare const untrusted: unknown;

// Parser results are runtime-discriminated unions. Callers cannot assert a
// narrower event type by supplying an unrelated generic argument.
// @ts-expect-error parseEventInput intentionally has no public type parameter
parseEventInput<"task.started">(untrusted);
// @ts-expect-error parseEventDraft intentionally has no public type parameter
parseEventDraft<"task.started">(untrusted);
// @ts-expect-error parseStoredEvent intentionally has no public type parameter
parseStoredEvent<"task.started">(untrusted);

const parsed = parseStoredEvent(untrusted);
if (parsed.type === "task.started") {
  const executor: string = parsed.payload.executor;
  void executor;
  // @ts-expect-error narrowing excludes fields from other event payloads
  parsed.payload.reason;
}

for (const directlyParsed of [
  eventInputSchema.parse(untrusted),
  eventDraftSchema.parse(untrusted),
  storedEventSchema.parse(untrusted),
]) {
  if ("causedBy" in directlyParsed) {
    const cause: string = directlyParsed.causedBy;
    void cause;
  }
  if (directlyParsed.type === "task.started") {
    const executor: string = directlyParsed.payload.executor;
    const subjectKind: "task" = directlyParsed.subject.kind;
    void executor;
    void subjectKind;
    // @ts-expect-error direct schema output narrows away unrelated payloads
    directlyParsed.payload.reason;
  }
}

declare const registered: EventOf<"agent.registered">;
// @ts-expect-error parsed arrays are deeply readonly
registered.payload.capabilities.push("ops");
// @ts-expect-error parsed nested objects are deeply readonly
registered.payload.integration.usage = false;
