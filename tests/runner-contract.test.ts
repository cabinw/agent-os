import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import { Adapter } from "../apps/chat-spike/src/adapters/base.mjs";
// @ts-expect-error
import {
  RUNNER_ERROR_CODES,
  RunnerDispatchError,
  runnerError,
} from "../apps/chat-spike/src/runners/contract.mjs";
// @ts-expect-error
import { LocalRunner } from "../apps/chat-spike/src/runners/local.mjs";
// @ts-expect-error
import { SessionStore } from "../apps/chat-spike/src/runners/session-store.mjs";
import {
  type RunnerContractHarness,
  type RunnerRequest,
  defineRunnerContractSuite,
} from "./helpers/runner-contract-suite.js";

defineRunnerContractSuite("LocalRunner", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-runner-contract-"));
  const workspaceRoot = join(root, "workspaces");
  mkdirSync(join(workspaceRoot, "project-a"), { recursive: true });

  let executions = 0;
  let cancellations = 0;
  let blockedStartedResolve: () => void = () => {};
  const blockedStarted = new Promise<void>((resolve) => {
    blockedStartedResolve = resolve;
  });
  let blockedReleaseResolve: () => void = () => {};
  const blockedRelease = new Promise<void>((resolve) => {
    blockedReleaseResolve = resolve;
  });

  class ContractAdapter extends Adapter {
    static id = "contract";
    static label = "Contract fixture";
    static capabilities = {
      streaming: true,
      thoughts: true,
      session: true,
      usage: true,
    };

    async send(prompt: string, { signal }: { signal?: AbortSignal } = {}) {
      executions++;
      const fresh = !this.hasSession;

      if (prompt === "block") {
        blockedStartedResolve();
        await Promise.race([
          blockedRelease,
          new Promise<never>((_resolve, reject) => {
            const abort = () => {
              cancellations++;
              reject(signal?.reason ?? new Error("contract cancelled"));
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          }),
        ]);
      }
      if (prompt === "fail") throw new Error("contract adapter failure");
      if (prompt === "timeout" || prompt === "unavailable") {
        const code =
          prompt === "timeout"
            ? RUNNER_ERROR_CODES.TIMEOUT
            : RUNNER_ERROR_CODES.UNAVAILABLE;
        throw new RunnerDispatchError(
          runnerError({
            requestId: "unknown",
            code,
            message: `contract ${prompt}`,
            retryable: true,
          }),
        );
      }
      if (prompt === "invalid-result") {
        return {
          text: "invalid",
          sessionId: null,
          ms: Number.NaN,
          fresh,
        };
      }
      if (prompt === "events") {
        this.onEvent({ kind: "delta", text: "answer chunk", vendorOnly: true });
        this.onEvent({ kind: "thought", text: "reasoning chunk", vendorOnly: true });
        this.onEvent({ kind: "vendor.phase", label: "vendor stage", vendorOnly: true });
        this.onEvent({
          kind: "usage",
          input: 3,
          output: 5,
          total: 8,
          costUsd: -1,
          vendorOnly: true,
        });
      }

      this._sessionId ??= "contract-session";
      return {
        text: "contract-result",
        sessionId: this._sessionId,
        ms: 7,
        fresh,
        vendorOnly: "must be removed",
      };
    }
  }

  const sessionPath = join(root, "state", "sessions.json");
  const hostId = "contract-host";
  const makeRunner = () =>
    new LocalRunner({
      workspaceRoot,
      sessionStore: new SessionStore(sessionPath),
      getAdapter: (id: string) => (id === ContractAdapter.id ? ContractAdapter : null),
      hostId,
      // Regression guard: the former in-memory implementation evicted at this
      // limit. The durable ledger must retain all pressure-suite request ids.
      requestCacheSize: 1,
    });
  let runner = makeRunner();

  const baseRequest: RunnerRequest = {
    requestId: "contract-default",
    user: "user-1",
    project: "project-1",
    agent: "agent-1",
    adapter: "contract",
    workspace: "project-a",
    prompt: "normal",
    taskId: "TASK-CONTRACT",
    causedBy: "evt_contract",
  };

  const harness: RunnerContractHarness = {
    runner,
    request: (overrides = {}) => ({ ...baseRequest, ...overrides }),
    executionCount: () => executions,
    waitForBlockedExecution: () => blockedStarted,
    releaseBlockedExecution: () => blockedReleaseResolve(),
    cancellationCount: () => cancellations,
    hostId,
    restartRunner: async () => {
      await runner.close();
      runner = makeRunner();
      harness.runner = runner;
    },
    dispose: async () => {
      blockedReleaseResolve();
      await runner.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return harness;
});
