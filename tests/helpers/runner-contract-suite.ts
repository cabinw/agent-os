import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import {
  RUNNER_CANCEL_OUTCOMES,
  RUNNER_ERROR_CODES,
  RUNNER_EVENT_KINDS,
  RUNNER_INTERFACE_METHODS,
  RUNNER_RETRYABLE_ERROR_CODES,
  RunnerDispatchError,
} from "../../apps/chat-spike/src/runners/contract.mjs";

export type RunnerScope = {
  user: string;
  project: string;
  agent: string;
};

export type RunnerRequest = RunnerScope & {
  requestId: string;
  adapter: string;
  workspace: string;
  prompt: string;
  taskId?: string;
  causedBy?: string;
  model?: string;
};

export type RunnerResult = {
  requestId: string;
  text: string;
  sessionId: string | null;
  ms: number;
  fresh: boolean;
};

export type RunnerContractError = {
  requestId: string;
  code: string;
  message: string;
  retryable: boolean;
};

export type RunnerEvent = {
  requestId: string;
  sequence: number;
  at: string;
  kind: string;
  fresh?: boolean;
  text?: string;
  label?: string;
  input?: number;
  output?: number;
  total?: number;
  result?: RunnerResult;
  error?: RunnerContractError;
};

export type RunnerCancelResult = {
  requestId: string;
  outcome: "cancelled" | "not_found" | "already_terminal";
};

export type RunnerHealth = {
  ready: boolean;
  hostId: string;
  inflight: number;
  queued: number;
};

/** The exact public surface a future RemoteRunner must satisfy. */
export type RunnerUnderContract = {
  dispatch(
    value: unknown,
    options?: { onEvent?: (event: RunnerEvent) => void },
  ): Promise<RunnerResult>;
  cancel(requestId: string): Promise<RunnerCancelResult>;
  health(): RunnerHealth | Promise<RunnerHealth>;
  hasSession(scope: RunnerScope): boolean | Promise<boolean>;
  resetSession(scope: RunnerScope): void | Promise<void>;
  close(): void | Promise<void>;
};

export type RunnerContractHarness = {
  runner: RunnerUnderContract;
  request(overrides?: Partial<RunnerRequest>): RunnerRequest;
  executionCount(): number;
  waitForBlockedExecution(): Promise<void>;
  releaseBlockedExecution(): void;
  cancellationCount(): number;
  restartRunner(): Promise<void>;
  hostId: string;
  dispose?(): void | Promise<void>;
};

export type RunnerContractFactory =
  | (() => RunnerContractHarness)
  | (() => Promise<RunnerContractHarness>);

const REQUIRED_REQUEST_FIELDS = [
  "requestId",
  "user",
  "project",
  "agent",
  "adapter",
  "workspace",
  "prompt",
] as const;

const SORTED_RESULT_FIELDS = ["fresh", "ms", "requestId", "sessionId", "text"];
const SORTED_ERROR_FIELDS = ["code", "message", "requestId", "retryable"];

function sortedKeys(value: object) {
  return Object.keys(value).sort();
}

function scopeOf(request: RunnerRequest): RunnerScope {
  return {
    user: request.user,
    project: request.project,
    agent: request.agent,
  };
}

async function rejectedDispatch(
  runner: RunnerUnderContract,
  value: unknown,
  events: RunnerEvent[] = [],
) {
  let caught: unknown;
  try {
    await runner.dispatch(value, { onEvent: (event) => events.push(event) });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RunnerDispatchError);
  return caught as Error & { error: RunnerContractError };
}

/**
 * Register one transport-neutral suite. A RemoteRunner joins by supplying the
 * same harness factory; none of these assertions know whether execution is in
 * this process, another process, or another host.
 */
