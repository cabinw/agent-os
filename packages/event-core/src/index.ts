/**
 * event-core — the kernel.
 *
 * Owns the versioned event contract, append-only log, ordering, snapshots,
 * replay, and reducer registration. It validates permanent record structure but
 * leaves domain transitions and authorization to higher layers.
 *
 * This package is the bottom of the dependency stack. It imports nothing from
 * this repo — see docs/architecture/packages.md.
 *
 * Contract to implement (Phase 1.1a–1.1d, docs/development/roadmap.md):
 *   append(event)          → persist, allocate seq, acknowledge after durable
 *   subscribe(handler)     → live stream for Canvas / Pulse / menu bar
 *   replay(from)           → deterministic re-run from the first stored event
 *   registerReducer(fn)    → pure (state, event) => state
 */

export {
  createEventIdGenerator,
  isEventId,
  newEventId,
  parseEventId,
} from "./id.js";
export type {
  EventId,
  EventIdClock,
  EventIdGeneratorOptions,
  EventIdRandom,
} from "./id.js";
export {
  EVENT_SCHEMA_VERSION,
  createEventDraft,
  eventDraftSchema,
  eventInputSchema,
  parseEventDraft,
  parseEventInput,
  parseStoredEvent,
  storedEventSchema,
} from "./envelope.js";
export type {
  CreateEventDraftOptions,
  EventDraft,
  EventInput,
  EventOf,
  EventSubject,
  StoredEvent,
} from "./envelope.js";
export {
  AGENT_ROLES,
  AGENT_STATUSES,
  CAPABILITIES,
  EVENT_TYPES,
  KNOWLEDGE_TYPES,
  MESSAGE_TYPES,
  PRIORITIES,
  PROJECT_STATES,
  agentRoleSchema,
  agentStatusSchema,
  capabilitySchema,
  eventPayloadSchemas,
  eventTypeSchema,
  integrationSchema,
  knowledgeTypeSchema,
  messageTypeSchema,
  parseEventPayload,
  prioritySchema,
  projectStateSchema,
  revivalPlanStepSchema,
} from "./payloads.js";
export type {
  Capability,
  EventPayload,
  EventPayloadMap,
  EventType,
} from "./payloads.js";
export {
  ACTOR_KINDS,
  SUBJECT_KINDS,
  actorKindSchema,
  actorSchema,
  entityIdSchema,
  eventIdSchema,
  finiteNumberSchema,
  knowledgeIdSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
  projectIdSchema,
  rfc3339Schema,
  subjectKindSchema,
  subjectSchema,
  taskIdSchema,
} from "./primitives.js";
export {
  EventBus,
  EventBusError,
  EventReplayError,
  ReducerExecutionError,
  ReducerRegistrationError,
  createEventBus,
} from "./bus.js";
export type {
  EventAppendOptions,
  EventAppendInput,
  EventBusOptions,
  EventBusStore,
  EventReadOptions,
  EventReducer,
  EventSubscriber,
  ReducerHandle,
  ReplayEvidence,
  SubscribeOptions,
  SubscriberErrorHandler,
} from "./bus.js";
export type { DeepReadonly } from "./immutable.js";
export type {
  Actor,
  ActorKind,
  EntityId,
  KnowledgeId,
  ProjectId,
  Seq,
  Subject,
  SubjectKind,
  TaskId,
} from "./primitives.js";

export const PACKAGE = "event-core" as const;
