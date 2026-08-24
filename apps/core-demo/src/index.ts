import { createAgentClient, parseRunnerDispatchRequest } from "@agent-os/agent-sdk";
import type {
  AdapterResult,
  AgentClient,
  AgentToolName,
  AgentToolTransport,
  Runner,
  RunnerDispatchRequest,
  RunnerEvent,
} from "@agent-os/agent-sdk";
import { createEventBus, newEventId } from "@agent-os/event-core";
import type {
  Actor,
  EntityId,
  EventAppendGroupEntry,
  EventAppendInput,
  EventId,
  EventInput,
  EventPayload,
  EventType,
  ProjectId,
  StoredEvent,
  TaskId,
} from "@agent-os/event-core";
import { openSqliteEventStore } from "@agent-os/event-store-sqlite";
import {
  buildTaskContext,
  createApprovalGate,
  createMcpToolRouter,
  registerApprovalReducer,
} from "@agent-os/mcp-server";
import type {
  ApprovalCommandPort,
  AuthorizationPort,
  McpCallContext,
  RuntimePort,
  ToolInputMap,
} from "@agent-os/mcp-server";
import {
  queryMemory as readMemory,
  registerKnowledgeReducer,
} from "@agent-os/memory-core";
import { createSupervisorPlanner } from "@agent-os/supervisor";
import type {
  SupervisorAdmissionCommand,
  SupervisorAdmissionPort,
} from "@agent-os/supervisor";
import {
  agentPlacementKey,
  registerAgentCatalogReducer,
  registerConversationReducer,
  registerTaskReducer,
  selectAgentPlacement,
} from "@agent-os/task-engine";
import type { LivePlacement } from "@agent-os/task-engine";

const PROJECT = "proj_phase1_demo" as ProjectId;
const GOAL = "GOAL-001" as EntityId;
const TASK = "TASK-001" as TaskId;
const SUPERVISOR = "supervisor" as EntityId;
const WORKER = "worker" as EntityId;
const HUMAN = "owner" as EntityId;
const HOST = "demo-host" as EntityId;
const APPROVAL = "approval-001" as EntityId;
const INTEGRATION = Object.freeze({
  participates: true,
  streaming: true,
  reasoning: false,
  session: true,
  usage: false,
});

export type CoreDemoOptions = Readonly<{ databasePath: string }>;

export type CoreDemoEvidence = Readonly<{
  project: ProjectId;
  task: TaskId;
  executor: EntityId;
  approval: EntityId;
  eventTypes: readonly EventType[];
  eventCount: number;
  taskStatus: "completed";
  taskProgress: 100;
  approvalStatus: "granted";
  liveEqualsReplay: true;
  runnerEvents: readonly RunnerEvent["kind"][];
}>;

type FixedTransport = Readonly<{
  client: AgentClient;
  setCause(cause: EventId): void;
}>;

function neverTool(name: string): never {
  throw new Error(`core demo does not invoke ${name}`);
}

function snapshot(value: unknown): string {
  return JSON.stringify(value);
}

