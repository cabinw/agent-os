import { parseStoredEvent } from "@agent-os/event-core";
import type { EventType, StoredEvent } from "@agent-os/event-core";
import type { KnowledgeType } from "./schemas.js";

export const KNOWLEDGE_TRIGGER_KINDS = Object.freeze([
  "decision-recorded",
  "result-recorded",
  "blocker-resolved",
  "discussion-concluded",
  "research-produced",
] as const);

export type KnowledgeTriggerKind = (typeof KNOWLEDGE_TRIGGER_KINDS)[number];
export type KnowledgeNoiseReason =
  | "transient-operation"
  | "unresolved-context"
  | "administrative"
  | "derived-output";

export type KnowledgeCandidate = Readonly<{
  kind: "candidate";
  event: StoredEvent;
  trigger: KnowledgeTriggerKind;
  possibleTypes: readonly KnowledgeType[];
}>;

export type KnowledgeNoise = Readonly<{
  kind: "noise";
  event: StoredEvent;
  reason: KnowledgeNoiseReason;
}>;

export type KnowledgeEventClassification = KnowledgeCandidate | KnowledgeNoise;

const DECISION_TYPES = Object.freeze([
  "decision",
  "discussion",
] as const satisfies readonly KnowledgeType[]);
const RESULT_TYPES = Object.freeze([
  "task-summary",
  "milestone",
  "technical-note",
] as const satisfies readonly KnowledgeType[]);
const BLOCKER_TYPES = Object.freeze([
  "technical-note",
  "task-summary",
] as const satisfies readonly KnowledgeType[]);
const DISCUSSION_TYPES = Object.freeze([
  "discussion",
  "research",
  "technical-note",
  "decision",
] as const satisfies readonly KnowledgeType[]);
const RESEARCH_TYPES = Object.freeze([
  "research",
  "technical-note",
] as const satisfies readonly KnowledgeType[]);

type Rule =
  | Readonly<{
      kind: "candidate";
      trigger: KnowledgeTriggerKind;
      possibleTypes: readonly KnowledgeType[];
    }>
  | Readonly<{ kind: "noise"; reason: KnowledgeNoiseReason }>
  | Readonly<{ kind: "message" }>;

const RULES = Object.freeze({
  "agent.registered": Object.freeze({ kind: "noise", reason: "transient-operation" }),
  "agent.status.changed": Object.freeze({
    kind: "noise",
    reason: "transient-operation",
  }),
  "agent.disconnected": Object.freeze({
    kind: "noise",
    reason: "transient-operation",
  }),
  "task.created": Object.freeze({ kind: "noise", reason: "transient-operation" }),
  "task.assigned": Object.freeze({ kind: "noise", reason: "transient-operation" }),
  "task.started": Object.freeze({ kind: "noise", reason: "transient-operation" }),
  "task.progress.updated": Object.freeze({
    kind: "noise",
    reason: "transient-operation",
  }),
  "task.blocked": Object.freeze({ kind: "noise", reason: "unresolved-context" }),
  "task.unblocked": Object.freeze({
    kind: "candidate",
    trigger: "blocker-resolved",
    possibleTypes: BLOCKER_TYPES,
  }),
  "task.review.requested": Object.freeze({
    kind: "candidate",
    trigger: "result-recorded",
    possibleTypes: RESULT_TYPES,
  }),
  "task.completed": Object.freeze({
    kind: "candidate",
    trigger: "result-recorded",
    possibleTypes: RESULT_TYPES,
  }),
  "task.failed": Object.freeze({
    kind: "candidate",
    trigger: "result-recorded",
    possibleTypes: RESULT_TYPES,
  }),
  "task.cancelled": Object.freeze({
    kind: "candidate",
    trigger: "result-recorded",
    possibleTypes: RESULT_TYPES,
  }),
  "message.sent": Object.freeze({ kind: "message" }),
  "approval.requested": Object.freeze({
    kind: "noise",
    reason: "unresolved-context",
  }),
  "approval.granted": Object.freeze({
    kind: "candidate",
    trigger: "decision-recorded",
    possibleTypes: DECISION_TYPES,
  }),
  "approval.rejected": Object.freeze({
    kind: "candidate",
    trigger: "decision-recorded",
    possibleTypes: DECISION_TYPES,
  }),
  "approval.expired": Object.freeze({
    kind: "noise",
    reason: "unresolved-context",
  }),
  "knowledge.created": Object.freeze({ kind: "noise", reason: "derived-output" }),
  "knowledge.linked": Object.freeze({ kind: "noise", reason: "derived-output" }),
  "knowledge.superseded": Object.freeze({
    kind: "noise",
    reason: "derived-output",
  }),
  "project.created": Object.freeze({ kind: "noise", reason: "administrative" }),
  "project.human.participation.configured": Object.freeze({
    kind: "noise",
    reason: "administrative",
  }),
  "project.state.changed": Object.freeze({
    kind: "noise",
    reason: "administrative",
  }),
  "project.snapshot.captured": Object.freeze({
    kind: "noise",
    reason: "administrative",
  }),
  "project.revived": Object.freeze({ kind: "noise", reason: "derived-output" }),
  "artifact.produced": Object.freeze({
    kind: "candidate",
    trigger: "research-produced",
    possibleTypes: RESEARCH_TYPES,
  }),
  "artifact.derived": Object.freeze({
    kind: "candidate",
    trigger: "research-produced",
    possibleTypes: RESEARCH_TYPES,
  }),
  "measurement.recorded": Object.freeze({
    kind: "candidate",
    trigger: "result-recorded",
    possibleTypes: RESULT_TYPES,
  }),
  "pulse.story.generated": Object.freeze({
    kind: "noise",
    reason: "derived-output",
  }),
} as const satisfies Readonly<Record<EventType, Rule>>);

function candidate(
  event: StoredEvent,
  trigger: KnowledgeTriggerKind,
  possibleTypes: readonly KnowledgeType[],
): KnowledgeCandidate {
  return Object.freeze({ kind: "candidate", event, trigger, possibleTypes });
}

function noise(event: StoredEvent, reason: KnowledgeNoiseReason): KnowledgeNoise {
  return Object.freeze({ kind: "noise", event, reason });
}

/**
 * Strictly validate and structurally classify one durable event.
 *
 * This selects anchors only. It does not build a window or extract knowledge.
 */
export function classifyKnowledgeEvent(value: unknown): KnowledgeEventClassification {
  const event = parseStoredEvent(value);
  const rule = RULES[event.type];
  if (rule.kind === "candidate") {
    return candidate(event, rule.trigger, rule.possibleTypes);
  }
  if (rule.kind === "noise") return noise(event, rule.reason);

  const message = event as StoredEvent<"message.sent">;
  switch (message.payload.type) {
    case "answer":
    case "report":
    case "review":
      return candidate(message, "discussion-concluded", DISCUSSION_TYPES);
    case "instruction":
    case "question":
    case "progress":
    case "warning":
      return noise(message, "unresolved-context");
  }
}
