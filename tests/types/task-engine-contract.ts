import type { EventBus, StoredEvent } from "../../packages/event-core/dist/index.js";
import {
  TASK_STATUSES,
  rankAgentPlacements,
  readyTaskIds,
  registerAgentCatalogReducer,
  registerTaskReducer,
  selectAgentPlacement,
  transitionTaskStatus,
} from "../../packages/task-engine/src/index.js";
import type {
  AgentCatalogState,
  LivePlacement,
  TaskProjectState,
  TaskStatus,
} from "../../packages/task-engine/src/index.js";

declare const bus: EventBus;
declare const status: TaskStatus;
declare const event: StoredEvent;

const next: TaskStatus = transitionTaskStatus(status, "task.cancelled");
void next;
const statuses: readonly TaskStatus[] = TASK_STATUSES;
void statuses;
const tasks = registerTaskReducer(bus);
const projection: TaskProjectState = tasks.get(event.project);
void projection;
const ready = readyTaskIds(projection);
const readyId: string | undefined = ready[0];
void readyId;
const catalogHandle = registerAgentCatalogReducer(bus);
const catalog: AgentCatalogState = catalogHandle.get(event.project);
declare const live: readonly LivePlacement[];
const ranked = rankAgentPlacements(catalog, projection, live, ["coding"]);
const selected = selectAgentPlacement(catalog, projection, live, ["coding"]);
void ranked;
void selected;

// @ts-expect-error non-task events cannot enter the task transition matrix
transitionTaskStatus(status, "agent.registered");

// @ts-expect-error capability vocabulary is controlled
selectAgentPlacement(catalog, projection, live, ["openai"]);