export function defineRunnerContractSuite(
  implementation: string,
  createHarness: RunnerContractFactory,
) {
  describe(`${implementation} · shared Runner contract`, () => {
    const live = new Set<RunnerContractHarness>();

    async function harness() {
      const created = await createHarness();
      live.add(created);
      return created;
    }

    afterEach(async () => {
      for (const entry of live) {
        if (entry.dispose) await entry.dispose();
        else await entry.runner.close();
      }
      live.clear();
    });

    it("暴露 Local / Remote 共用的最小接口", async () => {
      const { runner } = await harness();
      const surface = runner as unknown as Record<string, unknown>;

      expect(RUNNER_INTERFACE_METHODS).toEqual([
        "dispatch",
        "cancel",
        "health",
        "hasSession",
        "resetSession",
        "close",
      ]);
      for (const method of RUNNER_INTERFACE_METHODS) {
        expect(surface[method], `${implementation}.${method}`).toBeTypeOf("function");
      }
    });

    it.each(REQUIRED_REQUEST_FIELDS)("拒绝缺失的 request.%s", async (field) => {
      const fixture = await harness();
      const invalid = { ...fixture.request() } as Record<string, unknown>;
      delete invalid[field];

      const failure = await rejectedDispatch(fixture.runner, invalid);

      expect(failure.error).toMatchObject({
        code: RUNNER_ERROR_CODES.INVALID_REQUEST,
        retryable: false,
      });
      expect(sortedKeys(failure.error)).toEqual(SORTED_ERROR_FIELDS);
      expect(fixture.executionCount()).toBe(0);
    });

    it("拒绝 unknown request 字段且不接触执行端", async () => {
      const fixture = await harness();
      const invalid = { ...fixture.request(), providerSecret: "must-not-cross" };

      const failure = await rejectedDispatch(fixture.runner, invalid);

      expect(failure.error).toEqual({
        requestId: invalid.requestId,
        code: RUNNER_ERROR_CODES.INVALID_REQUEST,
        message: expect.stringContaining("providerSecret"),
        retryable: false,
      });
      expect(fixture.executionCount()).toBe(0);
    });

    it("只产生规范 vocabulary、连续 sequence 与严格 result shape", async () => {
      const fixture = await harness();
      const value = fixture.request({ requestId: "contract-events", prompt: "events" });
      const events: RunnerEvent[] = [];

      const result = await fixture.runner.dispatch(value, {
        onEvent: (event) => events.push(event),
      });

      expect(sortedKeys(result)).toEqual(SORTED_RESULT_FIELDS);
      expect(result).toMatchObject({
        requestId: value.requestId,
        text: "contract-result",
        sessionId: "contract-session",
        ms: 7,
        fresh: true,
      });
      expect(events.map((event) => event.kind)).toEqual([
        "started",
        "delta",
        "thought",
        "progress",
        "usage",
        "completed",
      ]);
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(
        events.every(
          (event) =>
            event.requestId === value.requestId &&
            RUNNER_EVENT_KINDS.includes(event.kind) &&
            Number.isFinite(Date.parse(event.at)),
        ),
      ).toBe(true);
      expect(events[0]).toEqual({
        requestId: value.requestId,
        sequence: 1,
        at: expect.any(String),
        kind: "started",
        fresh: true,
      });
      expect(events[1]).toEqual({
        requestId: value.requestId,
        sequence: 2,
        at: expect.any(String),
        kind: "delta",
        text: "answer chunk",
      });
      expect(events[2]).toEqual({
        requestId: value.requestId,
        sequence: 3,
        at: expect.any(String),
        kind: "thought",
        text: "reasoning chunk",
      });
      expect(events[3]).toEqual({
        requestId: value.requestId,
        sequence: 4,
        at: expect.any(String),
        kind: "progress",
        label: "vendor stage",
      });
      expect(events[4]).toEqual({
        requestId: value.requestId,
        sequence: 5,
        at: expect.any(String),
        kind: "usage",
        input: 3,
        output: 5,
        total: 8,
      });
      expect(events[5]).toEqual({
        requestId: value.requestId,
        sequence: 6,
        at: expect.any(String),
        kind: "completed",
        result,
      });
    });

    it("用稳定 error shape 区分可重试执行失败和不可重试契约失败", async () => {
      const fixture = await harness();
      const adapterEvents: RunnerEvent[] = [];
      const adapterFailure = await rejectedDispatch(
        fixture.runner,
        fixture.request({ requestId: "contract-adapter-fail", prompt: "fail" }),
        adapterEvents,
      );

      expect(sortedKeys(adapterFailure.error)).toEqual(SORTED_ERROR_FIELDS);
      expect(adapterFailure.error).toEqual({
        requestId: "contract-adapter-fail",
        code: RUNNER_ERROR_CODES.ADAPTER_FAILURE,
        message: expect.stringContaining("contract adapter failure"),
        retryable: false,
      });
      expect(adapterEvents.map((event) => event.kind)).toEqual(["started", "failed"]);
      expect(adapterEvents[1]?.error).toEqual(adapterFailure.error);

      const resultEvents: RunnerEvent[] = [];
      const invalidResult = await rejectedDispatch(
        fixture.runner,
        fixture.request({ requestId: "contract-result-fail", prompt: "invalid-result" }),
        resultEvents,
      );
      expect(invalidResult.error).toMatchObject({
        requestId: "contract-result-fail",
        code: RUNNER_ERROR_CODES.ADAPTER_FAILURE,
        retryable: false,
      });
      expect(resultEvents.map((event) => event.kind)).toEqual(["started", "failed"]);

      const missingEvents: RunnerEvent[] = [];
      const missingAdapter = await rejectedDispatch(
        fixture.runner,
        fixture.request({ requestId: "contract-adapter-missing", adapter: "missing" }),
        missingEvents,
      );
      expect(missingAdapter.error).toMatchObject({
        requestId: "contract-adapter-missing",
        code: RUNNER_ERROR_CODES.ADAPTER_NOT_FOUND,
        retryable: false,
      });
      expect(missingEvents.map((event) => event.kind)).toEqual(["failed"]);

      expect(RUNNER_RETRYABLE_ERROR_CODES).toEqual([
        RUNNER_ERROR_CODES.TIMEOUT,
        RUNNER_ERROR_CODES.UNAVAILABLE,
      ]);
      for (const [prompt, code] of [
        ["timeout", RUNNER_ERROR_CODES.TIMEOUT],
        ["unavailable", RUNNER_ERROR_CODES.UNAVAILABLE],
      ] as const) {
        const failure = await rejectedDispatch(
          fixture.runner,
          fixture.request({ requestId: `contract-${prompt}`, prompt }),
        );
        expect(failure.error).toMatchObject({ code, retryable: true });
      }
    });

    it("按 (user, project, agent) 隔离、续接和重置 session", async () => {
      const fixture = await harness();
      const firstRequest = fixture.request({ requestId: "contract-session-1" });
      const scope = scopeOf(firstRequest);
      const firstEvents: RunnerEvent[] = [];

      expect(await fixture.runner.hasSession(scope)).toBe(false);
      const first = await fixture.runner.dispatch(firstRequest, {
        onEvent: (event) => firstEvents.push(event),
      });
      expect(first.fresh).toBe(true);
      expect(firstEvents[0]?.fresh).toBe(true);
      expect(await fixture.runner.hasSession(scope)).toBe(true);

      const resumedEvents: RunnerEvent[] = [];
      const resumed = await fixture.runner.dispatch(
        fixture.request({ requestId: "contract-session-2" }),
        { onEvent: (event) => resumedEvents.push(event) },
      );
      expect(resumed.fresh).toBe(false);
      expect(resumedEvents[0]?.fresh).toBe(false);

      const isolatedRequests = [
        fixture.request({ requestId: "contract-session-user", user: "user-other" }),
        fixture.request({
          requestId: "contract-session-project",
          project: "project-other",
        }),
        fixture.request({ requestId: "contract-session-agent", agent: "agent-other" }),
      ];
      for (const isolatedRequest of isolatedRequests) {
        const isolated = await fixture.runner.dispatch(isolatedRequest);
        expect(isolated.fresh).toBe(true);
        expect(await fixture.runner.hasSession(scopeOf(isolatedRequest))).toBe(true);
      }

      await fixture.runner.resetSession(scope);
      expect(await fixture.runner.hasSession(scope)).toBe(false);
      for (const isolatedRequest of isolatedRequests) {
        expect(await fixture.runner.hasSession(scopeOf(isolatedRequest))).toBe(true);
      }

      const running = fixture.runner.dispatch(
        fixture.request({ requestId: "contract-session-running", prompt: "block" }),
      );
      await fixture.waitForBlockedExecution();
      const queued = fixture.runner.dispatch(
        fixture.request({ requestId: "contract-session-queued" }),
      );
      const reset = fixture.runner.resetSession(scope);
      fixture.releaseBlockedExecution();
      const [runningResult, queuedResult] = await Promise.all([running, queued]);
      expect(runningResult.fresh).toBe(true);
      expect(queuedResult.fresh).toBe(false);
      await reset;
      expect(await fixture.runner.hasSession(scope)).toBe(false);

      const afterReset = await fixture.runner.dispatch(
        fixture.request({ requestId: "contract-session-reset" }),
      );
      expect(afterReset.fresh).toBe(true);
    });

    it("相同 requestId 并发、重放都至多执行一次，异载荷冲突被拒绝", async () => {
      const fixture = await harness();
      const value = fixture.request({
        requestId: "contract-idempotent",
        prompt: "block",
      });
      const firstEvents: RunnerEvent[] = [];
      const duplicateEvents: RunnerEvent[] = [];

      const first = fixture.runner.dispatch(value, {
        onEvent: (event) => firstEvents.push(event),
      });
      await fixture.waitForBlockedExecution();
      const duplicate = fixture.runner.dispatch(value, {
        onEvent: (event) => duplicateEvents.push(event),
      });
      expect(fixture.executionCount()).toBe(1);
      fixture.releaseBlockedExecution();

      const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
      expect(duplicateResult).toEqual(firstResult);
      expect(duplicateEvents).toEqual(firstEvents);
      expect(fixture.executionCount()).toBe(1);

      const replayEvents: RunnerEvent[] = [];
      const replay = await fixture.runner.dispatch(value, {
        onEvent: (event) => replayEvents.push(event),
      });
      expect(replay).toEqual(firstResult);
      expect(replayEvents).toEqual(firstEvents);
      expect(fixture.executionCount()).toBe(1);

      await fixture.restartRunner();
      const restartedEvents: RunnerEvent[] = [];
      const restarted = await fixture.runner.dispatch(value, {
        onEvent: (event) => restartedEvents.push(event),
      });
      expect(restarted).toEqual(firstResult);
      expect(restartedEvents).toEqual(firstEvents);
      expect(fixture.executionCount()).toBe(1);

      const conflict = await rejectedDispatch(fixture.runner, {
        ...value,
        prompt: "different payload",
      });
      expect(conflict.error).toMatchObject({
        requestId: value.requestId,
        code: RUNNER_ERROR_CODES.INVALID_REQUEST,
        retryable: false,
      });
      expect(fixture.executionCount()).toBe(1);

      const failedValue = fixture.request({
        requestId: "contract-idempotent-failure",
        prompt: "fail",
      });
      const failedEvents: RunnerEvent[] = [];
      const firstFailure = await rejectedDispatch(
        fixture.runner,
        failedValue,
        failedEvents,
      );
      const executionsAfterFailure = fixture.executionCount();
      await fixture.restartRunner();
      const replayedFailureEvents: RunnerEvent[] = [];
      const replayedFailure = await rejectedDispatch(
        fixture.runner,
        failedValue,
        replayedFailureEvents,
      );
      expect(replayedFailure.error).toEqual(firstFailure.error);
      expect(replayedFailureEvents).toEqual(failedEvents);
      expect(fixture.executionCount()).toBe(executionsAfterFailure);

      const pressureStart = fixture.executionCount();
      const pressureRequests = Array.from({ length: 32 }, (_, index) =>
        fixture.request({ requestId: `contract-pressure-${index}` }),
      );
      for (const pressureRequest of pressureRequests) {
        await fixture.runner.dispatch(pressureRequest);
      }
      await fixture.runner.dispatch(pressureRequests[0]);
      expect(fixture.executionCount()).toBe(pressureStart + pressureRequests.length);
    }, 15_000);

    it("listener 在 started 内重入订阅时不会收到重复事件", async () => {
      const fixture = await harness();
      const value = fixture.request({
        requestId: "contract-reentrant",
        prompt: "events",
      });
      const firstEvents: RunnerEvent[] = [];
      const reentrantEvents: RunnerEvent[] = [];
      let duplicate: Promise<RunnerResult> | undefined;

      const first = fixture.runner.dispatch(value, {
        onEvent: (event) => {
          firstEvents.push(event);
          if (event.kind === "started" && !duplicate) {
            duplicate = fixture.runner.dispatch(value, {
              onEvent: (replayed) => reentrantEvents.push(replayed),
            });
          }
        },
      });
      await first;
      await duplicate;

      expect(reentrantEvents).toEqual(firstEvents);
      expect(reentrantEvents.filter((event) => event.kind === "started")).toHaveLength(1);
      expect(fixture.executionCount()).toBe(1);
    });

    it("cancel 真正中断 running request，重复、未知和已终态结果确定", async () => {
      const fixture = await harness();
      const value = fixture.request({
        requestId: "contract-cancel-running",
        prompt: "block",
      });
      const events: RunnerEvent[] = [];
      let reentrantCancel: Promise<RunnerCancelResult> | undefined;
      const running = fixture.runner.dispatch(value, {
        onEvent: (event) => {
          events.push(event);
          if (event.kind === "failed" && !reentrantCancel) {
            reentrantCancel = fixture.runner.cancel(value.requestId);
          }
        },
      });
      const rejected = running.then(
        () => undefined,
        (error: unknown) => error,
      );
      await fixture.waitForBlockedExecution();

      const cancelled = await fixture.runner.cancel(value.requestId);
      expect(cancelled).toEqual({
        requestId: value.requestId,
        outcome: RUNNER_CANCEL_OUTCOMES.CANCELLED,
      });
      const failure = (await rejected) as Error & { error: RunnerContractError };
      expect(failure).toBeInstanceOf(RunnerDispatchError);
      expect(failure.error).toEqual({
        requestId: value.requestId,
        code: RUNNER_ERROR_CODES.CANCELLED,
        message: expect.any(String),
        retryable: false,
      });
      expect(events.map((event) => event.kind)).toEqual(["started", "failed"]);
      expect(
        events.filter((event) => ["completed", "failed"].includes(event.kind)),
      ).toHaveLength(1);
      expect(events.at(-1)?.error).toEqual(failure.error);
      expect(fixture.cancellationCount()).toBe(1);
      expect(await reentrantCancel).toEqual(cancelled);

      expect(await fixture.runner.cancel(value.requestId)).toEqual(cancelled);
      expect(await fixture.runner.cancel("contract-unknown")).toEqual({
        requestId: "contract-unknown",
        outcome: RUNNER_CANCEL_OUTCOMES.NOT_FOUND,
      });
      let invalidCancel: unknown;
      try {
        await fixture.runner.cancel("");
      } catch (error) {
        invalidCancel = error;
      }
      expect(invalidCancel).toBeInstanceOf(RunnerDispatchError);
      expect((invalidCancel as { error: RunnerContractError }).error).toMatchObject({
        code: RUNNER_ERROR_CODES.INVALID_REQUEST,
        retryable: false,
      });

      const completed = fixture.request({ requestId: "contract-cancel-completed" });
      await fixture.runner.dispatch(completed);
      expect(await fixture.runner.cancel(completed.requestId)).toEqual({
        requestId: completed.requestId,
        outcome: RUNNER_CANCEL_OUTCOMES.ALREADY_TERMINAL,
      });
    });

    it("cancel queued request 不启动 adapter，且只发一个 failed terminal", async () => {
      const fixture = await harness();
      const runningValue = fixture.request({
        requestId: "contract-queue-running",
        prompt: "block",
      });
      const running = fixture.runner.dispatch(runningValue);
      const runningRejected = running.catch((error: unknown) => error);
      await fixture.waitForBlockedExecution();

      const queuedValue = fixture.request({ requestId: "contract-queue-cancelled" });
      const queuedEvents: RunnerEvent[] = [];
      const queued = fixture.runner.dispatch(queuedValue, {
        onEvent: (event) => queuedEvents.push(event),
      });
      const queuedRejected = queued.catch((error: unknown) => error);

      expect(await fixture.runner.cancel(queuedValue.requestId)).toEqual({
        requestId: queuedValue.requestId,
        outcome: RUNNER_CANCEL_OUTCOMES.CANCELLED,
      });
      const queuedFailure = (await queuedRejected) as Error & {
        error: RunnerContractError;
      };
      expect(queuedFailure.error).toMatchObject({
        code: RUNNER_ERROR_CODES.CANCELLED,
        retryable: false,
      });
      expect(queuedEvents.map((event) => event.kind)).toEqual(["failed"]);
      expect(fixture.executionCount()).toBe(1);

      await fixture.runner.cancel(runningValue.requestId);
      await runningRejected;
      expect(fixture.cancellationCount()).toBe(1);
    });

    it("health 严格报告 ready / hostId / inflight / queued", async () => {
      const fixture = await harness();
      expect(await fixture.runner.health()).toEqual({
        ready: true,
        hostId: fixture.hostId,
        inflight: 0,
        queued: 0,
      });

      const running = fixture.runner.dispatch(
        fixture.request({ requestId: "contract-health-running", prompt: "block" }),
      );
      await fixture.waitForBlockedExecution();
      const queued = fixture.runner.dispatch(
        fixture.request({ requestId: "contract-health-queued" }),
      );
      expect(await fixture.runner.health()).toEqual({
        ready: true,
        hostId: fixture.hostId,
        inflight: 1,
        queued: 1,
      });
      fixture.releaseBlockedExecution();
      await Promise.all([running, queued]);
      expect(await fixture.runner.health()).toEqual({
        ready: true,
        hostId: fixture.hostId,
        inflight: 0,
        queued: 0,
      });
      expect(sortedKeys(await fixture.runner.health())).toEqual([
        "hostId",
        "inflight",
        "queued",
        "ready",
      ]);
    });

    it("close 幂等取消全部工作、等待清理并拒绝新 dispatch", async () => {
      const fixture = await harness();
      const runningEvents: RunnerEvent[] = [];
      const running = fixture.runner.dispatch(
        fixture.request({ requestId: "contract-close-running", prompt: "block" }),
        { onEvent: (event) => runningEvents.push(event) },
      );
      const runningRejected = running.catch((error: unknown) => error);
      await fixture.waitForBlockedExecution();
      const queuedEvents: RunnerEvent[] = [];
      const queued = fixture.runner.dispatch(
        fixture.request({ requestId: "contract-close-queued" }),
        { onEvent: (event) => queuedEvents.push(event) },
      );
      const queuedRejected = queued.catch((error: unknown) => error);

      await Promise.all([fixture.runner.close(), fixture.runner.close()]);
      const [runningFailure, queuedFailure] = (await Promise.all([
        runningRejected,
        queuedRejected,
      ])) as Array<Error & { error: RunnerContractError }>;
      expect(runningFailure.error.code).toBe(RUNNER_ERROR_CODES.CANCELLED);
      expect(queuedFailure.error.code).toBe(RUNNER_ERROR_CODES.CANCELLED);
      expect(runningEvents.filter((event) => event.kind === "failed")).toHaveLength(1);
      expect(queuedEvents.map((event) => event.kind)).toEqual(["failed"]);
      expect(fixture.executionCount()).toBe(1);
      expect(fixture.cancellationCount()).toBe(1);
      expect(await fixture.runner.health()).toEqual({
        ready: false,
        hostId: fixture.hostId,
        inflight: 0,
        queued: 0,
      });

      const unavailable = await rejectedDispatch(
        fixture.runner,
        fixture.request({ requestId: "contract-after-close" }),
      );
      expect(unavailable.error).toMatchObject({
        code: RUNNER_ERROR_CODES.UNAVAILABLE,
        retryable: true,
      });
      await fixture.runner.close();
    });
  });
}
