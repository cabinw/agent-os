import { describe, expect, it, vi } from "vitest";
import { newEventId, parseStoredEvent } from "../packages/event-core/src/index.js";
import type {
  EventPayload,
  EventType,
  StoredEvent,
} from "../packages/event-core/src/index.js";
import {
  ApprovalGateError,
  ApprovalProjectionError,
  createApprovalGate,
  parseApprovalProjectState,
  reduceApprovalProject,
} from "../packages/mcp-server/src/index.js";
import type {
  ApprovalCommandPort,
  ApprovalOutcome,
  ApprovalScheduler,
  McpCallContext,
  PendingApproval,
} from "../packages/mcp-server/src/index.js";

const PROJECT = "proj_approval" as never;
const APPROVAL = "approval-001" as never;
const AGENT = "codex" as never;
const HUMAN = Object.freeze({ kind: "human" as const, id: "owner" as never });
const REQUEST = Object.freeze({
  action: "Publish release",
  task: "TASK-001" as never,
  risk: "high" as const,
  reversible: true,
  detail: "Publish the signed release candidate.",
});
const CONTEXT: McpCallContext = Object.freeze({
  project: PROJECT,
  principal: Object.freeze({ kind: "agent" as const, id: AGENT }),
  host: "runner-mac" as never,
  clientToken: "approval-command-001",
  causedBy: newEventId(),
});

let sequence = 0;

function approvalEvent<Type extends EventType>(
  type: Type,
  payload: EventPayload<Type>,
  actor: { kind: "agent" | "human" | "system"; id: string },
  approval = APPROVAL,
): StoredEvent<Type> {
  sequence += 1;
  return parseStoredEvent({
    schemaVersion: 1,
    id: newEventId(),
    type,
    seq: sequence,
    project: PROJECT,
    actor,
    subject: { kind: "approval", id: approval },
    at: `2026-08-24T08:${String(sequence).padStart(2, "0")}:00Z`,
    payload,
  }) as StoredEvent<Type>;
}

