import { CAPABILITIES, entityIdSchema } from "@agent-os/event-core";
import type { Capability, EntityId } from "@agent-os/event-core";
import { agentPlacementKey } from "./catalog.js";
import type { AgentCatalogState, AgentPlacementState } from "./catalog.js";
import { deriveAgentPerformance, performanceForCapabilities } from "./performance.js";
import type { CapabilityPerformance } from "./performance.js";
import type { TaskProjectState } from "./reducer.js";

export type LivePlacement = Readonly<{
  agent: EntityId;
  host: EntityId;
  accepting: boolean;
  active: number;
}>;

export type AgentOutcome = Readonly<{
  completed: number;
  failed: number;
}>;

export type AgentRouteCandidate = Readonly<{
  agent: EntityId;
  host: EntityId;
  capabilities: readonly Capability[];
  matchedCapabilities: number;
  logicalActive: number;
  logicalConcurrency: number;
  placementActive: number;
  outcomes: AgentOutcome;
  outcomeScore: number;
  capabilityPerformance: readonly CapabilityPerformance[];
  capabilityOutcomeScore: number;
}>;

export type NoEligiblePlacementReason =
  | "no-capability"
  | "unreachable"
  | "unavailable"
  | "saturated";

export type AgentRouteResult =
  | Readonly<{ matched: true; candidate: AgentRouteCandidate }>
  | Readonly<{
      matched: false;
      reason: NoEligiblePlacementReason;
      requiredCapabilities: readonly Capability[];
    }>;

export class AgentRoutingInputError extends Error {
  readonly code: "DUPLICATE_LIVE_PLACEMENT" | "INVALID_LIVE_PLACEMENT";
  readonly agent: string | undefined;
  readonly host: string | undefined;

  constructor(
    code: AgentRoutingInputError["code"],
    message: string,
    agent?: string,
    host?: string,
  ) {
    super(message);
    this.name = "AgentRoutingInputError";
    this.code = code;
    this.agent = agent;
    this.host = host;
  }
}

function assertRequirements(requires: readonly Capability[]): void {
  if (
    new Set(requires).size !== requires.length ||
    requires.some((capability) => !CAPABILITIES.includes(capability))
  ) {
    throw new AgentRoutingInputError(
      "INVALID_LIVE_PLACEMENT",
      "required capabilities must be unique controlled values",
    );
  }
}

function liveByKey(
  catalog: AgentCatalogState,
  live: readonly LivePlacement[],
): ReadonlyMap<string, LivePlacement> {
  const result = new Map<string, LivePlacement>();
  for (const item of live) {
    const agent = entityIdSchema.safeParse(item.agent);
    const host = entityIdSchema.safeParse(item.host);
    if (
      !agent.success ||
      !host.success ||
      typeof item.accepting !== "boolean" ||
      !Number.isSafeInteger(item.active) ||
      item.active < 0
    ) {
      throw new AgentRoutingInputError(
        "INVALID_LIVE_PLACEMENT",
        "live placement contains invalid identity, availability or load",
        item.agent,
        item.host,
      );
    }
    const key = agentPlacementKey(agent.data, host.data);
    if (catalog.placements[key] === undefined) {
      throw new AgentRoutingInputError(
        "INVALID_LIVE_PLACEMENT",
        `live placement ${agent.data}@${host.data} is not registered`,
        agent.data,
        host.data,
      );
    }
    if (result.has(key)) {
      throw new AgentRoutingInputError(
        "DUPLICATE_LIVE_PLACEMENT",
        `live placement ${agent.data}@${host.data} is duplicated`,
        agent.data,
        host.data,
      );
    }
    result.set(key, item);
  }
  return result;
}

function hasCapabilities(
  placement: AgentPlacementState,
  requires: readonly Capability[],
): boolean {
  return requires.every((capability) => placement.capabilities.includes(capability));
}

function logicalLoads(
  live: ReadonlyMap<string, LivePlacement>,
): ReadonlyMap<string, number> {
  const loads = new Map<string, number>();
  for (const placement of live.values()) {
    loads.set(placement.agent, (loads.get(placement.agent) ?? 0) + placement.active);
  }
  return loads;
}

