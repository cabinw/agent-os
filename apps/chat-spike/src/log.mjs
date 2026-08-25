/**
 * Spike storage: an append-only JSONL file.
 *
 * **This is the throwaway part.** RM-1.1b replaces it with SQLite + WAL,
 * proper transactional seq allocation, and idempotency tokens. RM-1.1d adds
 * projection snapshots as a disposable sidecar cache
 * (docs/development/roadmap.md). What survives is everything built on top of
 * it, because nothing above this file knows how events are stored.
 *
 * What it does implement, because they are the properties the architecture
 * rests on:
 *   - append-only, never edit or delete
 *   - per-project monotonic `seq`, assigned at append
 *   - replay from seq 0 reproduces state exactly
 */

import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const DEFAULT_FILE_OPS = Object.freeze({
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  writeSync,
});

export const DEFAULT_INTENT_OPS = Object.freeze({
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
});

const WRITE_INTENT_SUFFIX = ".write-intent";
const WRITE_COMMITTED_SUFFIX = ".write-committed";
const WRITE_MARKER_VERSION = 1;
const MAX_WRITE_MARKER_BYTES = 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export const EVENT_LOG_WRITE_FAILURE_MESSAGE = "event log durable append failed";
export const EVENT_LOG_REPLAY_FAILURE_MESSAGE = "event log replay rejected";

export class EventLogReplayError extends Error {
  constructor() {
    super(EVENT_LOG_REPLAY_FAILURE_MESSAGE);
    this.name = "EventLogReplayError";
    this.code = "replay_rejected";
  }
}

export class EventLogWriteError extends Error {
  constructor({ rollbackSucceeded }) {
    super(EVENT_LOG_WRITE_FAILURE_MESSAGE);
    this.name = "EventLogWriteError";
    this.code = rollbackSucceeded ? "append_rejected" : "rollback_failed";
  }
}

function syncParentDirectory(path, fileOps) {
  const directoryFd = fileOps.openSync(dirname(path), fileOps.constants.O_RDONLY);
  try {
    fileOps.fsyncSync(directoryFd);
  } finally {
    fileOps.closeSync(directoryFd);
  }
}

function canonicalWriteMarker(value) {
  if (
    !exactKeys(value, ["version", "sequence", "oldSize", "frameBytes", "frameSha256"]) ||
    value.version !== WRITE_MARKER_VERSION ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !Number.isSafeInteger(value.oldSize) ||
    value.oldSize < 0 ||
    !Number.isSafeInteger(value.frameBytes) ||
    value.frameBytes < 1 ||
    typeof value.frameSha256 !== "string" ||
    !SHA256.test(value.frameSha256)
  ) {
    throw new Error("invalid write marker");
  }
  return {
    version: WRITE_MARKER_VERSION,
    sequence: value.sequence,
    oldSize: value.oldSize,
    frameBytes: value.frameBytes,
    frameSha256: value.frameSha256,
  };
}

function writeMarkerBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalWriteMarker(value))}\n`, "utf8");
}

function sameWriteMarker(left, right) {
  return writeMarkerBytes(left).equals(writeMarkerBytes(right));
}

function writeMarkerFor(sequence, oldSize, frame) {
  return canonicalWriteMarker({
    version: WRITE_MARKER_VERSION,
    sequence,
    oldSize,
    frameBytes: frame.length,
    frameSha256: createHash("sha256").update(frame).digest("hex"),
  });
}

function readWriteMarker(path, fileOps = DEFAULT_INTENT_OPS) {
  let fd;
  try {
    const before = fileOps.lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size < 1n ||
      before.size > BigInt(MAX_WRITE_MARKER_BYTES)
    ) {
      throw new Error("unsafe write marker");
    }
    fd = fileOps.openSync(
      path,
      fileOps.constants.O_RDONLY | fileOps.constants.O_NOFOLLOW,
    );
    const opened = fileOps.fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error("write marker changed");
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fileOps.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(read) || read < 1) {
        throw new Error("short write marker read");
      }
      offset += read;
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!decoded.endsWith("\n") || decoded.slice(0, -1).includes("\n")) {
      throw new Error("invalid write marker encoding");
    }
    const marker = canonicalWriteMarker(JSON.parse(decoded.slice(0, -1)));
    if (!bytes.equals(writeMarkerBytes(marker))) {
      throw new Error("non-canonical write marker");
    }
    return marker;
  } finally {
    if (fd !== undefined) fileOps.closeSync(fd);
  }
}

function markerExists(path, fileOps = DEFAULT_INTENT_OPS) {
  try {
    fileOps.lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function createWriteIntentDurably(path, marker, fileOps = DEFAULT_INTENT_OPS) {
  const bytes = writeMarkerBytes(marker);
  let fd;
  try {
    fd = fileOps.openSync(
      path,
      fileOps.constants.O_WRONLY |
        fileOps.constants.O_CREAT |
        fileOps.constants.O_EXCL |
        fileOps.constants.O_NOFOLLOW,
      0o600,
    );
    const stat = fileOps.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n) {
      throw new Error("unsafe intent");
    }
    let offset = 0;
    while (offset < bytes.length) {
      const written = fileOps.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isSafeInteger(written) || written < 1)
        throw new Error("short intent write");
      offset += written;
    }
    fileOps.fsyncSync(fd);
  } catch {
    throw new EventLogWriteError({ rollbackSucceeded: false });
  } finally {
    if (fd !== undefined) {
      try {
        fileOps.closeSync(fd);
      } catch {
        // The persistent marker remains the fail-closed recovery signal.
      }
    }
  }
  try {
    syncParentDirectory(path, fileOps);
  } catch {
    throw new EventLogWriteError({ rollbackSucceeded: false });
  }
}

export function commitWriteIntentDurably(
  intentPath,
  committedPath,
  expected,
  fileOps = DEFAULT_INTENT_OPS,
) {
  // The rename plus parent-directory fsync is the storage commit boundary.
  // Once it returns, committed-marker cleanup cannot roll the frame back or
  // turn the append into a caller-visible storage failure.
  try {
    const intent = readWriteMarker(intentPath, fileOps);
    if (!sameWriteMarker(intent, expected) || markerExists(committedPath, fileOps)) {
      throw new Error("write marker conflict");
    }
    fileOps.renameSync(intentPath, committedPath);
    const committed = readWriteMarker(committedPath, fileOps);
    if (!sameWriteMarker(committed, expected)) {
      throw new Error("committed marker changed");
    }
    syncParentDirectory(committedPath, fileOps);
  } catch {
    throw new EventLogWriteError({ rollbackSucceeded: false });
  }
}

export function clearWriteMarkerDurably(path, expected, fileOps = DEFAULT_INTENT_OPS) {
  // This removes a fence after storage commit; it is not part of that commit.
  // A cleanup error may leave the fence for offline adjudication, while an
  // unlink already visible in the namespace must not revoke the durable frame.
  let fd;
  try {
    const marker = readWriteMarker(path, fileOps);
    if (!sameWriteMarker(marker, expected)) {
      throw new Error("write marker changed");
    }
    const before = fileOps.lstatSync(path, { bigint: true });
    fd = fileOps.openSync(
      path,
      fileOps.constants.O_RDONLY | fileOps.constants.O_NOFOLLOW,
    );
    const opened = fileOps.fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("write marker changed");
    }
    fileOps.unlinkSync(path);
    syncParentDirectory(path, fileOps);
  } catch {
    throw new EventLogWriteError({ rollbackSucceeded: false });
  } finally {
    if (fd !== undefined) {
      try {
        fileOps.closeSync(fd);
      } catch {
        // The fixed failure is the only caller-visible error.
      }
    }
  }
}

export function clearWriteIntentDurably(path, expected, fileOps = DEFAULT_INTENT_OPS) {
  return clearWriteMarkerDurably(path, expected, fileOps);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
  if (!plainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key))
  );
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateStoredEvent(event, expectedSeq, priorIds, projectId) {
  if (
    !exactKeys(
      event,
      ["id", "type", "seq", "project", "actor", "at", "payload"],
      ["subject", "causedBy"],
    ) ||
    !nonEmptyString(event.id) ||
    priorIds.has(event.id) ||
    !nonEmptyString(event.type) ||
    event.seq !== expectedSeq ||
    !nonEmptyString(event.project) ||
    (projectId !== null && event.project !== projectId) ||
    !exactKeys(event.actor, ["kind", "id"]) ||
    !nonEmptyString(event.actor.kind) ||
    !nonEmptyString(event.actor.id) ||
    !nonEmptyString(event.at) ||
    !Number.isFinite(Date.parse(event.at)) ||
    !plainObject(event.payload)
  ) {
    throw new EventLogReplayError();
  }
  if (
    event.subject !== undefined &&
    (!exactKeys(event.subject, ["kind", "id"]) ||
      !nonEmptyString(event.subject.kind) ||
      !nonEmptyString(event.subject.id))
  ) {
    throw new EventLogReplayError();
  }
  if (
    event.causedBy !== undefined &&
    (!nonEmptyString(event.causedBy) || !priorIds.has(event.causedBy))
  ) {
    throw new EventLogReplayError();
  }
}

/**
 * Append one complete frame and fsync it before success. Any short write or
 * storage error restores the old byte offset when possible. Paths and raw I/O
 * errors are intentionally excluded from the public error.
 */
export function appendRecordDurably(
  path,
  bytes,
  fileOps = DEFAULT_FILE_OPS,
  expectedOldSize = null,
) {
  const existed = fileOps.existsSync(path);
  let fd;
  let oldSize = null;
  let rollbackSucceeded = false;
  try {
    fd = fileOps.openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    const stat = fileOps.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe event log file");
    if (expectedOldSize !== null && stat.size !== expectedOldSize) {
      throw new Error("event log size changed after intent");
    }
    oldSize = stat.size;
    let offset = 0;
    while (offset < bytes.length) {
      const written = fileOps.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isSafeInteger(written) || written < 1) {
        throw new Error("short event log write");
      }
      offset += written;
    }
    fileOps.fsyncSync(fd);
    if (!existed) {
      const directoryFd = fileOps.openSync(dirname(path), constants.O_RDONLY);
      try {
        fileOps.fsyncSync(directoryFd);
      } finally {
        fileOps.closeSync(directoryFd);
      }
    }
    return;
  } catch {
    if (fd !== undefined && oldSize !== null) {
      try {
        fileOps.ftruncateSync(fd, oldSize);
        fileOps.fsyncSync(fd);
        rollbackSucceeded = true;
      } catch {
        rollbackSucceeded = false;
      }
    }
    throw new EventLogWriteError({ rollbackSucceeded });
  } finally {
    if (fd !== undefined) {
      try {
        fileOps.closeSync(fd);
      } catch {
        // The fixed append failure remains the only error exposed to callers.
      }
    }
  }
}

export class EventLog {
  #path;
  #events = [];
  #ids = new Set();
  #projectId = null;
  #seq = 0;
  #byteSize = 0;
  #subscribers = new Set();
  #needsSeparator = false;
  #failed = false;
  #onFatal;
  #appendRecord;
  #beginWrite;
  #commitWrite;
  #clearWrite;
  #pendingCommitted = null;

  constructor(
    path,
    {
      onFatal = () => {},
      appendRecord = appendRecordDurably,
      beginWrite = createWriteIntentDurably,
      commitWrite = commitWriteIntentDurably,
      clearWrite = clearWriteMarkerDurably,
    } = {},
  ) {
    if (
      typeof onFatal !== "function" ||
      typeof appendRecord !== "function" ||
      typeof beginWrite !== "function" ||
      typeof commitWrite !== "function" ||
      typeof clearWrite !== "function"
    ) {
      throw new TypeError("EventLog callbacks must be functions");
    }
    this.#path = path;
    this.#onFatal = onFatal;
    this.#appendRecord = appendRecord;
    this.#beginWrite = beginWrite;
    this.#commitWrite = commitWrite;
    this.#clearWrite = clearWrite;
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (markerExists(`${path}${WRITE_INTENT_SUFFIX}`)) {
        throw new EventLogReplayError();
      }
    } catch (error) {
      throw new EventLogReplayError();
    }
    const raw = this.#replayFromDisk();
    this.#rejectUnresolvedCommittedWrite(raw);
  }

  /** Rebuild from one complete, gap-free, strictly decoded JSONL history. */
  #replayFromDisk() {
    if (!existsSync(this.#path)) return Buffer.alloc(0);
    let bytes;
    let raw;
    try {
      bytes = readFileSync(this.#path);
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new EventLogReplayError();
    }
    this.#byteSize = bytes.length;
    if (raw.length === 0) return bytes;
    if (!raw.endsWith("\n")) throw new EventLogReplayError();
    const lines = raw.slice(0, -1).split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.length === 0 || line.trim() !== line) throw new EventLogReplayError();
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new EventLogReplayError();
      }
      validateStoredEvent(event, index + 1, this.#ids, this.#projectId);
      this.#projectId ??= event.project;
      this.#ids.add(event.id);
      this.#events.push(event);
    }
    this.#seq = this.#events.length;
    this.#needsSeparator = false;
    return bytes;
  }

  #rejectUnresolvedCommittedWrite(raw) {
    const committedPath = `${this.#path}${WRITE_COMMITTED_SUFFIX}`;
    let exists;
    try {
      exists = markerExists(committedPath);
    } catch {
      throw new EventLogReplayError();
    }
    if (!exists) return;
    try {
      const marker = readWriteMarker(committedPath);
      this.#validateCommittedWrite(marker, raw);
    } catch {
      throw new EventLogReplayError();
    }
    // A still-present committed marker proves storage commit but not whether
    // the caller observed success. It is therefore an unresolved fence, not a
    // recovery instruction. Operation-level idempotency or offline
    // adjudication must resolve it; marker cleanup alone is not an end-to-end
    // delivery guarantee.
    throw new EventLogReplayError();
  }

  #validateCommittedWrite(marker, raw) {
    if (
      marker.sequence !== this.#seq ||
      marker.oldSize + marker.frameBytes !== raw.length ||
      marker.oldSize < 0 ||
      (marker.oldSize > 0 && raw[marker.oldSize - 1] !== 0x0a)
    ) {
      throw new EventLogReplayError();
    }
    const frame = raw.subarray(marker.oldSize);
    if (
      frame.length !== marker.frameBytes ||
      frame[frame.length - 1] !== 0x0a ||
      frame.subarray(0, -1).includes(0x0a) ||
      createHash("sha256").update(frame).digest("hex") !== marker.frameSha256
    ) {
      throw new EventLogReplayError();
    }
    let stored;
    try {
      stored = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
    } catch {
      throw new EventLogReplayError();
    }
    if (stored?.seq !== marker.sequence) throw new EventLogReplayError();
  }

  #settlePendingCommittedWrite() {
    if (this.#pendingCommitted === null) return;
    const committedPath = `${this.#path}${WRITE_COMMITTED_SUFFIX}`;
    try {
      this.#clearWrite(committedPath, this.#pendingCommitted);
      this.#pendingCommitted = null;
    } catch (error) {
      try {
        if (!markerExists(committedPath)) {
          this.#pendingCommitted = null;
          return;
        }
      } catch {
        // Preserve the marker and stop before allocating another sequence.
      }
      throw error;
    }
  }

  #fail(error) {
    this.#failed = true;
    try {
      this.#onFatal(error);
    } catch {
      // A fatal callback cannot make this write look successful.
    }
  }

  /**
   * Append an event. `seq` is assigned here — allocation belongs inside the
   * write, not at construction, or two concurrent producers could collide.
   * The committed-marker rename plus parent fsync is the storage commit. Its
   * cleanup is best-effort and cannot make that committed append look failed.
   * Caller observation is a separate boundary: crash or connection loss still
   * requires operation-level idempotency or offline adjudication.
   */
  append(event) {
    if (this.#failed) throw new EventLogWriteError({ rollbackSucceeded: false });
    try {
      this.#settlePendingCommittedWrite();
    } catch (error) {
      this.#fail(error);
      if (error instanceof EventLogWriteError) throw error;
      throw new EventLogWriteError({ rollbackSucceeded: false });
    }
    const nextSeq = this.#seq + 1;
    const stored = { ...event, seq: nextSeq };
    validateStoredEvent(stored, nextSeq, this.#ids, this.#projectId);
    const separator = this.#needsSeparator ? "\n" : "";
    const bytes = Buffer.from(`${separator}${JSON.stringify(stored)}\n`, "utf8");
    const intentPath = `${this.#path}${WRITE_INTENT_SUFFIX}`;
    const committedPath = `${this.#path}${WRITE_COMMITTED_SUFFIX}`;
    const marker = writeMarkerFor(nextSeq, this.#byteSize, bytes);
    let intentPublished = false;
    try {
      this.#beginWrite(intentPath, marker);
      intentPublished = true;
      this.#appendRecord(this.#path, bytes, DEFAULT_FILE_OPS, marker.oldSize);
      this.#commitWrite(intentPath, committedPath, marker);
      intentPublished = false;
    } catch (error) {
      if (
        intentPublished &&
        error instanceof EventLogWriteError &&
        error.code === "append_rejected"
      ) {
        try {
          this.#clearWrite(intentPath, marker);
          intentPublished = false;
        } catch {
          // A marker that cannot be durably cleared intentionally blocks restart.
        }
      }
      this.#fail(error);
      if (error instanceof EventLogWriteError) throw error;
      throw new EventLogWriteError({ rollbackSucceeded: false });
    }
    this.#seq = nextSeq;
    this.#projectId ??= stored.project;
    this.#ids.add(stored.id);
    this.#needsSeparator = false;
    this.#byteSize += bytes.length;
    this.#events.push(stored);
    try {
      this.#clearWrite(committedPath, marker);
    } catch {
      try {
        if (markerExists(committedPath)) this.#pendingCommitted = marker;
      } catch {
        this.#pendingCommitted = marker;
      }
    }
    for (const fn of this.#subscribers) {
      try {
        fn(stored);
      } catch {
        // Subscribers observe an already committed event. Their failure must
        // not make the durable append appear to have failed to its caller.
      }
    }
    return stored;
  }

  /** Every event from seq 0. Replaying this must reproduce current state. */
  replay() {
    return this.#events.slice();
  }

  get size() {
    return this.#events.length;
  }

  get seq() {
    return this.#seq;
  }

  get path() {
    return this.#path;
  }

  /** @param {(e: object) => void} fn */
  subscribe(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }
}
