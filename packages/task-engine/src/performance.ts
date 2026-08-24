import { CAPABILITIES } from "@agent-os/event-core";
import type { Capability, EntityId } from "@agent-os/event-core";
import type { TaskProjectState, TaskState } from "./reducer.js";

export type PerformanceAggregate = Readonly<{
  completed: number;
  failed: number;
  samples: number;
  successScore: number;
  durationSamples: number;
  averageDurationMs: number | null;
}>;

export type CapabilityPerformance = PerformanceAggregate &
  Readonly<{ capability: Capability }>;

export type AgentPerformance = Readonly<{
  agent: EntityId;
  overall: PerformanceAggregate;
  capabilities: Readonly<Partial<Record<Capability, CapabilityPerformance>>>;
}>;

export type AgentPerformanceReport = Readonly<{
  agents: Readonly<Record<string, AgentPerformance>>;
}>;

type MutableAggregate = {
  completed: number;
  failed: number;
  durationSamples: number;
  totalDurationMs: number;
};

type MutableAgent = {
  overall: MutableAggregate;
  capabilities: Map<Capability, MutableAggregate>;
};

export class AgentPerformanceError extends Error {
  readonly code: "INVALID_DURATION" | "INVALID_STATE";
  readonly task: string | undefined;

  constructor(code: AgentPerformanceError["code"], message: string, task?: string) {
    super(message);
    this.name = "AgentPerformanceError";
    this.code = code;
    this.task = task;
  }
}

function mutableAggregate(): MutableAggregate {
  return { completed: 0, failed: 0, durationSamples: 0, totalDurationMs: 0 };
}

function resultDuration(task: TaskState): number {
  if (task.startedAt === undefined || task.terminalAt === undefined) {
    throw new AgentPerformanceError(
      "INVALID_STATE",
      `result task ${task.id} has incomplete timing evidence`,
      task.id,
    );
  }
  const duration = Date.parse(task.terminalAt) - Date.parse(task.startedAt);
  if (!Number.isFinite(duration) || duration < 0) {
    throw new AgentPerformanceError(
      "INVALID_DURATION",
      `result task ${task.id} has invalid duration`,
      task.id,
    );
  }
  return duration;
}

function record(
  aggregate: MutableAggregate,
  status: "completed" | "failed",
  duration: number,
): void {
  aggregate[status] += 1;
  aggregate.durationSamples += 1;
  aggregate.totalDurationMs += duration;
}

function freezeAggregate(aggregate: MutableAggregate): PerformanceAggregate {
  const samples = aggregate.completed + aggregate.failed;
  return Object.freeze({
    completed: aggregate.completed,
    failed: aggregate.failed,
    samples,
    successScore: (aggregate.completed + 1) / (samples + 2),
    durationSamples: aggregate.durationSamples,
    averageDurationMs:
      aggregate.durationSamples === 0
        ? null
        : aggregate.totalDurationMs / aggregate.durationSamples,
  });
}

export function deriveAgentPerformance(state: TaskProjectState): AgentPerformanceReport {
  if (
    state === null ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    state.tasks === null ||
    typeof state.tasks !== "object" ||
    Array.isArray(state.tasks)
  ) {
    throw new AgentPerformanceError(
      "INVALID_STATE",
      "agent performance requires Task project state",
    );
  }
  const agents = new Map<string, MutableAgent>();
  for (const task of Object.values(state.tasks)) {
    if (task.executor === undefined) continue;
    const agent = agents.get(task.executor) ?? {
      overall: mutableAggregate(),
      capabilities: new Map<Capability, MutableAggregate>(),
    };
    agents.set(task.executor, agent);
    if (task.status !== "completed" && task.status !== "failed") continue;
    const duration = resultDuration(task);
    record(agent.overall, task.status, duration);
    for (const capability of task.requires) {
      if (!agent.capabilities.has(capability)) {
        agent.capabilities.set(capability, mutableAggregate());
      }
      record(
        agent.capabilities.get(capability) as MutableAggregate,
        task.status,
        duration,
      );
    }
  }

  const result: Record<string, AgentPerformance> = {};
  for (const [agentId, agent] of [...agents.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const capabilities: Partial<Record<Capability, CapabilityPerformance>> = {};
    for (const capability of CAPABILITIES) {
      const aggregate = agent.capabilities.get(capability);
      if (aggregate === undefined) continue;
      capabilities[capability] = Object.freeze({
        capability,
        ...freezeAggregate(aggregate),
      });
    }
    result[agentId] = Object.freeze({
      agent: agentId as EntityId,
      overall: freezeAggregate(agent.overall),
      capabilities: Object.freeze(capabilities),
    });
  }
  return Object.freeze({ agents: Object.freeze(result) });
}

const EMPTY_AGGREGATE = freezeAggregate(mutableAggregate());

export function performanceForCapabilities(
  report: AgentPerformanceReport,
  agent: EntityId,
  requires: readonly Capability[],
): Readonly<{
  capabilities: readonly CapabilityPerformance[];
  successScore: number;
}> {
  const performance = report.agents[agent];
  if (requires.length === 0) {
    return Object.freeze({
      capabilities: Object.freeze([]),
      successScore: performance?.overall.successScore ?? EMPTY_AGGREGATE.successScore,
    });
  }
  const capabilities = requires.map((capability) =>
    Object.freeze({
      capability,
      ...(performance?.capabilities[capability] ?? EMPTY_AGGREGATE),
    }),
  );
  return Object.freeze({
    capabilities: Object.freeze(capabilities),
    successScore:
      capabilities.reduce((sum, item) => sum + item.successScore, 0) /
      capabilities.length,
  });
}