function requested(approval = APPROVAL): StoredEvent<"approval.requested"> {
  return approvalEvent(
    "approval.requested",
    {
      action: REQUEST.action,
      risk: REQUEST.risk,
      reversible: REQUEST.reversible,
      requestedBy: AGENT,
      task: REQUEST.task,
      detail: REQUEST.detail,
    },
    { kind: "agent", id: AGENT },
    approval,
  );
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class ManualScheduler implements ApprovalScheduler {
  readonly callbacks = new Map<number, () => void>();
  readonly cancelled: number[] = [];
  #next = 1;

  schedule(callback: () => void): number {
    const handle = this.#next;
    this.#next += 1;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: unknown): void {
    const id = handle as number;
    this.cancelled.push(id);
    this.callbacks.delete(id);
  }

  fire(handle = 1): void {
    const callback = this.callbacks.get(handle);
    if (callback === undefined) throw new Error(`timer ${handle} is not active`);
    this.callbacks.delete(handle);
    callback();
  }
}

function gateHarness(overrides: Partial<ApprovalCommandPort> = {}) {
  const scheduler = new ManualScheduler();
  const requests: PendingApproval[] = [];
  const grants: unknown[] = [];
  const rejections: unknown[] = [];
  const expirations: unknown[] = [];
  const commands: ApprovalCommandPort = {
    request: (command) => {
      requests.push(command);
    },
    grant: (command) => {
      grants.push(command);
    },
    reject: (command) => {
      rejections.push(command);
    },
    expire: (command) => {
      expirations.push(command);
    },
    ...overrides,
  };
  const gate = createApprovalGate({
    commands,
    timeoutMs: 5_000,
    scheduler,
    now: () => Date.parse("2026-08-24T08:00:00.000Z"),
    idFactory: () => APPROVAL,
  });
  return { commands, expirations, gate, grants, rejections, requests, scheduler };
}

describe("RM-1.3c · approval projection", () => {
  it("derives pending and each terminal approval state", () => {
    const initial = { approvals: {} };
    const pending = reduceApprovalProject(initial, requested());
    expect(pending.approvals[APPROVAL]).toMatchObject({
      id: APPROVAL,
      project: PROJECT,
      status: "pending",
      requestedBy: AGENT,
      task: REQUEST.task,
    });

    const granted = reduceApprovalProject(
      pending,
      approvalEvent("approval.granted", { by: HUMAN.id, note: "Reviewed" }, HUMAN),
    );
    expect(granted.approvals[APPROVAL]?.decision).toMatchObject({
      status: "granted",
      by: HUMAN.id,
      note: "Reviewed",
    });

    const rejectedPending = reduceApprovalProject(
      initial,
      requested("approval-002" as never),
    );
    const rejected = reduceApprovalProject(
      rejectedPending,
      approvalEvent(
        "approval.rejected",
        { by: HUMAN.id, reason: "Unsafe" },
        HUMAN,
        "approval-002" as never,
      ),
    );
    expect(rejected.approvals["approval-002"]?.status).toBe("rejected");

    const expiredPending = reduceApprovalProject(
      initial,
      requested("approval-003" as never),
    );
    const expired = reduceApprovalProject(
      expiredPending,
      approvalEvent(
        "approval.expired",
        { after: "2026-08-24T08:00:00Z" },
        { kind: "system", id: "approval-timer" },
        "approval-003" as never,
      ),
    );
    expect(expired.approvals["approval-003"]?.status).toBe("expired");
  });

  it("rejects duplicate, missing and second decisions", () => {
    const pending = reduceApprovalProject({ approvals: {} }, requested());
    expect(() => reduceApprovalProject(pending, requested())).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_APPROVAL" }),
    );
    expect(() =>
      reduceApprovalProject(
        { approvals: {} },
        approvalEvent("approval.granted", { by: HUMAN.id }, HUMAN),
      ),
    ).toThrowError(expect.objectContaining({ code: "MISSING_APPROVAL" }));
    const terminal = reduceApprovalProject(
      pending,
      approvalEvent("approval.granted", { by: HUMAN.id }, HUMAN),
    );
    expect(() =>
      reduceApprovalProject(
        terminal,
        approvalEvent("approval.rejected", { by: HUMAN.id, reason: "Too late" }, HUMAN),
      ),
    ).toThrowError(expect.objectContaining({ code: "TERMINAL_APPROVAL" }));
  });

  it("requires the authenticated requesting agent and deciding human", () => {
    expect(() =>
      reduceApprovalProject(
        { approvals: {} },
        approvalEvent(
          "approval.requested",
          {
            action: REQUEST.action,
            risk: REQUEST.risk,
            reversible: true,
            requestedBy: AGENT,
            detail: REQUEST.detail,
          },
          { kind: "agent", id: "forged-agent" },
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ACTOR" }));

    const pending = reduceApprovalProject({ approvals: {} }, requested());
    for (const event of [
      approvalEvent("approval.granted", { by: HUMAN.id }, { kind: "agent", id: AGENT }),
      approvalEvent(
        "approval.rejected",
        { by: HUMAN.id, reason: "No" },
        { kind: "human", id: "different-human" },
      ),
      approvalEvent("approval.expired", { after: "2026-08-24T08:00:00Z" }, HUMAN),
    ]) {
      expect(() => reduceApprovalProject(pending, event)).toThrowError(
        expect.objectContaining({ code: "INVALID_ACTOR" }),
      );
    }
  });

  it("strictly restores a projection snapshot and rejects drift", () => {
    const pending = reduceApprovalProject({ approvals: {} }, requested());
    const terminal = reduceApprovalProject(
      pending,
      approvalEvent("approval.granted", { by: HUMAN.id }, HUMAN),
    );
    expect(parseApprovalProjectState(terminal, PROJECT)).toEqual(terminal);
    expect(() =>
      parseApprovalProjectState({ ...terminal, extra: true }, PROJECT),
    ).toThrow(ApprovalProjectionError);
    expect(() =>
      parseApprovalProjectState(
        {
          approvals: {
            [APPROVAL]: { ...terminal.approvals[APPROVAL], id: "different" },
          },
        },
        PROJECT,
      ),
    ).toThrow(ApprovalProjectionError);
    expect(() =>
      parseApprovalProjectState(
        {
          approvals: {
            [APPROVAL]: {
              ...pending.approvals[APPROVAL],
              decision: { status: "pending" },
            },
          },
        },
        PROJECT,
      ),
    ).toThrow(ApprovalProjectionError);
  });
});

describe("RM-1.3c · blocking Approval Gate", () => {
  it("keeps the caller blocked until a durable human grant", async () => {
    const durable = deferred();
    const { gate, grants, requests } = gateHarness({
      grant: async (command) => {
        grants.push(command);
        await durable.promise;
      },
    });
    let outcome: ApprovalOutcome | undefined;
    const waiting = gate.request(REQUEST, CONTEXT).then((value) => {
      outcome = value;
      return value;
    });
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      approval: APPROVAL,
      project: PROJECT,
      requestedBy: AGENT,
      deadline: "2026-08-24T08:00:05.000Z",
    });
    expect(gate.pending()).toHaveLength(1);
    expect(outcome).toBeUndefined();

    const granting = gate.grant(APPROVAL, HUMAN, "Reviewed");
    await flush();
    expect(grants).toHaveLength(1);
    expect(outcome).toBeUndefined();
    durable.resolve();
    await granting;
    await expect(waiting).resolves.toEqual({
      approval: APPROVAL,
      status: "granted",
      by: HUMAN.id,
      note: "Reviewed",
    });
    expect(gate.pending()).toEqual([]);
  });

  it("durably rejects with a reason and never grants", async () => {
    const { gate, grants, rejections } = gateHarness();
    const waiting = gate.request(REQUEST, CONTEXT);
    await flush();
    await gate.reject(APPROVAL, HUMAN, "Release window closed");
    await expect(waiting).resolves.toMatchObject({
      status: "rejected",
      reason: "Release window closed",
    });
    expect(rejections).toHaveLength(1);
    expect(grants).toEqual([]);
    await expect(gate.reject(APPROVAL, HUMAN, "Again")).rejects.toMatchObject({
      code: "NOT_PENDING",
    });
  });

  it("expires on timeout without grant, reject or task unblock authority", async () => {
    const { expirations, gate, grants, rejections, scheduler } = gateHarness();
    const waiting = gate.request(REQUEST, CONTEXT);
    await flush();
    scheduler.fire();
    await expect(waiting).resolves.toEqual({
      approval: APPROVAL,
      status: "expired",
      after: "2026-08-24T08:00:05.000Z",
    });
    expect(expirations).toEqual([
      {
        approval: APPROVAL,
        project: PROJECT,
        task: REQUEST.task,
        after: "2026-08-24T08:00:05.000Z",
      },
    ]);
    expect(grants).toEqual([]);
    expect(rejections).toEqual([]);
  });

  it("linearizes a human decision against timeout", async () => {
    const durable = deferred();
    const { expirations, gate, scheduler } = gateHarness({
      grant: async () => durable.promise,
    });
    const waiting = gate.request(REQUEST, CONTEXT);
    await flush();
    const granting = gate.grant(APPROVAL, HUMAN);
    await flush();
    scheduler.fire();
    await flush();
    expect(expirations).toEqual([]);
    durable.resolve();
    await granting;
    await expect(waiting).resolves.toMatchObject({ status: "granted" });
  });

  it("admits only one simultaneous terminal decision", async () => {
    const durable = deferred();
    const { gate, rejections } = gateHarness({ grant: async () => durable.promise });
    const waiting = gate.request(REQUEST, CONTEXT);
    await flush();
    const granting = gate.grant(APPROVAL, HUMAN);
    await flush();
    await expect(
      gate.reject(APPROVAL, HUMAN, "Competing decision"),
    ).rejects.toMatchObject({
      code: "RESOLUTION_IN_PROGRESS",
    });
    expect(rejections).toEqual([]);
    durable.resolve();
    await granting;
    await waiting;
  });

  it("remains pending after a command failure and permits a safe retry", async () => {
    let attempt = 0;
    const { gate } = gateHarness({
      grant: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("event group append failed");
      },
    });
    const waiting = gate.request(REQUEST, CONTEXT);
    await flush();
    await expect(gate.grant(APPROVAL, HUMAN)).rejects.toThrow("append failed");
    expect(gate.pending()).toHaveLength(1);
    await gate.grant(APPROVAL, HUMAN);
    await expect(waiting).resolves.toMatchObject({ status: "granted" });
  });

  it("fails closed on close and on request admission failure", async () => {
    const first = gateHarness();
    const waiting = first.gate.request(REQUEST, CONTEXT);
    await flush();
    first.gate.close();
    await expect(waiting).rejects.toMatchObject({ code: "CLOSED" });
    expect(first.grants).toEqual([]);
    expect(first.rejections).toEqual([]);
    expect(first.expirations).toEqual([]);

    const second = gateHarness({
      request: () => {
        throw new Error("atomic admission failed");
      },
    });
    await expect(second.gate.request(REQUEST, CONTEXT)).rejects.toThrow(
      "atomic admission failed",
    );
    expect(second.gate.pending()).toEqual([]);
  });

  it("closes safely while durable request admission is still in flight", async () => {
    const admission = deferred();
    const { gate, grants } = gateHarness({ request: async () => admission.promise });
    const waiting = gate.request(REQUEST, CONTEXT);
    await flush();
    gate.close();
    admission.resolve();
    await expect(waiting).rejects.toMatchObject({ code: "CLOSED" });
    expect(grants).toEqual([]);
    expect(gate.pending()).toEqual([]);
  });

  it("rejects agent decisions, malformed options and duplicate ids", async () => {
    expect(() => createApprovalGate({ commands: {} as never, timeoutMs: 0 })).toThrow(
      ApprovalGateError,
    );
    const { gate } = gateHarness();
    const waiting = gate.request(REQUEST, CONTEXT);
    await flush();
    await expect(
      gate.grant(APPROVAL, { kind: "agent", id: AGENT } as never),
    ).rejects.toMatchObject({ code: "INVALID_HUMAN" });
    await expect(gate.request(REQUEST, CONTEXT)).rejects.toMatchObject({
      code: "DUPLICATE_APPROVAL",
    });
    gate.close();
    await expect(waiting).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("uses a prompt only as an untrusted human-decision adapter", async () => {
    const scheduler = new ManualScheduler();
    const grant = vi.fn();
    const gate = createApprovalGate({
      commands: { request: vi.fn(), grant, reject: vi.fn(), expire: vi.fn() },
      timeoutMs: 5_000,
      scheduler,
      now: () => Date.parse("2026-08-24T08:00:00.000Z"),
      idFactory: () => APPROVAL,
      prompt: async () => ({ status: "granted", human: HUMAN, note: "CLI owner" }),
    });
    await expect(gate.request(REQUEST, CONTEXT)).resolves.toMatchObject({
      status: "granted",
      by: HUMAN.id,
    });
    expect(grant).toHaveBeenCalledOnce();
  });

  it("reports a prompt failure and leaves timeout authority intact", async () => {
    const scheduler = new ManualScheduler();
    const onError = vi.fn();
    const expire = vi.fn();
    const gate = createApprovalGate({
      commands: { request: vi.fn(), grant: vi.fn(), reject: vi.fn(), expire },
      timeoutMs: 5_000,
      scheduler,
      now: () => Date.parse("2026-08-24T08:00:00.000Z"),
      idFactory: () => APPROVAL,
      prompt: async () => {
        throw new Error("CLI unavailable");
      },
      onError,
    });
    const waiting = gate.request(REQUEST, CONTEXT);
    await flush();
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(gate.pending()).toHaveLength(1);
    scheduler.fire();
    await expect(waiting).resolves.toMatchObject({ status: "expired" });
    expect(expire).toHaveBeenCalledOnce();
  });

  it("rejects invalid clocks before admitting a durable request", async () => {
    const request = vi.fn();
    const gate = createApprovalGate({
      commands: { request, grant: vi.fn(), reject: vi.fn(), expire: vi.fn() },
      timeoutMs: 5_000,
      scheduler: new ManualScheduler(),
      now: () => Number.MAX_SAFE_INTEGER,
      idFactory: () => APPROVAL,
    });
    await expect(gate.request(REQUEST, CONTEXT)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
    expect(request).not.toHaveBeenCalled();
  });
});
