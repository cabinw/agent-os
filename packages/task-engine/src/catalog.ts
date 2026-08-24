import {
  AGENT_ROLES,
  AGENT_STATUSES,
  CAPABILITIES,
  entityIdSchema,
  integrationSchema,
  projectIdSchema,
  rfc3339Schema,
} from "@agent-os/event-core";
import type {
  Capability,
  EntityId,
  EventBus,
  EventPayload,
  ProjectId,
  ReducerHandle,
  StoredEvent,
} from "@agent-os/event-core";

type AgentRole = EventPayload<"agent.registered">["role"];
type AgentStatus = EventPayload<"agent.status.changed">["to"];
type Integration = EventPayload<"agent.registered">["integration"];

export type AgentPlacementState = Readonly<{
  agent: EntityId;
  host: EntityId;
  project: ProjectId;
  name: string;
  provider: string;
  role: AgentRole;
  parentAgent?: EntityId;
  concurrency: number;
  capabilities: readonly Capability[];
  integration: Integration;
  status: AgentStatus;
  registeredAt: string;
  changedAt: string;
  disconnectedAt?: string;
}>;

export type AgentCatalogState = Readonly<{
  placements: Readonly<Record<string, AgentPlacementState>>;
}>;

export class AgentCatalogError extends Error {
  readonly code:
    | "DUPLICATE_PLACEMENT"
    | "INCONSISTENT_AGENT"
    | "INVALID_STATE"
    | "MISSING_PLACEMENT"
    | "STALE_STATUS";
  readonly agent: string | undefined;
  readonly host: string | undefined;

  constructor(
    code: AgentCatalogError["code"],
    message: string,
    agent?: string,
    host?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentCatalogError";
    this.code = code;
    this.agent = agent;
    this.host = host;
  }
}