export async function runCoreDemo(options: CoreDemoOptions): Promise<CoreDemoEvidence> {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.databasePath !== "string" ||
    options.databasePath.length === 0
  ) {
    throw new TypeError("core demo requires an absolute databasePath");
  }

  let clock = Date.parse("2026-08-24T12:00:00.000Z");
  const store = openSqliteEventStore({
    path: options.databasePath,
    now: () => {
      const value = new Date(clock);
      clock += 1_000;
      return value;
    },
  });
  const bus = createEventBus({ store });
  const tasks = registerTaskReducer(bus);
  const catalog = registerAgentCatalogReducer(bus);
  const approvals = registerApprovalReducer(bus);
  const conversations = registerConversationReducer(bus);
  const memory = registerKnowledgeReducer(bus);
  const observed: StoredEvent[] = [];
  bus.subscribe(
    (event) => {
      observed.push(event);
    },
    { project: PROJECT },
  );
  let token = 0;
  let knowledge = 0;
  let approvalCause: EventId | undefined;
  const approvalRequests = new Map<EntityId, EventId>();

  const append = <Type extends EventType>(
    input: EventInput<Type>,
    label: string,
  ): StoredEvent<Type> => {
    token += 1;
    return bus.append(input as EventAppendInput<Type>, {
      token: `demo:${String(token).padStart(3, "0")}:${label}`,
    });
  };

  const goalEvent = append(
    {
      type: "message.sent",
      project: PROJECT,
      actor: { kind: "human", id: HUMAN },
      subject: { kind: "project", id: PROJECT },
      payload: {
        from: HUMAN,
        to: SUPERVISOR,
        type: "instruction",
        content: "Build and verify the Phase 1 event loop",
      },
    },
    "goal",
  );

  const livePlacements = (): readonly LivePlacement[] =>
    Object.values(catalog.get(PROJECT).placements).map((placement) => ({
      agent: placement.agent,
      host: placement.host,
      accepting: placement.disconnectedAt === undefined,
      active: 0,
    }));

  const approvalCommands: ApprovalCommandPort = {
    request: (command) => {
      const event = append(
        {
          type: "approval.requested",
          project: command.project,
          actor: { kind: "agent", id: command.requestedBy },
          subject: { kind: "approval", id: command.approval },
          ...(approvalCause === undefined ? {} : { causedBy: approvalCause }),
          payload: {
            action: command.action,
            risk: command.risk,
            reversible: command.reversible,
            requestedBy: command.requestedBy,
            ...(command.task === undefined ? {} : { task: command.task }),
            detail: command.detail,
          },
        },
        "approval-request",
      );
      approvalRequests.set(command.approval, event.id);
    },
    grant: (command) => {
      append(
        {
          type: "approval.granted",
          project: command.project,
          actor: command.human,
          subject: { kind: "approval", id: command.approval },
          causedBy: approvalRequests.get(command.approval) as EventId,
          payload: {
            by: command.human.id,
            ...(command.note === undefined ? {} : { note: command.note }),
          },
        },
        "approval-grant",
      );
    },
    reject: () => neverTool("approval rejection"),
    expire: () => neverTool("approval expiration"),
  };
  const gate = createApprovalGate({
    commands: approvalCommands,
    timeoutMs: 60_000,
    now: () => Date.parse("2026-08-24T12:00:00.000Z"),
    idFactory: () => APPROVAL,
  });

  const authorization: AuthorizationPort = {
    isRegistered: (context) =>
      catalog.get(context.project).placements[
        agentPlacementKey(context.principal.id, context.host)
      ] !== undefined,
    task: (project, task) => {
      const value = tasks.get(project).tasks[task];
      return value === undefined
        ? null
        : {
            owner: value.owner as EntityId,
            ...(value.executor === undefined
              ? {}
              : { executor: value.executor as EntityId }),
          };
    },
  };

  const runtime: RuntimePort = {
    registerAgent: (input, context) =>
      append(
        {
          type: "agent.registered",
          project: context.project,
          actor: context.principal,
          subject: { kind: "agent", id: input.id },
          ...(context.causedBy === undefined ? {} : { causedBy: context.causedBy }),
          payload: {
            id: input.id,
            name: input.name,
            provider: input.provider,
            role: input.role,
            concurrency: input.concurrency,
            host: context.host,
            capabilities: input.capabilities,
            integration: INTEGRATION,
          },
        },
        `register-${input.id}`,
      ),
    findAgent: (input, context) =>
      selectAgentPlacement(
        catalog.get(context.project),
        tasks.get(context.project),
        livePlacements(),
        input.capabilities,
      ),
    createTask: (input, context) =>
      append(
        {
          type: "task.created",
          project: context.project,
          actor: context.principal,
          subject: { kind: "task", id: TASK },
          ...(context.causedBy === undefined ? {} : { causedBy: context.causedBy }),
          payload: input,
        },
        "create-task",
      ),
    assignTask: (input, context) => {
      const task = tasks.get(context.project).tasks[input.task];
      if (task === undefined) throw new Error(`missing task ${input.task}`);
      const selected =
        input.executor === undefined
          ? selectAgentPlacement(
              catalog.get(context.project),
              tasks.get(context.project),
              livePlacements(),
              task.requires,
            )
          : null;
      const executor =
        input.executor ??
        (selected?.matched === true ? selected.candidate.agent : undefined);
      if (executor === undefined) throw new Error("no capable demo executor");
      return append(
        {
          type: "task.assigned",
          project: context.project,
          actor: context.principal,
          subject: { kind: "task", id: input.task },
          ...(context.causedBy === undefined ? {} : { causedBy: context.causedBy }),
          payload: {
            executor,
            matchedBy: input.executor === undefined ? "capability" : "explicit",
          },
        },
        "assign-task",
      );
    },
    updateTask: (input, context) =>
      append(
        {
          type: "task.progress.updated",
          project: context.project,
          actor: context.principal,
          subject: { kind: "task", id: input.task },
          ...(context.causedBy === undefined ? {} : { causedBy: context.causedBy }),
          payload: {
            progress: input.progress,
            ...(input.note === undefined ? {} : { note: input.note }),
          },
        },
        `progress-${input.progress}`,
      ),
    sendMessage: (input, context) =>
      append(
        {
          type: "message.sent",
          project: context.project,
          actor: context.principal,
          subject:
            input.task === undefined
              ? { kind: "project", id: context.project }
              : { kind: "task", id: input.task },
          ...(context.causedBy === undefined ? {} : { causedBy: context.causedBy }),
          payload: input,
        },
        "message",
      ),
    notifyBlocked: (input, context) =>
      append(
        {
          type: "task.blocked",
          project: context.project,
          actor: context.principal,
          subject: { kind: "task", id: input.task },
          ...(context.causedBy === undefined ? {} : { causedBy: context.causedBy }),
          payload: {
            reason: input.reason,
            severity: input.severity,
            needs: input.needs,
          },
        },
        "blocked",
      ),
    reportResult: (input, context) =>
      input.status === "completed"
        ? append(
            {
              type: "task.review.requested",
              project: context.project,
              actor: context.principal,
              subject: { kind: "task", id: input.task },
              ...(context.causedBy === undefined ? {} : { causedBy: context.causedBy }),
              payload: { summary: input.summary, outputs: input.outputs ?? [] },
            },
            "result-review",
          )
        : append(
            {
              type: "task.failed",
              project: context.project,
              actor: context.principal,
              subject: { kind: "task", id: input.task },
              ...(context.causedBy === undefined ? {} : { causedBy: context.causedBy }),
              payload: { reason: input.summary, attempts: 1 },
            },
            "result-failed",
          ),
    requestApproval: (input, context) => {
      approvalCause = context.causedBy;
      return gate.request(input, context);
    },
    getContext: (input, context) =>
      buildTaskContext({
        project: context.project,
        request: input,
        tasks: tasks.get(context.project),
        memory: memory.get(context.project),
      }),
    writeMemory: (input, context) => {
      if (context.causedBy === undefined) throw new Error("memory requires a cause");
      knowledge += 1;
      return append(
        {
          type: "knowledge.created",
          project: context.project,
          actor: context.principal,
          subject: {
            kind: "knowledge",
            id: `KN-${String(knowledge).padStart(3, "0")}` as EntityId,
          },
          causedBy: context.causedBy,
          payload: {
            ...input,
            sourceEvents: [context.causedBy],
          },
        },
        "memory",
      );
    },
    queryMemory: (input, context) =>
      readMemory({
        project: context.project,
        state: memory.get(context.project),
        query: input,
      }),
    openNegotiation: () => neverTool("negotiation opening"),
    objectNegotiation: () => neverTool("negotiation objection"),
    escalateNegotiation: () => neverTool("negotiation escalation"),
    resolveNegotiation: () => neverTool("negotiation resolution"),
  };
  const router = createMcpToolRouter(runtime, authorization);

  const transport = (agent: EntityId): FixedTransport => {
    let cause = goalEvent.id;
    let calls = 0;
    const toolTransport: AgentToolTransport = {
      call: (tool: AgentToolName, input: unknown) => {
        calls += 1;
        const context: McpCallContext = {
          project: PROJECT,
          principal: { kind: "agent", id: agent },
          host: HOST,
          clientToken: `${agent}:${calls}:${tool}`,
          causedBy: cause,
        };
        return router.call(tool, input, context);
      },
    };
    return {
      client: createAgentClient(toolTransport),
      setCause: (value) => {
        cause = value;
      },
    };
  };
  const supervisorClient = transport(SUPERVISOR);
  const workerClient = transport(WORKER);
  await supervisorClient.client.register({
    id: SUPERVISOR,
    name: "Supervisor",
    provider: "scripted",
    role: "supervisor",
    capabilities: ["architecture", "ops"],
    concurrency: 1,
  });
  await workerClient.client.register({
    id: WORKER,
    name: "Worker",
    provider: "scripted",
    role: "developer",
    capabilities: ["coding", "testing"],
    concurrency: 1,
  });

  const admission: SupervisorAdmissionPort = {
    currentTasks: (project) => tasks.get(project),
    admit: (command: SupervisorAdmissionCommand) => {
      const group: EventAppendGroupEntry[] = command.tasks.map((task) => ({
        input: {
          type: "task.created",
          project: command.project,
          actor: { kind: "agent", id: SUPERVISOR },
          subject: { kind: "task", id: task.id },
          causedBy: command.causedBy,
          payload: {
            title: task.title,
            goal: task.goal,
            ...(task.description === undefined ? {} : { description: task.description }),
            requires: task.requires,
            priority: task.priority,
            dependsOn: task.dependsOn,
            requiresApproval: task.requiresApproval,
          },
        } as EventAppendInput<"task.created">,
        options: { token: `${command.operationToken}:task:${task.id}` },
      }));
      for (const [index, decision] of command.decisions.entries()) {
        knowledge += 1;
        group.push({
          input: {
            type: "knowledge.created",
            project: command.project,
            actor: { kind: "agent", id: SUPERVISOR },
            subject: {
              kind: "knowledge",
              id: `KN-${String(knowledge).padStart(3, "0")}` as EntityId,
            },
            causedBy: command.causedBy,
            payload: {
              type: "decision",
              title: decision.title,
              summary: decision.summary,
              rationale: decision.rationale,
              alternatives: decision.alternatives,
              relatedTasks: decision.relatedTasks,
              sourceEvents: decision.sourceEvents,
            },
          } as EventAppendInput<"knowledge.created">,
          options: { token: `${command.operationToken}:decision:${index}` },
        });
      }
      bus.appendGroup(group);
    },
  };
  const planner = createSupervisorPlanner({
    model: {
      plan: () => ({
        summary: "Build one verified task",
        tasks: [
          {
            key: "implement-loop",
            title: "Implement the formal Phase 1 loop",
            requires: ["coding", "testing"],
            priority: "high",
            dependsOn: [],
            requiresApproval: true,
          },
        ],
        decisions: [
          {
            key: "execution-mode",
            title: "Use deterministic scripted execution",
            summary: "Keep the acceptance path reproducible",
            rationale: "A canonical gate cannot depend on vendor or network variance",
            alternatives: ["real vendor CLI", "scripted formal Runner"],
            affects: ["implement-loop"],
          },
        ],
      }),
    },
    admission,
    taskIdFactory: () => TASK,
  });
  const plan = await planner.plan({
    project: PROJECT,
    goal: GOAL,
    title: "Prove the formal core loop",
    detail: "Route and complete one task using only formal package contracts",
    constraints: ["offline", "event-log acceptance"],
    causedBy: goalEvent.id,
    operationToken: "phase1-demo-plan",
  });

  supervisorClient.setCause(observed.at(-1)?.id as EventId);
  const assigned = (await supervisorClient.client.call("assign_task", {
    task: plan.tasks[0]?.id,
  })) as StoredEvent<"task.assigned">;
  const executor = assigned.payload.executor;
  if (executor !== WORKER || assigned.payload.matchedBy !== "capability") {
    throw new Error("demo capability routing selected the wrong executor");
  }
  const started = append(
    {
      type: "task.started",
      project: PROJECT,
      actor: { kind: "agent", id: WORKER },
      subject: { kind: "task", id: TASK },
      causedBy: assigned.id,
      payload: { executor: WORKER },
    },
    "task-started",
  );
  workerClient.setCause(started.id);

  const runnerEvents: RunnerEvent[] = [];
  const runner: Runner = {
    dispatch: async (requestValue, dispatchOptions) => {
      const request = parseRunnerDispatchRequest(requestValue);
      dispatchOptions?.onEvent?.({
        requestId: request.requestId,
        sequence: 1,
        kind: "started",
        fresh: true,
      });
      const progress = (await workerClient.client.reportProgress({
        task: request.taskId,
        progress: 40,
        note: "Core loop running",
      })) as StoredEvent<"task.progress.updated">;
      workerClient.setCause(progress.id);
      await workerClient.client.requestApproval({
        task: request.taskId,
        action: "Accept deterministic fixture output",
        risk: "high",
        reversible: true,
        detail: "Allows the demo worker to submit its result",
      });
      const granted = [...observed]
        .reverse()
        .find((event) => event.type === "approval.granted");
      workerClient.setCause(granted?.id as EventId);
      const completeProgress = (await workerClient.client.reportProgress({
        task: request.taskId,
        progress: 100,
        note: "Core loop complete",
      })) as StoredEvent<"task.progress.updated">;
      workerClient.setCause(completeProgress.id);
      const review = (await workerClient.client.reportResult({
        task: request.taskId,
        status: "completed",
        summary: "Formal Phase 1 loop completed",
        outputs: ["event-log"],
      })) as StoredEvent<"task.review.requested">;
      const result: AdapterResult = {
        text: "Formal Phase 1 loop completed",
        sessionId: "demo-session",
        durationMs: 1,
        fresh: true,
      };
      dispatchOptions?.onEvent?.({
        requestId: request.requestId,
        sequence: 2,
        kind: "completed",
        result,
      });
      workerClient.setCause(review.id);
      return result;
    },
    cancel: async () => "already_terminal",
    health: () => ({
      accepting: true,
      active: 0,
      adapters: [
        {
          id: "scripted",
          label: "Deterministic core demo",
          integration: INTEGRATION,
        },
      ],
    }),
    hasSession: () => true,
    resetSession: async () => {},
    close: async () => {},
  };
  const dispatchRequest: RunnerDispatchRequest = {
    requestId: "demo-request" as never,
    user: HUMAN,
    project: PROJECT,
    agent: WORKER as never,
    adapter: "scripted",
    workspace: "/demo",
    prompt: "Execute the formal Phase 1 task",
    taskId: TASK,
    causedBy: started.id,
  };
  const dispatch = runner.dispatch(dispatchRequest, {
    onEvent: (event) => runnerEvents.push(event),
  });
  for (let attempt = 0; attempt < 100 && gate.pending().length === 0; attempt += 1) {
    await Promise.resolve();
  }
  const pending = gate.pending()[0];
  if (pending === undefined) throw new Error("demo approval did not become pending");
  await gate.grant(pending.approval, { kind: "human", id: HUMAN }, "Reviewed");
  await dispatch;

  const beforeAccept = tasks.get(PROJECT).tasks[TASK];
  const approval = approvals.get(PROJECT).approvals[APPROVAL];
  if (beforeAccept?.status !== "review" || approval?.status !== "granted") {
    throw new Error("demo cannot accept before review and approval grant");
  }
  const reviewEvent = [...observed]
    .reverse()
    .find((event) => event.type === "task.review.requested");
  append(
    {
      type: "task.completed",
      project: PROJECT,
      actor: { kind: "human", id: HUMAN },
      subject: { kind: "task", id: TASK },
      causedBy: reviewEvent?.id as EventId,
      payload: { acceptedBy: HUMAN },
    },
    "human-accept",
  );

  const live = {
    tasks: tasks.get(PROJECT),
    catalog: catalog.get(PROJECT),
    approvals: approvals.get(PROJECT),
    conversations: conversations.get(PROJECT),
  };
  const replayBus = createEventBus({ store });
  const replayTasks = registerTaskReducer(replayBus);
  const replayCatalog = registerAgentCatalogReducer(replayBus);
  const replayApprovals = registerApprovalReducer(replayBus);
  const replayConversations = registerConversationReducer(replayBus);
  replayBus.replay(PROJECT);
  const replayed = {
    tasks: replayTasks.get(PROJECT),
    catalog: replayCatalog.get(PROJECT),
    approvals: replayApprovals.get(PROJECT),
    conversations: replayConversations.get(PROJECT),
  };
  const liveEqualsReplay = snapshot(live) === snapshot(replayed);
  const finalTask = live.tasks.tasks[TASK];
  const finalApproval = live.approvals.approvals[APPROVAL];
  const eventTypes = observed.map((event) => event.type);
  const expectedTypes: readonly EventType[] = [
    "message.sent",
    "agent.registered",
    "agent.registered",
    "task.created",
    "knowledge.created",
    "task.assigned",
    "task.started",
    "task.progress.updated",
    "approval.requested",
    "approval.granted",
    "task.progress.updated",
    "task.review.requested",
    "task.completed",
  ];
  if (
    snapshot(eventTypes) !== snapshot(expectedTypes) ||
    finalTask?.status !== "completed" ||
    finalTask.progress !== 100 ||
    finalTask.executor !== WORKER ||
    finalApproval?.status !== "granted" ||
    !liveEqualsReplay
  ) {
    throw new Error("core demo acceptance evidence is incomplete");
  }

  gate.close();
  supervisorClient.client.close();
  workerClient.client.close();
  await runner.close();
  store.close();
  return Object.freeze({
    project: PROJECT,
    task: TASK,
    executor: WORKER,
    approval: APPROVAL,
    eventTypes: Object.freeze(eventTypes),
    eventCount: eventTypes.length,
    taskStatus: "completed",
    taskProgress: 100,
    approvalStatus: "granted",
    liveEqualsReplay: true,
    runnerEvents: Object.freeze(runnerEvents.map((event) => event.kind)),
  });
}
