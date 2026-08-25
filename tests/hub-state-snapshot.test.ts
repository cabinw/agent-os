import {
  type ChildProcessWithoutNullStreams,
  spawn,
  spawnSync,
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import { project } from "../apps/chat-spike/src/thread.mjs";

const SCRIPT = resolve("deploy/hub/bin/state-snapshot.mjs");
const scratchDirectories: string[] = [];

type CommandResult = ReturnType<typeof spawnSync>;

type StateFixture = {
  events: string;
  ledger: string;
  placement: string;
  requestId: string;
  state: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalValue(record[key])]),
  );
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function scratch(): string {
  const path = realpathSync.native(
    mkdtempSync(join(tmpdir(), "agent-os-state-snapshot-")),
  );
  scratchDirectories.push(path);
  return path;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700, recursive: true });
  chmodSync(path, 0o700);
}

function writePrivate(path: string, value: string): void {
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function writePrivateBytes(path: string, value: Buffer): void {
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function runtimeSecretCanary(): Buffer {
  return Buffer.from(
    `test-only-secret-canary-${randomBytes(32).toString("hex")}`,
    "utf8",
  );
}

function expectCanaryAbsent(canary: Buffer, value: string | Buffer): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  expect(bytes.includes(canary)).toBe(false);
}

function expectCredentialBearingArtifactProtection(root: string): void {
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      expect(stat.mode & 0o777).toBe(0o500);
      for (const name of readdirSync(path)) visit(join(path, name));
      return;
    }
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o400);
    expect(stat.nlink).toBe(1);
  };
  visit(root);
}

function event(
  id: string,
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  subject?: { kind: string; id: string },
): Record<string, unknown> {
  return {
    id,
    type,
    seq,
    project: "project-a",
    actor: { kind: "system", id: "runtime" },
    ...(subject ? { subject } : {}),
    at: `2026-08-24T00:00:0${seq}.000Z`,
    payload,
  };
}

