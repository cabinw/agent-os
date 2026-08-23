import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import { SubprocessAdapter } from "../apps/chat-spike/src/adapters/base.mjs";
// @ts-expect-error
import {
  RUNNER_ERROR_CODES,
  RunnerDispatchError,
} from "../apps/chat-spike/src/runners/contract.mjs";
// @ts-expect-error
import { LocalRunner } from "../apps/chat-spike/src/runners/local.mjs";
// @ts-expect-error
import { SessionStore } from "../apps/chat-spike/src/runners/session-store.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/runner-cli.mjs", import.meta.url));
const dirs: string[] = [];

type FixtureLine = {
  type: "delta" | "progress" | "usage" | "result";
  text?: string;
  label?: string;
  input?: number;
  output?: number;
  total?: number;
  sessionId?: string;
};

type RunnerEvent = {
  requestId: string;
  sequence: number;
  kind: string;
  text?: string;
  label?: string;
  fresh?: boolean;
  error?: { code: string; retryable: boolean };
};

class FixtureAdapter extends SubprocessAdapter {
  static id = "fixture";
  static label = "Fixture CLI";
  static capabilities = {
    streaming: true,
    thoughts: false,
    session: true,
    usage: true,
  };

  buildCommand(prompt: string, resume: string | null) {
    return {
      cmd: process.execPath,
      args: [FIXTURE, prompt, resume ?? ""],
    };
  }

  handleLine(line: FixtureLine) {
    if (line.type === "delta") {
      this.onEvent({ kind: "delta", text: line.text });
      return undefined;
    }
    if (line.type === "progress") {
      this.onEvent({ kind: "progress", label: line.label });
      return undefined;
    }
    if (line.type === "usage") {
      this.onEvent({
        kind: "usage",
        input: line.input,
        output: line.output,
        total: line.total,
      });
      return undefined;
    }
    return { text: line.text, sessionId: line.sessionId };
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureEnvironment() {
  const dir = mkdtempSync(join(tmpdir(), "agentos-local-runner-"));
  dirs.push(dir);
  const workspaceRoot = join(dir, "workspaces");
  mkdirSync(join(workspaceRoot, "project-a"), { recursive: true });
  const sessionPath = join(dir, "state", "sessions.json");
  return { dir, workspaceRoot, sessionPath };
}

function makeRunner(environment: ReturnType<typeof fixtureEnvironment>) {
  return new LocalRunner({
    workspaceRoot: environment.workspaceRoot,
    sessionStore: new SessionStore(environment.sessionPath),
    getAdapter: (id: string) => (id === FixtureAdapter.id ? FixtureAdapter : null),
    hostId: "test-host",
  });
}

function request(requestId: string, prompt: string) {
  return {
    requestId,
    user: "user-1",
    project: "project-1",
    agent: "agent-1",
    adapter: "fixture",
    workspace: "project-a",
    prompt,
    taskId: "TASK-001",
    causedBy: "evt_001",
  };
}

describe("C-LOCAL-01 · Local Runner", () => {
  it("通过真实子进程 adapter 返回结果并归一化完整事件流", async () => {
    const environment = fixtureEnvironment();
    const runner = makeRunner(environment);
    const events: RunnerEvent[] = [];

    const result = await runner.dispatch(request("run-1", "hello"), {
      onEvent: (event: RunnerEvent) => events.push(event),
    });

    expect(result).toEqual({
      requestId: "run-1",
      text: "fresh:hello",
      sessionId: "fixture-session-1",
      ms: expect.any(Number),
      fresh: true,
    });
    expect(events.map((event) => event.kind)).toEqual([
      "started",
      "delta",
      "progress",
      "usage",
      "completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events[1]?.text).toBe("stream:hello");
    expect(events.every((event) => event.requestId === "run-1")).toBe(true);
    await runner.close();
  });

  it("把 CLI 失败归一化为稳定 error contract 和 failed event", async () => {
    const runner = makeRunner(fixtureEnvironment());
    const events: RunnerEvent[] = [];

    let caught: InstanceType<typeof RunnerDispatchError> | undefined;
    try {
      await runner.dispatch(request("run-fail", "__FAIL__"), {
        onEvent: (event: RunnerEvent) => events.push(event),
      });
    } catch (error) {
      caught = error as InstanceType<typeof RunnerDispatchError>;
    }

    expect(caught).toBeInstanceOf(RunnerDispatchError);
    expect(caught?.error).toMatchObject({
      requestId: "run-fail",
      code: RUNNER_ERROR_CODES.ADAPTER_FAILURE,
      retryable: true,
    });
    expect(caught?.message).toContain("退出码 7");
    expect(events.map((event) => event.kind)).toEqual(["started", "failed"]);
    expect(events.at(-1)?.error).toMatchObject({
      code: RUNNER_ERROR_CODES.ADAPTER_FAILURE,
      retryable: true,
    });
    await runner.close();
  });

  it("拒绝 .. 和符号链接越过 workspace root", async () => {
    const environment = fixtureEnvironment();
    const outside = join(environment.dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(environment.workspaceRoot, "escape-link"));
    const runner = makeRunner(environment);

    for (const workspace of ["../outside", "escape-link"]) {
      const events: RunnerEvent[] = [];
      await expect(
        runner.dispatch(
          { ...request(`run-${workspace}`, "hello"), workspace },
          { onEvent: (event: RunnerEvent) => events.push(event) },
        ),
      ).rejects.toMatchObject({
        error: { code: RUNNER_ERROR_CODES.WORKSPACE_NOT_ALLOWED },
      });
      expect(events.map((event) => event.kind)).toEqual(["failed"]);
    }
    await runner.close();
  });
});

describe("SESSION-01 · persistent logical sessions", () => {
  it("按 (user, project, agent) 持久化并在 Runner 重启后恢复 vendor session", async () => {
    const environment = fixtureEnvironment();
    const first = makeRunner(environment);
    await first.dispatch(request("session-1", "first"));
    await first.close();

    const restarted = makeRunner(environment);
    const events: RunnerEvent[] = [];
    const resumed = await restarted.dispatch(request("session-2", "second"), {
      onEvent: (event: RunnerEvent) => events.push(event),
    });

    expect(resumed).toMatchObject({
      text: "resumed:fixture-session-1:second",
      sessionId: "fixture-session-1",
      fresh: false,
    });
    expect(events[0]).toMatchObject({ kind: "started", fresh: false });

    const otherUser = await restarted.dispatch({
      ...request("session-3", "isolated"),
      user: "user-2",
    });
    expect(otherUser).toMatchObject({ text: "fresh:isolated", fresh: true });
    await restarted.close();
  });
});
