import type { CoreDemoEvidence } from "../../apps/core-demo/src/index.js";

declare const evidence: CoreDemoEvidence;

evidence.taskStatus satisfies "completed";
evidence.liveEqualsReplay satisfies true;

// @ts-expect-error evidence is immutable
evidence.eventCount = 0;
// @ts-expect-error event order evidence is immutable
evidence.eventTypes.push("task.failed");