function makeState(root = scratch(), ledgerName?: string): StateFixture {
  const state = join(root, "state");
  ensurePrivateDirectory(state);
  const events = join(state, "events.jsonl");
  writePrivate(
    events,
    `${JSON.stringify(
      event(
        "event-1",
        1,
        "task.created",
        { task: "task-1", title: "fixture", requires: [] },
        { kind: "task", id: "task-1" },
      ),
    )}\n${JSON.stringify(
      event(
        "event-2",
        2,
        "task.completed",
        { task: "task-1", acceptedBy: "human" },
        { kind: "task", id: "task-1" },
      ),
    )}\n`,
  );

  const placement = join(state, "remote-placement.json");
  const scope = { user: "user-a", project: "project-a", agent: "grok" };
  writePrivate(
    placement,
    `${JSON.stringify(
      {
        version: 1,
        placements: {
          [JSON.stringify([scope.user, scope.project, scope.agent])]: {
            ...scope,
            hostId: "windows-fixture",
            updatedAt: "2026-08-24T00:00:00.000Z",
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const requestId = "request-fixture-1";
  const result = {
    requestId,
    text: "done",
    sessionId: "session-fixture",
    ms: 10,
    fresh: false,
  };
  const ledgerDirectory = join(state, "remote-placement.json.requests");
  ensurePrivateDirectory(ledgerDirectory);
  const ledger = join(ledgerDirectory, ledgerName ?? `${sha256(requestId)}.json`);
  writePrivate(
    ledger,
    `${JSON.stringify(
      {
        version: 1,
        request: {
          requestId,
          fingerprint: sha256("dispatch-fixture"),
          state: "completed",
          events: [
            {
              requestId,
              sequence: 1,
              at: "2026-08-24T00:00:01.000Z",
              kind: "started",
              fresh: false,
            },
            {
              requestId,
              sequence: 2,
              at: "2026-08-24T00:00:02.000Z",
              kind: "completed",
              result,
            },
          ],
          updatedAt: "2026-08-24T00:00:02.000Z",
          result,
        },
      },
      null,
      2,
    )}\n`,
  );
  return { events, ledger, placement, requestId, state };
}

function run(...arguments_: string[]): CommandResult {
  return spawnSync(process.execPath, [SCRIPT, ...arguments_], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

function runCreate(state: string, snapshot: string): CommandResult {
  return run(
    "create",
    state,
    snapshot,
    "--owner-uid",
    String(process.getuid?.() ?? 0),
    "--owner-gid",
    String(process.getgid?.() ?? 0),
  );
}

function runMaterialize(
  snapshot: string,
  destination: string,
  digest: string,
  uid = String(process.getuid?.() ?? 0),
  gid = String(process.getgid?.() ?? 0),
): CommandResult {
  return run(
    "materialize",
    snapshot,
    destination,
    "--manifest-sha256",
    digest,
    "--owner-uid",
    uid,
    "--owner-gid",
    gid,
  );
}

function snapshotLockPath(target: string): string {
  return join(
    dirname(target),
    `.state-snapshot-${sha256(target.split("/").at(-1) ?? "").slice(0, 24)}.lock`,
  );
}

async function spawnPublishLockHolder(
  target: string,
): Promise<ChildProcessWithoutNullStreams> {
  const source = [
    `import { withPublishLock } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};`,
    "withPublishLock(process.env.AGENT_OS_TEST_LOCK_TARGET, () => {",
    '  process.stdout.write("LOCKED\\n");',
    "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
    "});",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    env: { ...process.env, AGENT_OS_TEST_LOCK_TARGET: target },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error("publish lock holder did not become ready"));
    }, 5000);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes("LOCKED\n")) return;
      clearTimeout(timeout);
      resolveReady();
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `publish lock holder exited before ready: ${String(code)}/${String(signal)}`,
        ),
      );
    });
  });
  return child;
}

async function killAndWait(child: ChildProcessWithoutNullStreams): Promise<void> {
  const closed = new Promise<void>((resolveClosed) => child.once("close", resolveClosed));
  child.kill("SIGKILL");
  await closed;
}

function runInjectedPublishLock(
  target: string,
  mode: "dead-owner" | "unknown-owner" | "unknown-self",
): CommandResult {
  const option =
    mode === "unknown-self"
      ? 'selfStarttime: () => ({ status: "unknown" })'
      : `ownerState: () => ${JSON.stringify(mode === "dead-owner" ? "dead" : "unknown")}`;
  const source = [
    `import { withPublishLock } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};`,
    "try {",
    `  withPublishLock(process.env.AGENT_OS_TEST_LOCK_TARGET, () => {}, { ${option} });`,
    '  process.stdout.write("ACQUIRED\\n");',
    "} catch {",
    '  process.stderr.write("LOCKED\\n");',
    "  process.exitCode = 1;",
    "}",
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    env: { ...process.env, AGENT_OS_TEST_LOCK_TARGET: target },
  });
}

function successfulJson(result: CommandResult): Record<string, unknown> {
  expect(result.status, result.stderr?.toString()).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
}

function expectRejected(result: CommandResult, code: string): void {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`Hub state snapshot failed: ${code}\n`);
}

function expectRejectedWithoutTarget(
  result: CommandResult,
  code: string,
  target: string,
): void {
  expectRejected(result, code);
  expect(() => lstatSync(target)).toThrow();
  expect(
    readdirSync(dirname(target)).some((name) => name.startsWith(".incomplete-")),
  ).toBe(false);
}

function createSnapshot(fixture: StateFixture, name = "snapshot-1"): string {
  const snapshot = join(dirname(fixture.state), name);
  const output = successfulJson(runCreate(fixture.state, snapshot));
  expect(output).toMatchObject({
    operation: "create",
    version: 1,
    files: 3,
    directories: 2,
  });
  return snapshot;
}

function replaceSnapshotEvents(snapshot: string, body: string): string {
  const data = join(snapshot, "data");
  const events = join(data, "events.jsonl");
  const manifestPath = join(snapshot, "manifest.json");
  chmodSync(snapshot, 0o700);
  chmodSync(data, 0o700);
  chmodSync(events, 0o600);
  writeFileSync(events, body, "utf8");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    files: Array<{
      relativePath: string;
      size: number;
      hash: string;
    }>;
    totals: { bytes: number };
  };
  const entry = manifest.files.find((value) => value.relativePath === "events.jsonl");
  if (!entry) throw new Error("fixture event manifest entry is missing");
  manifest.totals.bytes += Buffer.byteLength(body) - entry.size;
  entry.size = Buffer.byteLength(body);
  entry.hash = sha256(body);
  const manifestBody = canonicalJson(manifest);
  const digest = sha256(manifestBody);
  for (const [path, value] of [
    [manifestPath, manifestBody],
    [join(snapshot, "manifest.sha256"), `${digest}\n`],
    [join(snapshot, "COMPLETE"), `v1 ${digest}\n`],
  ] as const) {
    chmodSync(path, 0o600);
    writeFileSync(path, value, "utf8");
    chmodSync(path, 0o400);
  }
  chmodSync(events, 0o400);
  chmodSync(data, 0o500);
  chmodSync(snapshot, 0o500);
  return digest;
}

afterEach(() => {
  for (const path of scratchDirectories.splice(0)) {
    const makeWritable = (entry: string): void => {
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(entry);
      } catch {
        return;
      }
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        chmodSync(entry, 0o700);
        for (const name of readdirSync(entry)) makeWritable(join(entry, name));
      } else if (stat.isFile()) {
        chmodSync(entry, 0o600);
      }
    };
    makeWritable(path);
    rmSync(path, { force: true, recursive: true });
  }
});

describe("Hub staging state snapshot", () => {
  it("measures, creates, verifies and materializes a strict replayable state tree", () => {
    const fixture = makeState();
    const expectedBytes = [fixture.events, fixture.placement, fixture.ledger].reduce(
      (sum, path) => sum + statSync(path).size,
      0,
    );
    const measured = successfulJson(run("measure", fixture.state));
    expect(measured).toEqual({
      entryCount: 5,
      fileCount: 3,
      totalBytes: expectedBytes,
      eventCount: 2,
      placementCount: 1,
      requestCount: 1,
      treeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const snapshot = createSnapshot(fixture);
    const verified = successfulJson(run("verify", snapshot));
    expect(verified).toMatchObject({
      operation: "verify",
      version: 1,
      files: 3,
      directories: 2,
      bytes: expectedBytes,
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const restored = join(dirname(fixture.state), "restored-state");
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const materialized = successfulJson(
      run(
        "materialize",
        snapshot,
        restored,
        "--manifest-sha256",
        String(verified.manifestSha256),
        "--owner-uid",
        String(uid),
        "--owner-gid",
        String(gid),
      ),
    );
    expect(materialized).toMatchObject({
      operation: "materialize",
      files: 3,
      bytes: expectedBytes,
    });
    for (const relativePath of [
      "events.jsonl",
      "remote-placement.json",
      `remote-placement.json.requests/${sha256(fixture.requestId)}.json`,
    ]) {
      expect(readFileSync(join(restored, relativePath))).toEqual(
        readFileSync(join(fixture.state, relativePath)),
      );
      expect(statSync(join(restored, relativePath)).mode & 0o777).toBe(0o600);
    }
    expect(statSync(restored).mode & 0o777).toBe(0o700);
    expect(statSync(join(restored, "remote-placement.json.requests")).mode & 0o777).toBe(
      0o700,
    );
    expect(statSync(snapshot).mode & 0o777).toBe(0o500);
    expect(statSync(join(snapshot, "manifest.json")).mode & 0o777).toBe(0o400);
    const manifest = JSON.parse(
      readFileSync(join(snapshot, "manifest.json"), "utf8"),
    ) as {
      activeTaskCount: number;
      files: Array<Record<string, unknown>>;
    };
    expect(manifest.activeTaskCount).toBe(0);
    const storedEvents = readFileSync(fixture.events, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(manifest.files.find((entry) => entry.type === "event-log")).toMatchObject({
      relativePath: "events.jsonl",
      type: "event-log",
      count: 2,
      lastSeq: 2,
      mode: 0o400,
      hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      projectionHash: sha256(canonicalJson(project(storedEvents))),
    });
  });

  it("preserves an opaque secret canary without emitting it outside protected data", () => {
    const fixture = makeState();
    const canary = runtimeSecretCanary();
    const relativePath = "credential-envelope.opaque";
    const sourcePath = join(fixture.state, relativePath);
    writePrivateBytes(sourcePath, canary);
    expect(lstatSync(sourcePath).isFile()).toBe(true);
    expect(lstatSync(sourcePath).mode & 0o777).toBe(0o600);
    expect(lstatSync(sourcePath).nlink).toBe(1);

    const snapshot = join(dirname(fixture.state), "credential-bearing-snapshot");
    const createdResult = runCreate(fixture.state, snapshot);
    expectCanaryAbsent(canary, createdResult.stdout?.toString() ?? "");
    expectCanaryAbsent(canary, createdResult.stderr?.toString() ?? "");
    const created = successfulJson(createdResult);
    expectCanaryAbsent(canary, JSON.stringify(created));
    expect(created).toMatchObject({
      operation: "create",
      files: 4,
      directories: 2,
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const verifiedResult = run(
      "verify",
      snapshot,
      "--manifest-sha256",
      String(created.manifestSha256),
    );
    expectCanaryAbsent(canary, verifiedResult.stdout?.toString() ?? "");
    expectCanaryAbsent(canary, verifiedResult.stderr?.toString() ?? "");
    const verified = successfulJson(verifiedResult);
    expectCanaryAbsent(canary, JSON.stringify(verified));
    expect(verified).toEqual({ ...created, operation: "verify" });
    expect(readFileSync(join(snapshot, "data", relativePath)).equals(canary)).toBe(true);

    for (const controlName of ["manifest.json", "manifest.sha256", "COMPLETE"]) {
      expectCanaryAbsent(canary, readFileSync(join(snapshot, controlName)));
    }

    // The helper intentionally performs no content secret scan. Every snapshot
    // must therefore be handled as root-only, credential-bearing high-sensitivity data.
    expectCredentialBearingArtifactProtection(snapshot);
  });

  it.each([
    ["invalid JSONL", '{"seq":1}\n{"seq":', "event_log_invalid"],
    [
      "sequence gap",
      `${JSON.stringify(
        event("gap-1", 1, "project.created", { name: "p", stack: [] }),
      )}\n${JSON.stringify(
        event("gap-3", 3, "project.state.changed", { from: "a", to: "b" }),
      )}\n`,
      "event_log_invalid",
    ],
  ])("rejects %s before publishing", (_label, body, code) => {
    const fixture = makeState();
    writePrivate(fixture.events, body);
    const snapshot = join(dirname(fixture.state), "bad-events-snapshot");
    expectRejected(runCreate(fixture.state, snapshot), code);
    expect(() => statSync(snapshot)).toThrow();
    expect(
      readdirSync(dirname(fixture.state)).some((name) => name.startsWith(".incomplete-")),
    ).toBe(false);
  });

  it("rejects duplicate event ids and active assigned/running projections", () => {
    const duplicate = makeState();
    writePrivate(
      duplicate.events,
      `${JSON.stringify(
        event("duplicate-id", 1, "project.created", { name: "p", stack: [] }),
      )}\n${JSON.stringify(
        event("duplicate-id", 2, "project.state.changed", { from: "a", to: "b" }),
      )}\n`,
    );
    expectRejected(run("measure", duplicate.state), "event_log_invalid");

    const active = makeState();
    writePrivate(
      active.events,
      `${JSON.stringify(
        event(
          "active-1",
          1,
          "task.created",
          { task: "task-active", title: "active", requires: [] },
          { kind: "task", id: "task-active" },
        ),
      )}\n${JSON.stringify(
        event(
          "active-2",
          2,
          "task.assigned",
          { task: "task-active", executor: "grok" },
          { kind: "task", id: "task-active" },
        ),
      )}\n`,
    );
    expectRejected(run("measure", active.state), "active_tasks_present");
    expectRejected(
      runCreate(active.state, join(dirname(active.state), "active-snapshot")),
      "active_tasks_present",
    );

    const restoredFixture = makeState();
    const snapshot = createSnapshot(restoredFixture, "active-verify-snapshot");
    const activeBody = `${JSON.stringify(
      event(
        "restore-active-1",
        1,
        "task.created",
        { task: "restore-active", title: "active", requires: [] },
        { kind: "task", id: "restore-active" },
      ),
    )}\n${JSON.stringify(
      event(
        "restore-active-2",
        2,
        "task.started",
        { task: "restore-active", executor: "grok" },
        { kind: "task", id: "restore-active" },
      ),
    )}\n`;
    const digest = replaceSnapshotEvents(snapshot, activeBody);
    expectRejected(run("verify", snapshot), "active_tasks_present");
    const destination = join(dirname(restoredFixture.state), "active-restore-target");
    expectRejected(runMaterialize(snapshot, destination, digest), "active_tasks_present");
    expect(() => statSync(destination)).toThrow();
  });

  it.each([
    ["malformed JSON tail", Buffer.from('{"truncated":', "utf8")],
    ["invalid UTF-8 tail", Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a])],
  ])("retains active-task priority over a %s", (_label, corruptTail) => {
    const fixture = makeState();
    const activePrefix = Buffer.from(
      `${JSON.stringify(
        event(
          "active-prefix-1",
          1,
          "task.created",
          { task: "task-active-prefix", title: "active", requires: [] },
          { kind: "task", id: "task-active-prefix" },
        ),
      )}\n${JSON.stringify(
        event(
          "active-prefix-2",
          2,
          "task.assigned",
          { task: "task-active-prefix", executor: "grok" },
          { kind: "task", id: "task-active-prefix" },
        ),
      )}\n`,
      "utf8",
    );
    writePrivateBytes(fixture.events, Buffer.concat([activePrefix, corruptTail]));
    const snapshot = join(dirname(fixture.state), "active-corrupt-snapshot");

    expectRejected(run("measure", fixture.state), "active_tasks_present");
    expectRejected(runCreate(fixture.state, snapshot), "active_tasks_present");
    expect(() => statSync(snapshot)).toThrow();
  });

  it.each(["pending", "offered", "inflight", "queued", "running"])(
    "treats a %s request ledger as active work",
    (state) => {
      const fixture = makeState();
      const ledger = JSON.parse(readFileSync(fixture.ledger, "utf8")) as {
        request: Record<string, unknown>;
      };
      ledger.request.state = state;
      ledger.request.result = undefined;
      writePrivate(fixture.ledger, `${JSON.stringify(ledger)}\n`);

      expectRejected(run("measure", fixture.state), "active_tasks_present");
    },
  );

  it("rejects crash temp artifacts and wrong source ownership", () => {
    const fixture = makeState();
    writePrivate(join(fixture.state, "orphan.tmp"), "partial");
    expectRejected(run("measure", fixture.state), "temporary_state_entry");
    unlinkSync(join(fixture.state, "orphan.tmp"));
    writePrivate(join(fixture.state, "events.jsonl.write-intent"), "pending\n");
    expectRejected(run("measure", fixture.state), "temporary_state_entry");
    unlinkSync(join(fixture.state, "events.jsonl.write-intent"));
    writePrivate(join(fixture.state, "events.jsonl.write-committed"), "pending\n");
    expectRejected(run("measure", fixture.state), "temporary_state_entry");
    unlinkSync(join(fixture.state, "events.jsonl.write-committed"));

    const snapshot = join(dirname(fixture.state), "wrong-owner");
    expectRejected(
      run(
        "create",
        fixture.state,
        snapshot,
        "--owner-uid",
        String((process.getuid?.() ?? 0) + 1),
        "--owner-gid",
        String(process.getgid?.() ?? 0),
      ),
      "snapshot_data_invalid",
    );
  });

  it("rejects a placement key that does not match its v1 scope", () => {
    const fixture = makeState();
    writePrivate(
      fixture.placement,
      `${JSON.stringify({
        version: 1,
        placements: {
          wrong: {
            user: "u",
            project: "p",
            agent: "a",
            hostId: "h",
            updatedAt: "2026-08-24T00:00:00.000Z",
          },
        },
      })}\n`,
    );
    expectRejected(
      runCreate(fixture.state, join(dirname(fixture.state), "bad-placement")),
      "placement_invalid",
    );
  });

  it.each([
    ["event log", "events" as const, "event_log_invalid"],
    ["placement", "placement" as const, "json_state_invalid"],
    ["terminal ledger", "ledger" as const, "json_state_invalid"],
    ["opaque JSON", "opaque" as const, "json_state_invalid"],
  ])("rejects invalid UTF-8 in %s", (_label, kind, code) => {
    const fixture = makeState();
    const path = kind === "opaque" ? join(fixture.state, "opaque.json") : fixture[kind];
    const original =
      kind === "opaque" ? Buffer.from('{"opaque":"value"}\n') : readFileSync(path);
    const corrupted = Buffer.from(original);
    const offset = Math.max(1, corrupted.indexOf(Buffer.from(":")) + 2);
    corrupted[offset] = 0xff;
    writePrivateBytes(path, corrupted);
    expectRejected(run("measure", fixture.state), code);
  });

  it("rejects an invalid UTF-8 manifest before accepting its checksum", () => {
    const fixture = makeState();
    const snapshot = createSnapshot(fixture, "invalid-utf8-manifest");
    const manifestPath = join(snapshot, "manifest.json");
    chmodSync(snapshot, 0o700);
    chmodSync(manifestPath, 0o600);
    const manifest = readFileSync(manifestPath);
    manifest[Math.max(1, manifest.indexOf(Buffer.from(":")) + 2)] = 0xff;
    writeFileSync(manifestPath, manifest);
    chmodSync(manifestPath, 0o400);
    chmodSync(snapshot, 0o500);
    expectRejected(run("verify", snapshot), "manifest_invalid");
  });

  it("rejects a terminal ledger whose filename is not sha256(requestId)", () => {
    const fixture = makeState(undefined, "wrong.json");
    expectRejected(
      runCreate(fixture.state, join(dirname(fixture.state), "bad-ledger")),
      "request_ledger_invalid",
    );
  });

  it("rejects symbolic links and multiply-linked files without publishing", () => {
    const symlinkFixture = makeState();
    symlinkSync(symlinkFixture.events, join(symlinkFixture.state, "linked-events"));
    expectRejected(
      runCreate(
        symlinkFixture.state,
        join(dirname(symlinkFixture.state), "symlink-snapshot"),
      ),
      "unsafe_state_tree",
    );

    const hardlinkFixture = makeState();
    linkSync(hardlinkFixture.events, join(hardlinkFixture.state, "hardlinked-events"));
    expectRejected(
      runCreate(
        hardlinkFixture.state,
        join(dirname(hardlinkFixture.state), "hardlink-snapshot"),
      ),
      "unsafe_state_tree",
    );
  });

  it("detects strict snapshot extras and content mismatches", () => {
    const fixture = makeState();
    const snapshot = createSnapshot(fixture);
    const dataDirectory = join(snapshot, "data");
    const extra = join(snapshot, "data", "extra.json");
    chmodSync(dataDirectory, 0o700);
    writePrivate(extra, "{}\n");
    chmodSync(dataDirectory, 0o500);
    expectRejected(run("verify", snapshot), "snapshot_extra_entry");

    chmodSync(dataDirectory, 0o700);
    unlinkSync(extra);
    chmodSync(dataDirectory, 0o500);
    const snapshotEvents = join(snapshot, "data", "events.jsonl");
    chmodSync(snapshotEvents, 0o600);
    writePrivate(snapshotEvents, '{"seq":1}\n');
    chmodSync(snapshotEvents, 0o400);
    chmodSync(dataDirectory, 0o500);
    expectRejected(run("verify", snapshot), "snapshot_data_mismatch");
  });

  it("never overwrites existing snapshot or materialization targets", () => {
    const fixture = makeState();
    const snapshot = createSnapshot(fixture);
    const digest = readFileSync(join(snapshot, "manifest.sha256"), "utf8").trim();
    expectRejected(runCreate(fixture.state, snapshot), "target_exists");

    const destination = join(dirname(fixture.state), "existing-destination");
    ensurePrivateDirectory(destination);
    expectRejected(runMaterialize(snapshot, destination, digest), "destination_exists");
    expectRejected(
      runMaterialize(
        snapshot,
        join(dirname(fixture.state), "bad-owner"),
        digest,
        "-1",
        "0",
      ),
      "ownership_invalid",
    );
  });

  it("accepts canonical create and materialize flags in interchangeable order", () => {
    const fixture = makeState();
    const snapshot = join(dirname(fixture.state), "swapped-flags");
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);
    successfulJson(
      run("create", fixture.state, snapshot, "--owner-gid", gid, "--owner-uid", uid),
    );
    const digest = readFileSync(join(snapshot, "manifest.sha256"), "utf8").trim();
    successfulJson(run("verify", snapshot, "--manifest-sha256", digest));
    const swappedRestore = join(dirname(fixture.state), "swapped-restore-flags");
    successfulJson(
      run(
        "materialize",
        snapshot,
        swappedRestore,
        "--owner-gid",
        gid,
        "--manifest-sha256",
        digest,
        "--owner-uid",
        uid,
      ),
    );
  });

  it("rejects malformed create grammar and legacy positional ownership without publishing", () => {
    const fixture = makeState();
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);
    const cases: Array<[string, string[]]> = [
      ["missing-owner-pair", []],
      ["owner-half", ["--owner-uid", uid]],
      ["dangling-owner-flag", ["--owner-uid", uid, "--owner-gid"]],
      ["duplicate-owner-flag", ["--owner-uid", uid, "--owner-uid", uid]],
      ["unknown-owner-flag", ["--owner-uid", uid, "--unknown", gid]],
      ["legacy-positional-owner", [uid, gid]],
    ];
    for (const [name, arguments_] of cases) {
      const target = join(dirname(fixture.state), name);
      expectRejectedWithoutTarget(
        run("create", fixture.state, target, ...arguments_),
        "invalid_arguments",
        target,
      );
    }
    expectRejected(run("measure", fixture.state, "legacy-extra"), "invalid_arguments");
  });

  it("validates every lexical path before touching a missing source", () => {
    const fixture = makeState();
    const missingSource = join(dirname(fixture.state), "missing-state");
    const missingSnapshot = join(dirname(fixture.state), "missing-snapshot");
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);
    const digest = "a".repeat(64);

    expectRejected(
      run(
        "create",
        missingSource,
        "relative-target",
        "--owner-uid",
        uid,
        "--owner-gid",
        gid,
      ),
      "unsafe_path",
    );
    expectRejected(
      run(
        "materialize",
        missingSnapshot,
        "relative-target",
        "--manifest-sha256",
        digest,
        "--owner-uid",
        uid,
        "--owner-gid",
        gid,
      ),
      "unsafe_path",
    );
    expectRejected(run("measure", "relative-state"), "unsafe_path");
    expectRejected(run("verify", "relative-snapshot"), "unsafe_path");
  });

  it("parses verify flags and digest before touching the snapshot path", () => {
    const fixture = makeState();
    const missingSnapshot = join(dirname(fixture.state), "not-created");
    const digest = "a".repeat(64);
    const invalidArgumentCases: string[][] = [
      ["--manifest-sha256"],
      ["--manifest-sha256", digest, "--manifest-sha256", digest],
      ["--unknown", digest],
      [digest],
    ];
    for (const arguments_ of invalidArgumentCases) {
      expectRejected(run("verify", missingSnapshot, ...arguments_), "invalid_arguments");
    }
    expectRejected(
      run("verify", missingSnapshot, "--manifest-sha256", "not-a-digest"),
      "manifest_digest_invalid",
    );

    const snapshot = createSnapshot(fixture, "verify-digest-snapshot");
    expectRejected(
      run("verify", snapshot, "--manifest-sha256", "0".repeat(64)),
      "manifest_digest_mismatch",
    );
  });

  it("rejects malformed materialize grammar, ownership and digest without publishing", () => {
    const fixture = makeState();
    const snapshot = createSnapshot(fixture, "materialize-grammar-snapshot");
    const digest = readFileSync(join(snapshot, "manifest.sha256"), "utf8").trim();
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);
    const cases: Array<[string, string, string[], string]> = [
      [
        "missing-digest",
        snapshot,
        ["--owner-uid", uid, "--owner-gid", gid],
        "invalid_arguments",
      ],
      [
        "owner-half",
        snapshot,
        ["--manifest-sha256", digest, "--owner-uid", uid],
        "invalid_arguments",
      ],
      [
        "dangling-owner-flag",
        snapshot,
        ["--manifest-sha256", digest, "--owner-uid", uid, "--owner-gid"],
        "invalid_arguments",
      ],
      [
        "duplicate-digest-flag",
        snapshot,
        ["--manifest-sha256", digest, "--manifest-sha256", digest, "--owner-uid", uid],
        "invalid_arguments",
      ],
      [
        "unknown-flag",
        snapshot,
        ["--manifest-sha256", digest, "--owner-uid", uid, "--unknown", gid],
        "invalid_arguments",
      ],
      ["legacy-positional", snapshot, [digest, uid, gid], "invalid_arguments"],
      [
        "negative-uid",
        snapshot,
        ["--manifest-sha256", digest, "--owner-uid", "-1", "--owner-gid", gid],
        "ownership_invalid",
      ],
      [
        "negative-gid",
        snapshot,
        ["--manifest-sha256", digest, "--owner-uid", uid, "--owner-gid", "-1"],
        "ownership_invalid",
      ],
      [
        "overflow-uid",
        snapshot,
        ["--manifest-sha256", digest, "--owner-uid", "4294967296", "--owner-gid", gid],
        "ownership_invalid",
      ],
      [
        "overflow-gid",
        snapshot,
        [
          "--manifest-sha256",
          digest,
          "--owner-uid",
          uid,
          "--owner-gid",
          "9007199254740992",
        ],
        "ownership_invalid",
      ],
      [
        "bad-digest",
        join(dirname(fixture.state), "missing-snapshot"),
        ["--manifest-sha256", "not-a-digest", "--owner-uid", uid, "--owner-gid", gid],
        "manifest_digest_invalid",
      ],
    ];
    for (const [name, source, arguments_, code] of cases) {
      const target = join(dirname(fixture.state), `materialize-${name}`);
      expectRejectedWithoutTarget(
        run("materialize", source, target, ...arguments_),
        code,
        target,
      );
    }

    const mismatchTarget = join(dirname(fixture.state), "digest-mismatch");
    expectRejectedWithoutTarget(
      runMaterialize(snapshot, mismatchTarget, "0".repeat(64)),
      "manifest_digest_mismatch",
      mismatchTarget,
    );
  });

  it("publishes a second snapshot without changing the old complete copy", () => {
    const fixture = makeState();
    const first = createSnapshot(fixture, "snapshot-first");
    const before = {
      complete: readFileSync(join(first, "COMPLETE"), "utf8"),
      events: readFileSync(join(first, "data", "events.jsonl"), "utf8"),
      manifest: readFileSync(join(first, "manifest.json"), "utf8"),
    };

    writePrivate(
      fixture.events,
      `${readFileSync(fixture.events, "utf8")}${JSON.stringify(
        event(
          "event-3",
          3,
          "project.state.changed",
          { from: "active", to: "completed" },
          { kind: "project", id: "project-a" },
        ),
      )}\n`,
    );
    const second = createSnapshot(fixture, "snapshot-second");
    expect(successfulJson(run("verify", second))).toMatchObject({ operation: "verify" });
    expect(readFileSync(join(first, "COMPLETE"), "utf8")).toBe(before.complete);
    expect(readFileSync(join(first, "data", "events.jsonl"), "utf8")).toBe(before.events);
    expect(readFileSync(join(first, "manifest.json"), "utf8")).toBe(before.manifest);
    expect(successfulJson(run("verify", first))).toMatchObject({ operation: "verify" });
  });

  it("reclaims an exact stale publish lease after its holder is SIGKILLed", async () => {
    const fixture = makeState();
    const snapshot = join(dirname(fixture.state), "snapshot-after-holder-crash");
    const holder = await spawnPublishLockHolder(snapshot);
    const lock = snapshotLockPath(snapshot);
    expect(lstatSync(lock).isFile()).toBe(true);

    await killAndWait(holder);
    expect(successfulJson(runCreate(fixture.state, snapshot))).toMatchObject({
      operation: "create",
    });
    expect(existsSync(lock)).toBe(false);
    expect(
      readdirSync(dirname(snapshot)).filter((name) =>
        name.startsWith(".state-snapshot-owner-"),
      ),
    ).toEqual([]);
  });

  it("rejects a concurrent publisher and succeeds after the live holder exits", async () => {
    const fixture = makeState();
    const snapshot = join(dirname(fixture.state), "snapshot-concurrent-holder");
    const holder = await spawnPublishLockHolder(snapshot);
    expectRejected(runCreate(fixture.state, snapshot), "publish_locked");
    expect(existsSync(snapshot)).toBe(false);

    await killAndWait(holder);
    expect(successfulJson(runCreate(fixture.state, snapshot))).toMatchObject({
      operation: "create",
    });
  });

  it("fails closed when a live lease owner cannot be inspected", async () => {
    const fixture = makeState();
    const snapshot = join(dirname(fixture.state), "snapshot-unknown-live-holder");
    const holder = await spawnPublishLockHolder(snapshot);
    const lock = snapshotLockPath(snapshot);
    const before = lstatSync(lock);

    const result = runInjectedPublishLock(snapshot, "unknown-owner");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("LOCKED\n");
    expect(lstatSync(lock).ino).toBe(before.ino);
    await killAndWait(holder);
    successfulJson(runCreate(fixture.state, snapshot));
  });

  it("does not publish a lease when its own process identity is unavailable", () => {
    const fixture = makeState();
    const snapshot = join(dirname(fixture.state), "snapshot-unknown-self");
    const result = runInjectedPublishLock(snapshot, "unknown-self");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("LOCKED\n");
    expect(existsSync(snapshotLockPath(snapshot))).toBe(false);
    expect(
      readdirSync(dirname(snapshot)).filter((name) =>
        name.startsWith(".state-snapshot-owner-"),
      ),
    ).toEqual([]);
  });

  it("reclaims only an explicit dead-owner result such as PID starttime reuse", async () => {
    const fixture = makeState();
    const snapshot = join(dirname(fixture.state), "snapshot-explicit-dead-owner");
    const holder = await spawnPublishLockHolder(snapshot);
    const result = runInjectedPublishLock(snapshot, "dead-owner");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("ACQUIRED\n");
    expect(existsSync(snapshotLockPath(snapshot))).toBe(false);
    await killAndWait(holder);
  });

  it.each(["symlink", "hardlink", "unsafe-mode"])(
    "does not replace a malicious %s publish lock",
    (kind) => {
      const fixture = makeState();
      const snapshot = join(dirname(fixture.state), `snapshot-malicious-lock-${kind}`);
      const lock = snapshotLockPath(snapshot);
      const peer = join(dirname(snapshot), `malicious-lock-peer-${kind}`);
      writePrivate(peer, "not a lock record\n");
      if (kind === "symlink") symlinkSync(peer, lock);
      else if (kind === "hardlink") linkSync(peer, lock);
      else {
        writePrivate(lock, "not a lock record\n");
        chmodSync(lock, 0o666);
      }

      expectRejected(runCreate(fixture.state, snapshot), "publish_locked");
      expect(existsSync(snapshot)).toBe(false);
      if (kind === "symlink") expect(lstatSync(lock).isSymbolicLink()).toBe(true);
      else expect(lstatSync(lock).isFile()).toBe(true);
    },
  );

  it("removes its publish lease after normal completion", () => {
    const fixture = makeState();
    const snapshot = join(dirname(fixture.state), "snapshot-normal-lock-release");
    successfulJson(runCreate(fixture.state, snapshot));
    expect(existsSync(snapshotLockPath(snapshot))).toBe(false);
    expect(
      readdirSync(dirname(snapshot)).filter((name) =>
        name.startsWith(".state-snapshot-owner-"),
      ),
    ).toEqual([]);
  });
});
