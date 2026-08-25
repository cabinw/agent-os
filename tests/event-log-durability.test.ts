import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — the chat spike is plain JavaScript.
import {
  DEFAULT_INTENT_OPS,
  EVENT_LOG_REPLAY_FAILURE_MESSAGE,
  EVENT_LOG_WRITE_FAILURE_MESSAGE,
  EventLog,
  EventLogWriteError,
  appendRecordDurably,
  clearWriteMarkerDurably,
  commitWriteIntentDurably,
} from "../apps/chat-spike/src/log.mjs";

const roots: string[] = [];

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "agent-os-event-log-"));
  roots.push(root);
  return root;
}

function storedEvent(seq: number, id = `evt-${seq}`, project = "project-a") {
  return {
    id,
    type: "project.created",
    seq,
    project,
    actor: { kind: "system", id: "runtime" },
    at: `2026-08-24T00:00:0${seq}.000Z`,
    payload: { name: "fixture", stack: [] },
  };
}

function appendableEvent(id = "evt-1") {
  const { seq: _seq, ...event } = storedEvent(1, id);
  return event;
}

function appendLeavingCommitted(path: string) {
  const log = new EventLog(path, {
    clearWrite: () => {
      throw new Error("fixture keeps committed marker");
    },
  });
  expect(log.append(appendableEvent())).toMatchObject({ seq: 1 });
  const markerPath = `${path}.write-committed`;
  expect(existsSync(markerPath)).toBe(true);
  return markerPath;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("EventLog durable append", () => {
  it("commits seq only after the frame and fsync succeed", () => {
    const path = join(scratch(), "events.jsonl");
    const log = new EventLog(path);

    expect(log.append(appendableEvent("evt-1"))).toMatchObject({ seq: 1 });
    expect(log.append(appendableEvent("evt-2"))).toMatchObject({ seq: 2 });
    expect(log.seq).toBe(2);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    expect(existsSync(`${path}.write-intent`)).toBe(false);
  });

  it("does not let a subscriber exception turn a committed append into failure", () => {
    const path = join(scratch(), "events.jsonl");
    const log = new EventLog(path);
    const observed = vi.fn();
    log.subscribe(() => {
      throw new Error("subscriber-secret");
    });
    log.subscribe(observed);

    expect(log.append(appendableEvent())).toMatchObject({ seq: 1 });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(new EventLog(path).replay()).toHaveLength(1);
  });

  it("never durably appends an envelope that a restart would reject", () => {
    const path = join(scratch(), "events.jsonl");
    const log = new EventLog(path);
    expect(() => log.append({ id: "incomplete" })).toThrow(
      EVENT_LOG_REPLAY_FAILURE_MESSAGE,
    );
    expect(log.seq).toBe(0);
    expect(() => readFileSync(path)).toThrow();
  });

  it("does not consume seq and permanently fails closed after an append error", () => {
    const fatal = vi.fn();
    const marker = "credential-like-marker-must-not-leak";
    const log = new EventLog(join(scratch(), "events.jsonl"), {
      appendRecord: () => {
        throw new Error(marker);
      },
      onFatal: fatal,
    });

    expect(() => log.append(appendableEvent("evt-1"))).toThrow(
      EVENT_LOG_WRITE_FAILURE_MESSAGE,
    );
    expect(log.seq).toBe(0);
    expect(log.replay()).toEqual([]);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(() => log.append(appendableEvent("evt-2"))).toThrow(
      EVENT_LOG_WRITE_FAILURE_MESSAGE,
    );
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(() => log.append(appendableEvent("evt-3"))).not.toThrow(marker);
    expect(existsSync(`${log.path}.write-intent`)).toBe(true);
    expect(() => new EventLog(log.path)).toThrow(EVENT_LOG_REPLAY_FAILURE_MESSAGE);
  });

  it("clears the durable intent when a rejected append was rolled back", () => {
    const path = join(scratch(), "events.jsonl");
    const log = new EventLog(path, {
      appendRecord: () => {
        throw new EventLogWriteError({ rollbackSucceeded: true });
      },
    });
    expect(() => log.append(appendableEvent())).toThrow(
      expect.objectContaining({ code: "append_rejected" }),
    );
    expect(existsSync(`${path}.write-intent`)).toBe(false);
    expect(new EventLog(path).replay()).toEqual([]);
  });

  it("treats committed-marker cleanup as best-effort after storage commit", () => {
    const path = join(scratch(), "events.jsonl");
    let committedUnlinked = false;
    let cleanupDirectoryFsyncReached = false;
    const cleanupOps = {
      ...DEFAULT_INTENT_OPS,
      fsyncSync: (fd: number) => {
        if (committedUnlinked) {
          cleanupDirectoryFsyncReached = DEFAULT_INTENT_OPS.fstatSync(fd).isDirectory();
          throw new Error("cleanup-dir-fsync-secret");
        }
        return DEFAULT_INTENT_OPS.fsyncSync(fd);
      },
      unlinkSync: (target: string) => {
        DEFAULT_INTENT_OPS.unlinkSync(target);
        committedUnlinked = true;
      },
    };
    const log = new EventLog(path, {
      clearWrite: (target: string, marker: object) =>
        clearWriteMarkerDurably(target, marker, cleanupOps),
    });
    expect(log.append(appendableEvent())).toMatchObject({ seq: 1 });
    expect(committedUnlinked).toBe(true);
    expect(cleanupDirectoryFsyncReached).toBe(true);
    expect(existsSync(`${path}.write-intent`)).toBe(false);
    expect(existsSync(`${path}.write-committed`)).toBe(false);

    const restarted = new EventLog(path);
    expect(restarted.replay()).toHaveLength(1);
    expect(restarted.append(appendableEvent("evt-2"))).toMatchObject({ seq: 2 });
  });

  // These SIGKILL probes establish durability and restart behavior for one
  // already-committed frame. They cannot prove that the caller observed the
  // result; retries still need operation-level idempotency or offline
  // adjudication.
  it.each([
    ["after unlink and before parent-directory fsync", "before-cleanup-dir-fsync"],
    ["after parent-directory fsync and before append returns", "before-append-return"],
  ])(
    "keeps one committed frame restartable when a real child is SIGKILLed %s",
    (_window, phase) => {
      const root = scratch();
      const path = join(root, "events.jsonl");
      const child = join(root, "cleanup-crash.mjs");
      const proof = join(root, "cleanup-phase-proof");
      writeFileSync(
        child,
        `const {
  DEFAULT_INTENT_OPS,
  EventLog,
  clearWriteMarkerDurably,
} = await import(process.argv[3]);
const { existsSync, writeFileSync } = await import("node:fs");
const [path, , proof, phase] = process.argv.slice(2, 6);
const committedPath = \`\${path}.write-committed\`;
let cleanupUnlinked = false;
let cleanupDirectorySynced = false;
const kill = (phaseProof) => {
  writeFileSync(proof, \`\${phaseProof}\\n\`, { mode: 0o600 });
  process.kill(process.pid, "SIGKILL");
};
const cleanupOps = {
  ...DEFAULT_INTENT_OPS,
  unlinkSync(target) {
    if (target !== committedPath) process.exit(91);
    DEFAULT_INTENT_OPS.unlinkSync(target);
    if (existsSync(committedPath)) process.exit(92);
    cleanupUnlinked = true;
  },
  fsyncSync(fd) {
    if (!cleanupUnlinked) return DEFAULT_INTENT_OPS.fsyncSync(fd);
    if (!DEFAULT_INTENT_OPS.fstatSync(fd).isDirectory()) process.exit(93);
    if (existsSync(committedPath)) process.exit(94);
    if (phase === "before-cleanup-dir-fsync") {
      kill("unlinked-before-cleanup-dir-fsync");
    }
    const result = DEFAULT_INTENT_OPS.fsyncSync(fd);
    cleanupDirectorySynced = true;
    return result;
  },
};
const log = new EventLog(path, {
  clearWrite: (target, marker) => {
    clearWriteMarkerDurably(target, marker, cleanupOps);
    if (!cleanupUnlinked || !cleanupDirectorySynced) process.exit(95);
    if (existsSync(committedPath)) process.exit(96);
    if (phase === "before-append-return") {
      kill("cleanup-dir-fsynced-before-append-return");
    }
    process.exit(97);
  },
});
log.append({
  id: "evt-cleanup-child",
  type: "project.created",
  project: "project-a",
  actor: { kind: "system", id: "runtime" },
  at: "2026-08-24T00:00:01.000Z",
  payload: { name: "fixture", stack: [] },
});
process.exit(98);
`,
        { mode: 0o600 },
      );
      expect(existsSync(proof)).toBe(false);
      const result = spawnSync(
        process.execPath,
        [
          child,
          path,
          pathToFileURL(resolve("apps/chat-spike/src/log.mjs")).href,
          proof,
          phase,
        ],
        { timeout: 10_000 },
      );

      expect(result.status).toBeNull();
      expect(result.signal).toBe("SIGKILL");
      expect(readFileSync(proof, "utf8")).toBe(
        phase === "before-cleanup-dir-fsync"
          ? "unlinked-before-cleanup-dir-fsync\n"
          : "cleanup-dir-fsynced-before-append-return\n",
      );

      const expectedStored = {
        ...appendableEvent("evt-cleanup-child"),
        seq: 1,
      };
      const expectedFrame = Buffer.from(`${JSON.stringify(expectedStored)}\n`, "utf8");
      expect(readFileSync(path)).toEqual(expectedFrame);
      expect(existsSync(`${path}.write-intent`)).toBe(false);
      expect(existsSync(`${path}.write-committed`)).toBe(false);

      const restarted = new EventLog(path);
      expect(restarted.replay()).toEqual([expectedStored]);
      expect(restarted.append(appendableEvent("evt-after-restart"))).toMatchObject({
        seq: 2,
      });
    },
  );

  it("keeps an indeterminate frame fenced when rename succeeds but commit dir fsync fails", () => {
    const path = join(scratch(), "events.jsonl");
    let renamed = false;
    let commitDirectoryFsyncReached = false;
    const commitOps = {
      ...DEFAULT_INTENT_OPS,
      fsyncSync: (fd: number) => {
        if (renamed) {
          commitDirectoryFsyncReached = DEFAULT_INTENT_OPS.fstatSync(fd).isDirectory();
          throw new Error("commit-dir-fsync-secret");
        }
        return DEFAULT_INTENT_OPS.fsyncSync(fd);
      },
      renameSync: (from: string, to: string) => {
        DEFAULT_INTENT_OPS.renameSync(from, to);
        renamed = true;
      },
    };
    const log = new EventLog(path, {
      commitWrite: (intent: string, committed: string, marker: object) =>
        commitWriteIntentDurably(intent, committed, marker, commitOps),
    });
    expect(() => log.append(appendableEvent())).toThrow(
      expect.objectContaining({ code: "rollback_failed" }),
    );
    expect(commitDirectoryFsyncReached).toBe(true);
    expect(existsSync(`${path}.write-intent`)).toBe(false);
    expect(existsSync(`${path}.write-committed`)).toBe(true);

    const logBefore = readFileSync(path);
    const markerBefore = readFileSync(`${path}.write-committed`);
    expect(() => new EventLog(path)).toThrow(EVENT_LOG_REPLAY_FAILURE_MESSAGE);
    expect(readFileSync(path)).toEqual(logBefore);
    expect(readFileSync(`${path}.write-committed`)).toEqual(markerBefore);
  });

  it("blocks a full durable frame that never reached the committed rename", () => {
    const path = join(scratch(), "events.jsonl");
    const log = new EventLog(path, {
      commitWrite: () => {
        throw new Error("crash-before-rename-secret");
      },
    });
    expect(() => log.append(appendableEvent())).toThrow(
      expect.objectContaining({ code: "rollback_failed" }),
    );
    expect(readFileSync(path, "utf8")).toContain('"seq":1');
    expect(existsSync(`${path}.write-intent`)).toBe(true);
    expect(existsSync(`${path}.write-committed`)).toBe(false);
    expect(() => new EventLog(path)).toThrow(EVENT_LOG_REPLAY_FAILURE_MESSAGE);
  });

  it.each([
    ["after-intent", ".write-intent"],
    ["after-frame", ".write-intent"],
    ["after-rename", ".write-committed"],
    ["after-commit", ".write-committed"],
  ])("keeps a real child crash %s fenced across restart", (phase, markerSuffix) => {
    const root = scratch();
    const path = join(root, "events.jsonl");
    const child = join(root, "crash-phase.mjs");
    const proof = join(root, "phase-proof");
    writeFileSync(
      child,
      `const {
  DEFAULT_INTENT_OPS,
  EventLog,
  commitWriteIntentDurably,
} = await import(process.argv[4]);
const { readFileSync, writeFileSync } = await import("node:fs");
const [path, phase, , proof] = process.argv.slice(2, 6);
const kill = () => process.kill(process.pid, "SIGKILL");
const options = {};
if (phase === "after-intent") options.appendRecord = kill;
if (phase === "after-frame") options.commitWrite = kill;
if (phase === "after-rename" || phase === "after-commit") {
  let renamed = false;
  const ops = {
    ...DEFAULT_INTENT_OPS,
    renameSync(from, to) {
      DEFAULT_INTENT_OPS.renameSync(from, to);
      renamed = true;
    },
    fsyncSync(fd) {
      if (renamed) {
        if (!DEFAULT_INTENT_OPS.fstatSync(fd).isDirectory()) process.exit(91);
        if (phase === "after-rename") {
          writeFileSync(proof, "before-dir-fsync\\n", { mode: 0o600 });
          kill();
        }
        const result = DEFAULT_INTENT_OPS.fsyncSync(fd);
        writeFileSync(proof, "after-dir-fsync\\n", { mode: 0o600 });
        return result;
      }
      return DEFAULT_INTENT_OPS.fsyncSync(fd);
    },
  };
  options.commitWrite = (intent, committed, marker) =>
    commitWriteIntentDurably(intent, committed, marker, ops);
}
if (phase === "after-commit") {
  options.clearWrite = () => {
    if (readFileSync(proof, "utf8") !== "after-dir-fsync\\n") process.exit(92);
    kill();
  };
}
const log = new EventLog(path, options);
log.append({
  id: "evt-child",
  type: "project.created",
  project: "project-a",
  actor: { kind: "system", id: "runtime" },
  at: "2026-08-24T00:00:01.000Z",
  payload: { name: "fixture", stack: [] },
});
`,
      { mode: 0o600 },
    );
    const result = spawnSync(
      process.execPath,
      [
        child,
        path,
        phase,
        pathToFileURL(resolve("apps/chat-spike/src/log.mjs")).href,
        proof,
      ],
      { timeout: 10_000 },
    );

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    const intentPath = `${path}.write-intent`;
    const committedPath = `${path}.write-committed`;
    expect(existsSync(intentPath)).toBe(markerSuffix === ".write-intent");
    expect(existsSync(committedPath)).toBe(markerSuffix === ".write-committed");
    const expectedFrame = Buffer.from(
      `${JSON.stringify({ ...appendableEvent("evt-child"), seq: 1 })}\n`,
      "utf8",
    );
    if (phase === "after-intent") {
      expect(existsSync(path)).toBe(false);
    } else {
      expect(readFileSync(path)).toEqual(expectedFrame);
    }
    const marker = JSON.parse(readFileSync(`${path}${markerSuffix}`, "utf8"));
    expect(marker).toEqual({
      version: 1,
      sequence: 1,
      oldSize: 0,
      frameBytes: expectedFrame.length,
      frameSha256: createHash("sha256").update(expectedFrame).digest("hex"),
    });
    if (phase === "after-rename") {
      expect(readFileSync(proof, "utf8")).toBe("before-dir-fsync\n");
    } else if (phase === "after-commit") {
      expect(readFileSync(proof, "utf8")).toBe("after-dir-fsync\n");
    } else {
      expect(existsSync(proof)).toBe(false);
    }
    expect(() => new EventLog(path)).toThrow(EVENT_LOG_REPLAY_FAILURE_MESSAGE);
  });

  it.each([
    ["sequence", (marker: Record<string, unknown>) => ({ ...marker, sequence: 2 })],
    ["oldSize", (marker: Record<string, unknown>) => ({ ...marker, oldSize: 1 })],
    [
      "frameBytes",
      (marker: Record<string, unknown>) => ({
        ...marker,
        frameBytes: Number(marker.frameBytes) - 1,
      }),
    ],
    [
      "frameSha256",
      (marker: Record<string, unknown>) => ({ ...marker, frameSha256: "0".repeat(64) }),
    ],
  ])("rejects a committed marker with mismatched %s", (_field, mutate) => {
    const path = join(scratch(), "events.jsonl");
    const markerPath = appendLeavingCommitted(path);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    writeFileSync(markerPath, `${JSON.stringify(mutate(marker))}\n`, { mode: 0o600 });
    const logBefore = readFileSync(path);
    const markerBefore = readFileSync(markerPath);

    expect(() => new EventLog(path)).toThrow(EVENT_LOG_REPLAY_FAILURE_MESSAGE);
    expect(readFileSync(path)).toEqual(logBefore);
    expect(readFileSync(markerPath)).toEqual(markerBefore);
  });

  it("rejects a committed marker when bytes exist after its claimed frame", () => {
    const path = join(scratch(), "events.jsonl");
    const markerPath = appendLeavingCommitted(path);
    appendFileSync(path, `${JSON.stringify(storedEvent(2))}\n`);
    const before = readFileSync(path);

    expect(() => new EventLog(path)).toThrow(EVENT_LOG_REPLAY_FAILURE_MESSAGE);
    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(markerPath)).toBe(true);
  });

  it("rejects simultaneous intent and committed markers without changing either", () => {
    const path = join(scratch(), "events.jsonl");
    const committedPath = appendLeavingCommitted(path);
    const intentPath = `${path}.write-intent`;
    writeFileSync(intentPath, readFileSync(committedPath), { mode: 0o600 });
    const committedBefore = readFileSync(committedPath);
    const intentBefore = readFileSync(intentPath);

    expect(() => new EventLog(path)).toThrow(EVENT_LOG_REPLAY_FAILURE_MESSAGE);
    expect(readFileSync(committedPath)).toEqual(committedBefore);
    expect(readFileSync(intentPath)).toEqual(intentBefore);
  });

  it("does not append when the log size drifted after intent publication", () => {
    let writes = 0;
    const fileOps = {
      closeSync: vi.fn(),
      existsSync: () => true,
      fstatSync: () => ({ isFile: () => true, nlink: 1, size: 9 }),
      fsyncSync: vi.fn(),
      ftruncateSync: vi.fn(),
      openSync: () => 13,
      writeSync: () => {
        writes += 1;
        return 1;
      },
    };

    expect(() =>
      appendRecordDurably(
        "/not-opened-by-fake/events.jsonl",
        Buffer.from("next\n"),
        fileOps,
        8,
      ),
    ).toThrow(expect.objectContaining({ code: "rollback_failed" }));
    expect(writes).toBe(0);
    expect(fileOps.ftruncateSync).not.toHaveBeenCalled();
  });

  it("rolls a partial write back to the previous offset", () => {
    let content = Buffer.from("existing\n");
    let writes = 0;
    const fileOps = {
      closeSync: vi.fn(),
      existsSync: () => true,
      fstatSync: () => ({ isFile: () => true, nlink: 1, size: content.length }),
      fsyncSync: vi.fn(),
      ftruncateSync: (_fd: number, size: number) => {
        content = content.subarray(0, size);
      },
      openSync: () => 7,
      writeSync: (_fd: number, bytes: Buffer, offset: number, length: number) => {
        writes += 1;
        if (writes === 2) throw new Error("secret device error");
        const count = Math.min(3, length);
        content = Buffer.concat([content, bytes.subarray(offset, offset + count)]);
        return count;
      },
    };

    let failure: unknown;
    try {
      appendRecordDurably(
        "/not-opened-by-fake/events.jsonl",
        Buffer.from("next\n"),
        fileOps,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(EventLogWriteError);
    expect(failure).toMatchObject({ code: "append_rejected" });
    expect(String(failure)).not.toContain("secret device error");
    expect(content.toString()).toBe("existing\n");
    expect(fileOps.fsyncSync).toHaveBeenCalled();
  });

  it("reports rollback_failed when the old offset cannot be restored", () => {
    const fileOps = {
      closeSync: vi.fn(),
      existsSync: () => true,
      fstatSync: () => ({ isFile: () => true, nlink: 1, size: 0 }),
      fsyncSync: vi.fn(),
      ftruncateSync: () => {
        throw new Error("truncate failed");
      },
      openSync: () => 9,
      writeSync: () => 0,
    };

    expect(() =>
      appendRecordDurably("/not-opened-by-fake/events.jsonl", Buffer.from("x"), fileOps),
    ).toThrow(expect.objectContaining({ code: "rollback_failed" }));
  });

  it.each(["ENOSPC", "EDQUOT", "EIO", "EROFS"])(
    "redacts %s and restores the old offset",
    (code) => {
      let size = 9;
      const fileOps = {
        closeSync: vi.fn(),
        existsSync: () => true,
        fstatSync: () => ({ isFile: () => true, nlink: 1, size }),
        fsyncSync: vi.fn(),
        ftruncateSync: (_fd: number, previous: number) => {
          size = previous;
        },
        openSync: () => 11,
        writeSync: () => {
          const error = new Error(`raw-${code}-marker`) as Error & { code: string };
          error.code = code;
          throw error;
        },
      };

      let failure: unknown;
      try {
        appendRecordDurably(
          "/not-opened-by-fake/events.jsonl",
          Buffer.from("x"),
          fileOps,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "append_rejected",
        message: EVENT_LOG_WRITE_FAILURE_MESSAGE,
      });
      expect(String(failure)).not.toContain(`raw-${code}-marker`);
      expect(size).toBe(9);
    },
  );

  it.each([
    ["malformed JSON", Buffer.from('{"id":\n')],
    ["missing final newline", Buffer.from(JSON.stringify(storedEvent(1)))],
    [
      "blank internal record",
      Buffer.from(
        `${JSON.stringify(storedEvent(1))}\n\n${JSON.stringify(storedEvent(2))}\n`,
      ),
    ],
    [
      "sequence gap",
      Buffer.from(
        `${JSON.stringify(storedEvent(1))}\n${JSON.stringify(storedEvent(3))}\n`,
      ),
    ],
    [
      "duplicate sequence",
      Buffer.from(
        `${JSON.stringify(storedEvent(1))}\n${JSON.stringify(storedEvent(1, "evt-2"))}\n`,
      ),
    ],
    [
      "duplicate id",
      Buffer.from(
        `${JSON.stringify(storedEvent(1))}\n${JSON.stringify(storedEvent(2, "evt-1"))}\n`,
      ),
    ],
    [
      "mixed project",
      Buffer.from(
        `${JSON.stringify(storedEvent(1))}\n${JSON.stringify(storedEvent(2, "evt-2", "project-b"))}\n`,
      ),
    ],
    ["incomplete envelope", Buffer.from(`${JSON.stringify({ id: "evt-1", seq: 1 })}\n`)],
    [
      "invalid UTF-8",
      Buffer.from([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0xff, 0x7d, 0x0a]),
    ],
  ])("rejects %s on restart without changing the log", (_label, bytes) => {
    const path = join(scratch(), "events.jsonl");
    writeFileSync(path, bytes, { mode: 0o600 });
    const before = readFileSync(path);
    expect(() => new EventLog(path)).toThrow(EVENT_LOG_REPLAY_FAILURE_MESSAGE);
    expect(readFileSync(path)).toEqual(before);
  });

  it("keeps a rollback_failed partial frame fail closed across restart", () => {
    const path = join(scratch(), "events.jsonl");
    const log = new EventLog(path, {
      appendRecord: (target: string, bytes: Buffer) => {
        appendFileSync(
          target,
          bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))),
        );
        throw new EventLogWriteError({ rollbackSucceeded: false });
      },
    });

    expect(() => log.append(appendableEvent())).toThrow(
      expect.objectContaining({ code: "rollback_failed" }),
    );
    expect(() => new EventLog(path)).toThrow(EVENT_LOG_REPLAY_FAILURE_MESSAGE);
  });
});