function compareCandidates(
  left: AgentRouteCandidate,
  right: AgentRouteCandidate,
): number {
  if (left.matchedCapabilities !== right.matchedCapabilities) {
    return right.matchedCapabilities - left.matchedCapabilities;
  }
  const logicalLoad =
    left.logicalActive * right.logicalConcurrency -
    right.logicalActive * left.logicalConcurrency;
  if (logicalLoad !== 0) return logicalLoad;
  if (left.placementActive !== right.placementActive) {
    return left.placementActive - right.placementActive;
  }
  if (left.capabilityOutcomeScore !== right.capabilityOutcomeScore) {
    return right.capabilityOutcomeScore - left.capabilityOutcomeScore;
  }
  const leftOutcomeNumerator = left.outcomes.completed + 1;
  const leftOutcomeDenominator = left.outcomes.completed + left.outcomes.failed + 2;
  const rightOutcomeNumerator = right.outcomes.completed + 1;
  const rightOutcomeDenominator = right.outcomes.completed + right.outcomes.failed + 2;
  const outcome =
    rightOutcomeNumerator * leftOutcomeDenominator -
    leftOutcomeNumerator * rightOutcomeDenominator;
  if (outcome !== 0) return outcome;
  const agent = left.agent.localeCompare(right.agent);
  return agent === 0 ? left.host.localeCompare(right.host) : agent;
}

export function rankAgentPlacements(
  catalog: AgentCatalogState,
  tasks: TaskProjectState,
  livePlacements: readonly LivePlacement[],
  requires: readonly Capability[],
): readonly AgentRouteCandidate[] {
  assertRequirements(requires);
  const live = liveByKey(catalog, livePlacements);
  const loads = logicalLoads(live);
  const performance = deriveAgentPerformance(tasks);
  const candidates: AgentRouteCandidate[] = [];
  for (const [key, placement] of Object.entries(catalog.placements)) {
    if (!hasCapabilities(placement, requires)) continue;
    const current = live.get(key);
    if (current === undefined || !current.accepting) continue;
    const logicalActive = loads.get(placement.agent) ?? 0;
    if (logicalActive >= placement.concurrency) continue;
    const overall = performance.agents[placement.agent]?.overall;
    const history = {
      completed: overall?.completed ?? 0,
      failed: overall?.failed ?? 0,
    };
    const capability = performanceForCapabilities(performance, placement.agent, requires);
    candidates.push({
      agent: placement.agent,
      host: placement.host,
      capabilities: [...placement.capabilities],
      matchedCapabilities: requires.length,
      logicalActive,
      logicalConcurrency: placement.concurrency,
      placementActive: current.active,
      outcomes: { ...history },
      outcomeScore: (history.completed + 1) / (history.completed + history.failed + 2),
      capabilityPerformance: capability.capabilities,
      capabilityOutcomeScore: capability.successScore,
    });
  }
  return candidates.sort(compareCandidates);
}

export function selectAgentPlacement(
  catalog: AgentCatalogState,
  tasks: TaskProjectState,
  livePlacements: readonly LivePlacement[],
  requires: readonly Capability[],
): AgentRouteResult {
  const candidates = rankAgentPlacements(catalog, tasks, livePlacements, requires);
  const first = candidates[0];
  if (first !== undefined) return { matched: true, candidate: first };

  const capable = Object.values(catalog.placements).filter((placement) =>
    hasCapabilities(placement, requires),
  );
  if (capable.length === 0) {
    return {
      matched: false,
      reason: "no-capability",
      requiredCapabilities: [...requires],
    };
  }
  const live = liveByKey(catalog, livePlacements);
  const reachable = capable.filter((placement) =>
    live.has(agentPlacementKey(placement.agent, placement.host)),
  );
  if (reachable.length === 0) {
    return { matched: false, reason: "unreachable", requiredCapabilities: [...requires] };
  }
  const accepting = reachable.filter(
    (placement) =>
      live.get(agentPlacementKey(placement.agent, placement.host))?.accepting,
  );
  if (accepting.length === 0) {
    return { matched: false, reason: "unavailable", requiredCapabilities: [...requires] };
  }
  return { matched: false, reason: "saturated", requiredCapabilities: [...requires] };
}
