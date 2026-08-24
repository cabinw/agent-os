import type { KnowledgeId as CanonicalKnowledgeId } from "../../packages/event-core/src/index.js";
import {
  buildKnowledgeWindow,
  classifyKnowledgeEvent,
  createKnowledgeExtractor,
  createKnowledgeSuperseder,
  emptyKnowledgeProjectState,
  parseKnowledgeDraft,
  reduceKnowledgeProject,
} from "../../packages/memory-core/src/index.js";
import type {
  KnowledgeDraft,
  KnowledgeEventClassification,
  KnowledgeId,
  KnowledgeProjectState,
  KnowledgeWindow,
} from "../../packages/memory-core/src/index.js";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? true
  : false;
type Assert<Condition extends true> = Condition;

type _UsesCanonicalKnowledgeId = Assert<Equal<KnowledgeId, CanonicalKnowledgeId>>;

declare const untrusted: unknown;
const draft: KnowledgeDraft = parseKnowledgeDraft(untrusted);
const classification: KnowledgeEventClassification = classifyKnowledgeEvent(untrusted);
const window: KnowledgeWindow = buildKnowledgeWindow(untrusted, untrusted);
const memory: KnowledgeProjectState = emptyKnowledgeProjectState();
void classification;
void window;
void reduceKnowledgeProject(memory, untrusted as never);

const extractor = createKnowledgeExtractor({
  summarizer: { summarize: () => ({}) },
  admission: { admit: () => {} },
});
void extractor;
const superseder = createKnowledgeSuperseder({
  port: { current: () => memory, admit: () => {} },
});
void superseder;

// @ts-expect-error parsed drafts are deeply readonly
draft.title = "mutated";
// @ts-expect-error source evidence is deeply readonly
draft.sourceEvents.push("evt_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never);
// @ts-expect-error window evidence is deeply readonly
window.events.push(untrusted as never);
// @ts-expect-error projection maps are deeply readonly
memory.items["KN-001"] = untrusted as never;
// @ts-expect-error ids are not plain caller strings
const invalidId: KnowledgeId = "KN-001";
void invalidId;
