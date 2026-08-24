import type {
  ConversationItem,
  ConversationProjectState,
  ConversationThread,
} from "../../packages/task-engine/src/index.js";

declare const state: ConversationProjectState;
declare const thread: ConversationThread;
declare const item: ConversationItem;

// @ts-expect-error project state is immutable
state.threads = {};
// @ts-expect-error thread items are immutable
thread.items.push(item);

if (item.kind === "progress-run") {
  // @ts-expect-error progress runs preserve immutable original events
  item.events.pop();
}

if (item.kind === "message") {
  item.event.payload.content satisfies string;
}