export function agentPlacementKey(agent: string, host: string): string {
  return JSON.stringify([agent, host]);
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function assertLogicalIdentity(
  placements: Readonly<Record<string, AgentPlacementState>>,
  payload: EventPayload<"agent.registered">,
): void {
  for (const existing of Object.values(placements)) {
    if (existing.agent !== payload.id) continue;
    if (
      existing.name !== payload.name ||
      existing.provider !== payload.provider ||
      existing.role !== payload.role ||
      !sameOptional(existing.parentAgent, payload.parentAgent) ||
      existing.concurrency !== payload.concurrency
    ) {
      throw new AgentCatalogError(
        "INCONSISTENT_AGENT",
        `agent ${payload.id} logical fields conflict across placements`,
        payload.id,
        payload.host,
      );
    }
  }
}

function registerPlacement(
  state: AgentCatalogState,
  event: StoredEvent<"agent.registered">,
): AgentCatalogState {
  const payload = event.payload;
  const key = agentPlacementKey(payload.id, payload.host);
  if (state.placements[key] !== undefined) {
    throw new AgentCatalogError(
      "DUPLICATE_PLACEMENT",
      `placement ${payload.id}@${payload.host} is already registered`,
      payload.id,
      payload.host,
    );
  }
  assertLogicalIdentity(state.placements, payload);
  const placement: AgentPlacementState = {
    agent: payload.id,
    host: payload.host,
    project: event.project,
    name: payload.name,
    provider: payload.provider,
    role: payload.role,
    ...(payload.parentAgent === undefined ? {} : { parentAgent: payload.parentAgent }),
    concurrency: payload.concurrency,
    capabilities: [...payload.capabilities],
    integration: { ...payload.integration },
    status: "idle",
    registeredAt: event.at,
    changedAt: event.at,
  };
  return { placements: { ...state.placements, [key]: placement } };
}

function requirePlacement(
  state: AgentCatalogState,
  agent: string,
  host: string,
): readonly [string, AgentPlacementState] {
  const key = agentPlacementKey(agent, host);
  const placement = state.placements[key];
  if (placement === undefined) {
    throw new AgentCatalogError(
      "MISSING_PLACEMENT",
      `placement ${agent}@${host} is not registered`,
      agent,
      host,
    );
  }
  return [key, placement];
}

export function reduceAgentCatalog(
  state: AgentCatalogState,
  event: StoredEvent,
): AgentCatalogState {
  if (event.type === "agent.registered") return registerPlacement(state, event);
  if (event.type === "agent.status.changed") {
    const [key, placement] = requirePlacement(
      state,
      event.subject.id,
      event.payload.host,
    );
    if (
      placement.disconnectedAt !== undefined ||
      placement.status !== event.payload.from
    ) {
      throw new AgentCatalogError(
        "STALE_STATUS",
        `placement ${placement.agent}@${placement.host} expected ${placement.status}, received ${event.payload.from}`,
        placement.agent,
        placement.host,
      );
    }
    return {
      placements: {
        ...state.placements,
        [key]: {
          ...placement,
          status: event.payload.to,
          changedAt: event.at,
        },
      },
    };
  }
  if (event.type === "agent.disconnected") {
    const [key, placement] = requirePlacement(
      state,
      event.payload.id,
      event.payload.host,
    );
    if (placement.disconnectedAt !== undefined) {
      throw new AgentCatalogError(
        "STALE_STATUS",
        `placement ${placement.agent}@${placement.host} is already disconnected`,
        placement.agent,
        placement.host,
      );
    }
    return {
      placements: {
        ...state.placements,
        [key]: { ...placement, changedAt: event.at, disconnectedAt: event.at },
      },
    };
  }
  return state;
}

const PLACEMENT_KEYS = new Set([
  "agent",
  "host",
  "project",
  "name",
  "provider",
  "role",
  "parentAgent",
  "concurrency",
  "capabilities",
  "integration",
  "status",
  "registeredAt",
  "changedAt",
  "disconnectedAt",
]);

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new AgentCatalogError("INVALID_STATE", `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new AgentCatalogError("INVALID_STATE", `${label} has unknown field ${key}`);
    }
  }
}

function schemaValue<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  label: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AgentCatalogError("INVALID_STATE", `${label} is invalid`);
  }
  return result.data;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new AgentCatalogError("INVALID_STATE", `${label} must be non-empty`);
  }
  return value;
}

function parsePlacement(
  value: unknown,
  key: string,
  project: ProjectId,
): AgentPlacementState {
  const label = `placement ${key}`;
  const raw = plainObject(value, label);
  exactKeys(raw, PLACEMENT_KEYS, label);
  const agent = schemaValue(entityIdSchema, raw.agent, `${label}.agent`);
  const host = schemaValue(entityIdSchema, raw.host, `${label}.host`);
  if (agentPlacementKey(agent, host) !== key) {
    throw new AgentCatalogError("INVALID_STATE", `${label} has mismatched key`);
  }
  const parsedProject = schemaValue(projectIdSchema, raw.project, `${label}.project`);
  if (parsedProject !== project) {
    throw new AgentCatalogError("INVALID_STATE", `${label} has wrong project`);
  }
  if (!Number.isSafeInteger(raw.concurrency) || (raw.concurrency as number) <= 0) {
    throw new AgentCatalogError("INVALID_STATE", `${label}.concurrency is invalid`);
  }
  if (!Array.isArray(raw.capabilities)) {
    throw new AgentCatalogError(
      "INVALID_STATE",
      `${label}.capabilities must be an array`,
    );
  }
  const capabilities = raw.capabilities.map((item, index) => {
    if (!CAPABILITIES.includes(item as Capability)) {
      throw new AgentCatalogError(
        "INVALID_STATE",
        `${label}.capabilities[${index}] is invalid`,
      );
    }
    return item as Capability;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new AgentCatalogError("INVALID_STATE", `${label}.capabilities has duplicates`);
  }
  if (!AGENT_ROLES.includes(raw.role as AgentRole)) {
    throw new AgentCatalogError("INVALID_STATE", `${label}.role is invalid`);
  }
  if (!AGENT_STATUSES.includes(raw.status as AgentStatus)) {
    throw new AgentCatalogError("INVALID_STATE", `${label}.status is invalid`);
  }
  const parentAgent =
    raw.parentAgent === undefined
      ? undefined
      : schemaValue(entityIdSchema, raw.parentAgent, `${label}.parentAgent`);
  const disconnectedAt =
    raw.disconnectedAt === undefined
      ? undefined
      : schemaValue(rfc3339Schema, raw.disconnectedAt, `${label}.disconnectedAt`);
  return {
    agent,
    host,
    project: parsedProject,
    name: stringValue(raw.name, `${label}.name`),
    provider: stringValue(raw.provider, `${label}.provider`),
    role: raw.role as AgentRole,
    ...(parentAgent === undefined ? {} : { parentAgent }),
    concurrency: raw.concurrency as number,
    capabilities,
    integration: schemaValue(integrationSchema, raw.integration, `${label}.integration`),
    status: raw.status as AgentStatus,
    registeredAt: schemaValue(rfc3339Schema, raw.registeredAt, `${label}.registeredAt`),
    changedAt: schemaValue(rfc3339Schema, raw.changedAt, `${label}.changedAt`),
    ...(disconnectedAt === undefined ? {} : { disconnectedAt }),
  };
}

export function parseAgentCatalogState(
  value: unknown,
  project: ProjectId,
): AgentCatalogState {
  const root = plainObject(value, "agent catalog state");
  exactKeys(root, new Set(["placements"]), "agent catalog state");
  const placements = plainObject(root.placements, "placements");
  const parsed: Record<string, AgentPlacementState> = {};
  for (const [key, placement] of Object.entries(placements)) {
    parsed[key] = parsePlacement(placement, key, project);
  }
  for (const placement of Object.values(parsed)) {
    const peers = Object.fromEntries(
      Object.entries(parsed).filter(([, item]) => item !== placement),
    );
    assertLogicalIdentity(peers, {
      id: placement.agent,
      name: placement.name,
      provider: placement.provider,
      role: placement.role,
      ...(placement.parentAgent === undefined
        ? {}
        : { parentAgent: placement.parentAgent }),
      concurrency: placement.concurrency,
      host: placement.host,
      capabilities: [...placement.capabilities],
      integration: placement.integration,
    });
  }
  return { placements: parsed };
}

export function registerAgentCatalogReducer(
  bus: EventBus,
): ReducerHandle<AgentCatalogState> {
  return bus.registerReducer(
    "agent-catalog",
    () => ({ placements: {} }),
    reduceAgentCatalog,
    { version: "1", parseState: parseAgentCatalogState },
  );
}
