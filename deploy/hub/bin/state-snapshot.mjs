#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const FORMAT_VERSION = 1;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 128;
const MAX_RELATIVE_PATH_BYTES = 4_096;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_RECORDS = 1_000_000;
const COPY_BUFFER_BYTES = 1024 * 1024;
const STATE_FILE_MODE = 0o600;
const STATE_DIRECTORY_MODE = 0o700;
const SNAPSHOT_FILE_MODE = 0o400;
const SNAPSHOT_DIRECTORY_MODE = 0o500;
const PUBLISH_LOCK_MODE = 0o600;
const PUBLISH_LOCK_VERSION = 1;
const MAX_PUBLISH_LOCK_BYTES = 1024;
const SAFE_COMPONENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const LEDGER_DIRECTORY = "remote-placement.json.requests";
const LEDGER_PATH = /^remote-placement\.json\.requests\/[a-f0-9]{64}\.json$/u;
const RUNNER_ERROR_CODES = new Set([
  "INVALID_REQUEST",
  "WORKSPACE_NOT_ALLOWED",
  "WORKSPACE_NOT_FOUND",
  "ADAPTER_NOT_FOUND",
  "ADAPTER_FAILURE",
  "CANCELLED",
  "TIMEOUT",
  "UNAVAILABLE",
  "SESSION_FAILURE",
  "INTERNAL",
]);
const EVENT_TYPES = new Set([
  "agent.registered",
  "agent.status.changed",
  "agent.disconnected",
  "task.created",
  "task.assigned",
  "task.started",
  "task.progress.updated",
  "task.blocked",
  "task.unblocked",
  "task.review.requested",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "message.sent",
  "approval.requested",
  "approval.granted",
  "approval.rejected",
  "approval.expired",
  "knowledge.created",
  "knowledge.linked",
  "knowledge.superseded",
  "project.created",
  "project.state.changed",
  "project.snapshot.captured",
  "project.revived",
  "artifact.produced",
  "artifact.derived",
  "measurement.recorded",
  "pulse.story.generated",
]);
const TASK_STATUS = Object.freeze({
  "task.created": "created",
  "task.assigned": "assigned",
  "task.started": "running",
  "task.blocked": "blocked",
  "task.unblocked": "running",
  "task.review.requested": "review",
  "task.completed": "completed",
  "task.failed": "failed",
  "task.cancelled": "cancelled",
});

class SnapshotError extends Error {
  constructor(code) {
    super(code);
    this.name = "SnapshotError";
    this.code = code;
  }
}

function reject(code) {
  throw new SnapshotError(code);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  return (
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
  );
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileTypeMode(stat) {
  return Number(stat.mode & 0o777n);
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function safeComponent(value) {
  return typeof value === "string" && SAFE_COMPONENT.test(value);
}

function safeRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    Buffer.byteLength(value, "utf8") > MAX_RELATIVE_PATH_BYTES
  ) {
    return false;
  }
  return value.split("/").every(safeComponent);
}

function transientStateName(name) {
  return (
    name.endsWith(".tmp") ||
    name.endsWith(".write-intent") ||
    name.endsWith(".write-committed")
  );
}

function existingDirectoryPathSyntax(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path === "/"
  ) {
    reject("unsafe_path");
  }
  return path;
}

function newTargetPathSyntax(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path === "/" ||
    !safeComponent(basename(path))
  ) {
    reject("unsafe_path");
  }
  const parent = dirname(path);
  existingDirectoryPathSyntax(parent);
  return { parent, path };
}

function relativeName(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (!safeRelativePath(value)) reject("unsafe_state_path");
  return value;
}

function exactExistingDirectory(path, code) {
  existingDirectoryPathSyntax(path);
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync.native(path) !== path
  ) {
    reject(code);
  }
  return { path, stat };
}

function newTarget(path, existsCode) {
  const { parent } = newTargetPathSyntax(path);
  exactExistingDirectory(parent, "unsafe_target_parent");
  assertMissing(path, existsCode);
  return { parent, path };
}

function assertMissing(path, code) {
  try {
    lstatSync(path);
    reject(code);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
}

function openDirectory(path) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    closeSync(fd);
    reject("unsafe_directory");
  }
  return { fd, stat };
}

function syncDirectory(path) {
  const { fd } = openDirectory(path);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function setDirectoryMetadata(path, mode, owner = null) {
  const { fd } = openDirectory(path);
  try {
    if (owner) fchownSync(fd, owner.uid, owner.gid);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function createDirectory(path, mode = STATE_DIRECTORY_MODE, owner = null) {
  mkdirSync(path, { recursive: false, mode: STATE_DIRECTORY_MODE });
  setDirectoryMetadata(path, mode, owner);
}

function safeAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < left) reject("state_size_limit");
  return result;
}

function sizeAsNumber(stat) {
  if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    reject("state_size_limit");
  }
  return Number(stat.size);
}

function copyFile(
  source,
  destination,
  before,
  {
    destinationMode,
    destinationOwner = null,
    expectedSourceMode,
    expectedSourceOwner = null,
  },
) {
  const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationFd = null;
  try {
    const opened = fstatSync(sourceFd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameIdentity(before, opened) ||
      opened.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      fileTypeMode(opened) !== expectedSourceMode ||
      (expectedSourceOwner &&
        (opened.uid !== BigInt(expectedSourceOwner.uid) ||
          opened.gid !== BigInt(expectedSourceOwner.gid)))
    ) {
      reject("source_changed");
    }
    destinationFd = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      destinationMode,
    );
    if (destinationOwner) {
      fchownSync(destinationFd, destinationOwner.uid, destinationOwner.gid);
    }
    fchmodSync(destinationFd, destinationMode);

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let total = 0;
    while (true) {
      const length = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (length === 0) break;
      total = safeAdd(total, length);
      if (BigInt(total) > opened.size) reject("source_changed");
      hash.update(buffer.subarray(0, length));
      let written = 0;
      while (written < length) {
        const count = writeSync(destinationFd, buffer, written, length - written, null);
        if (!Number.isSafeInteger(count) || count < 1) reject("copy_failed");
        written += count;
      }
    }
    const after = fstatSync(sourceFd, { bigint: true });
    const afterPath = lstatSync(source, { bigint: true });
    if (
      BigInt(total) !== opened.size ||
      !sameIdentity(opened, after) ||
      !sameIdentity(opened, afterPath)
    ) {
      reject("source_changed");
    }
    fsyncSync(destinationFd);
    const copied = fstatSync(destinationFd, { bigint: true });
    const copiedPath = lstatSync(destination, { bigint: true });
    if (
      !copied.isFile() ||
      copied.nlink !== 1n ||
      sizeAsNumber(copied) !== total ||
      fileTypeMode(copied) !== destinationMode ||
      !sameIdentity(copied, copiedPath)
    ) {
      reject("copy_verification_failed");
    }
    return { sha256: hash.digest("hex"), size: total };
  } finally {
    if (destinationFd !== null) closeSync(destinationFd);
    closeSync(sourceFd);
  }
}

function copyTree(sourceRoot, destinationRoot, expectedSourceOwner) {
  const root = lstatSync(sourceRoot, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink()) reject("invalid_state_root");
  const rootDevice = root.dev;
  const directories = [];
  const files = [];
  let entries = 0;
  let bytes = 0;

  function walk(sourceDirectory, destinationDirectory, depth) {
    if (depth > MAX_DEPTH) reject("state_depth_limit");
    const before = lstatSync(sourceDirectory, { bigint: true });
    if (depth === 0 && !sameIdentity(root, before)) reject("source_changed");
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      before.dev !== rootDevice ||
      fileTypeMode(before) !== STATE_DIRECTORY_MODE ||
      before.uid !== BigInt(expectedSourceOwner.uid) ||
      before.gid !== BigInt(expectedSourceOwner.gid)
    ) {
      reject("unsafe_state_tree");
    }
    const opened = openDirectory(sourceDirectory);
    try {
      if (!sameIdentity(before, opened.stat)) reject("source_changed");
      const names = readdirSync(sourceDirectory).sort(compareText);
      for (const name of names) {
        if (!safeComponent(name)) reject("unsafe_state_path");
        if (transientStateName(name)) reject("temporary_state_entry");
        entries += 1;
        if (entries > MAX_ENTRIES) reject("state_entry_limit");
        const sourcePath = join(sourceDirectory, name);
        const destinationPath = join(destinationDirectory, name);
        const stat = lstatSync(sourcePath, { bigint: true });
        if (stat.dev !== rootDevice || stat.isSymbolicLink()) {
          reject("unsafe_state_tree");
        }
        const path = relativeName(sourceRoot, sourcePath);
        if (stat.isDirectory()) {
          createDirectory(destinationPath, STATE_DIRECTORY_MODE);
          directories.push(path);
          walk(sourcePath, destinationPath, depth + 1);
        } else if (stat.isFile() && stat.nlink === 1n) {
          const copied = copyFile(sourcePath, destinationPath, stat, {
            destinationMode: SNAPSHOT_FILE_MODE,
            expectedSourceMode: STATE_FILE_MODE,
            expectedSourceOwner,
          });
          bytes = safeAdd(bytes, copied.size);
          files.push({ path, size: copied.size, sha256: copied.sha256 });
        } else {
          reject("unsafe_state_tree");
        }
      }
      const after = fstatSync(opened.fd, { bigint: true });
      const afterPath = lstatSync(sourceDirectory, { bigint: true });
      if (!sameIdentity(opened.stat, after) || !sameIdentity(opened.stat, afterPath)) {
        reject("source_changed");
      }
    } finally {
      closeSync(opened.fd);
    }
    setDirectoryMetadata(destinationDirectory, SNAPSHOT_DIRECTORY_MODE);
  }

  walk(sourceRoot, destinationRoot, 0);
  directories.sort(compareText);
  files.sort((left, right) => compareText(left.path, right.path));
  return {
    directories,
    files,
    totals: { bytes, directories: directories.length + 1, files: files.length },
  };
}

function writeExclusive(path, body, mode = SNAPSHOT_FILE_MODE) {
  const bytes = Buffer.from(body, "utf8");
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    fchmodSync(fd, mode);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(count) || count < 1) reject("control_write_failed");
      offset += count;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readSmallRegular(
  path,
  maxBytes,
  mode = SNAPSHOT_FILE_MODE,
  expectedOwner = null,
  invalidUtf8Code = "snapshot_control_invalid",
) {
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    fileTypeMode(before) !== mode ||
    (expectedOwner &&
      (before.uid !== BigInt(expectedOwner.uid) ||
        before.gid !== BigInt(expectedOwner.gid))) ||
    before.size > BigInt(maxBytes)
  ) {
    reject("snapshot_control_invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameIdentity(before, opened)) reject("snapshot_changed");
    const size = sizeAsNumber(opened);
    const value = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const length = readSync(fd, value, offset, size - offset, null);
      if (length === 0) reject("snapshot_changed");
      offset += length;
    }
    const after = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (!sameIdentity(opened, after) || !sameIdentity(opened, afterPath)) {
      reject("snapshot_changed");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      reject(invalidUtf8Code);
    }
  } finally {
    closeSync(fd);
  }
}

function validManifestPathOrder(values) {
  return values.every(
    (value, index) =>
      safeRelativePath(value) && (index === 0 || values[index - 1] < value),
  );
}

function validateManifest(value, raw) {
  if (
    !exactKeys(value, [
      "version",
      "activeTaskCount",
      "createdAt",
      "directories",
      "files",
      "sourceTreeSha256",
      "totals",
    ]) ||
    value.version !== FORMAT_VERSION ||
    value.activeTaskCount !== 0 ||
    !nonEmptyString(value.createdAt) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    !Array.isArray(value.directories) ||
    !Array.isArray(value.files) ||
    !SHA256.test(value.sourceTreeSha256) ||
    !exactKeys(value.totals, ["bytes", "directories", "files"]) ||
    raw !== canonicalJson(value)
  ) {
    reject("manifest_invalid");
  }
  if (!validManifestPathOrder(value.directories)) reject("manifest_invalid");
  if (
    value.directories.length + value.files.length > MAX_ENTRIES ||
    value.totals.directories !== value.directories.length + 1 ||
    value.totals.files !== value.files.length ||
    !Number.isSafeInteger(value.totals.bytes) ||
    value.totals.bytes < 0
  ) {
    reject("manifest_invalid");
  }
  const directorySet = new Set(value.directories);
  let totalBytes = 0;
  const filePaths = [];
  for (const entry of value.files) {
    if (
      !exactKeys(entry, [
        "relativePath",
        "type",
        "mode",
        "size",
        "hash",
        "count",
        "lastSeq",
        "projectionHash",
      ]) ||
      !safeRelativePath(entry.relativePath) ||
      !["event-log", "json", "opaque", "remote-placement", "terminal-request"].includes(
        entry.type,
      ) ||
      entry.mode !== SNAPSHOT_FILE_MODE ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !SHA256.test(entry.hash) ||
      !Number.isSafeInteger(entry.count) ||
      entry.count < 0 ||
      (entry.lastSeq !== null &&
        (!Number.isSafeInteger(entry.lastSeq) || entry.lastSeq < 0)) ||
      (entry.projectionHash !== null && !SHA256.test(entry.projectionHash))
    ) {
      reject("manifest_invalid");
    }
    if (
      (entry.type === "event-log" &&
        (entry.lastSeq !== entry.count || entry.projectionHash === null)) ||
      (entry.type !== "event-log" &&
        (entry.lastSeq !== null || entry.projectionHash !== null)) ||
      (entry.type === "terminal-request" && entry.count !== 1) ||
      (["json", "opaque"].includes(entry.type) && entry.count !== 0)
    ) {
      reject("manifest_invalid");
    }
    filePaths.push(entry.relativePath);
    totalBytes = safeAdd(totalBytes, entry.size);
    const parent = entry.relativePath.includes("/")
      ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf("/"))
      : "";
    if (parent !== "" && !directorySet.has(parent)) reject("manifest_invalid");
  }
  if (!validManifestPathOrder(filePaths) || totalBytes !== value.totals.bytes) {
    reject("manifest_invalid");
  }
  const fileSet = new Set(filePaths);
  for (const directory of value.directories) {
    const parent = directory.includes("/")
      ? directory.slice(0, directory.lastIndexOf("/"))
      : "";
    if ((parent !== "" && !directorySet.has(parent)) || fileSet.has(directory)) {
      reject("manifest_invalid");
    }
  }
  return value;
}

function parseManifest(snapshotRoot, expectedOwner) {
  const raw = readSmallRegular(
    join(snapshotRoot, "manifest.json"),
    MAX_MANIFEST_BYTES,
    SNAPSHOT_FILE_MODE,
    expectedOwner,
    "manifest_invalid",
  );
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    reject("manifest_invalid");
  }
  const manifest = validateManifest(value, raw);
  const digest = sha256(raw);
  const checksum = readSmallRegular(
    join(snapshotRoot, "manifest.sha256"),
    66,
    SNAPSHOT_FILE_MODE,
    expectedOwner,
  );
  const complete = readSmallRegular(
    join(snapshotRoot, "COMPLETE"),
    80,
    SNAPSHOT_FILE_MODE,
    expectedOwner,
  );
  if (checksum !== `${digest}\n` || complete !== `v1 ${digest}\n`) {
    reject("snapshot_incomplete");
  }
  return { digest, manifest };
}

function validDate(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function validatePlacement(value) {
  if (
    !exactKeys(value, ["version", "placements"]) ||
    value.version !== 1 ||
    !plainObject(value.placements)
  ) {
    reject("placement_invalid");
  }
  for (const [key, record] of Object.entries(value.placements)) {
    if (
      !exactKeys(record, ["user", "project", "agent", "hostId", "updatedAt"]) ||
      ![record.user, record.project, record.agent, record.hostId].every(nonEmptyString) ||
      !validDate(record.updatedAt) ||
      key !== JSON.stringify([record.user, record.project, record.agent])
    ) {
      reject("placement_invalid");
    }
  }
  return Object.keys(value.placements).length;
}

function validResult(value, requestId) {
  return (
    exactKeys(value, ["requestId", "text", "sessionId", "ms", "fresh"]) &&
    value.requestId === requestId &&
    typeof value.text === "string" &&
    (value.sessionId === null || nonEmptyString(value.sessionId)) &&
    Number.isFinite(value.ms) &&
    value.ms >= 0 &&
    typeof value.fresh === "boolean"
  );
}

function validError(value, requestId) {
  return (
    exactKeys(value, ["requestId", "code", "message", "retryable"]) &&
    value.requestId === requestId &&
    RUNNER_ERROR_CODES.has(value.code) &&
    nonEmptyString(value.message) &&
    typeof value.retryable === "boolean"
  );
}

function validLedgerEvent(event, requestId, sequence) {
  if (
    !plainObject(event) ||
    event.requestId !== requestId ||
    event.sequence !== sequence ||
    !validDate(event.at) ||
    !nonEmptyString(event.kind)
  ) {
    return false;
  }
  if (event.kind === "started") {
    return (
      exactKeys(event, ["requestId", "sequence", "at", "kind", "fresh"]) &&
      typeof event.fresh === "boolean"
    );
  }
  if (event.kind === "delta" || event.kind === "thought") {
    return (
      exactKeys(event, ["requestId", "sequence", "at", "kind", "text"]) &&
      typeof event.text === "string" &&
      event.text.length > 0
    );
  }
  if (event.kind === "progress") {
    return (
      exactKeys(event, ["requestId", "sequence", "at", "kind", "label"]) &&
      nonEmptyString(event.label)
    );
  }
  if (event.kind === "usage") {
    const fields = ["input", "output", "total", "window", "costUsd"].filter(
      (field) => event[field] !== undefined,
    );
    return (
      exactKeys(event, ["requestId", "sequence", "at", "kind", ...fields]) &&
      fields.every((field) => Number.isFinite(event[field]) && event[field] >= 0)
    );
  }
  if (event.kind === "completed") {
    return (
      exactKeys(event, ["requestId", "sequence", "at", "kind", "result"]) &&
      validResult(event.result, requestId)
    );
  }
  if (event.kind === "failed") {
    return (
      exactKeys(event, ["requestId", "sequence", "at", "kind", "error"]) &&
      validError(event.error, requestId)
    );
  }
  return false;
}

function validateLedger(path, value) {
  if (
    !exactKeys(value, ["version", "request"]) ||
    value.version !== 1 ||
    !plainObject(value.request)
  ) {
    reject("request_ledger_invalid");
  }
  const record = value.request;
  if (["pending", "offered", "inflight", "queued", "running"].includes(record.state)) {
    reject("active_tasks_present");
  }
  const terminal = ["completed", "failed", "cancelled"].includes(record.state);
  const valueField = record.state === "completed" ? "result" : "error";
  if (
    !terminal ||
    !exactKeys(record, [
      "requestId",
      "fingerprint",
      "state",
      "events",
      "updatedAt",
      valueField,
    ]) ||
    !nonEmptyString(record.requestId) ||
    !SHA256.test(record.fingerprint) ||
    !Array.isArray(record.events) ||
    record.events.length === 0 ||
    !validDate(record.updatedAt) ||
    record.events.some(
      (event, index) => !validLedgerEvent(event, record.requestId, index + 1),
    ) ||
    (record.state === "completed"
      ? !validResult(record.result, record.requestId) ||
        record.events.at(-1)?.kind !== "completed"
      : !validError(record.error, record.requestId) ||
        record.events.at(-1)?.kind !== "failed")
  ) {
    reject("request_ledger_invalid");
  }
  const expectedPath = `${LEDGER_DIRECTORY}/${sha256(record.requestId)}.json`;
  if (path !== expectedPath) reject("request_ledger_invalid");
}

function validateEventEnvelope(value, sequence, ids) {
  const expected = ["id", "type", "seq", "project", "actor", "at", "payload"];
  if (value?.subject !== undefined) expected.push("subject");
  if (value?.causedBy !== undefined) expected.push("causedBy");
  if (
    !exactKeys(value, expected) ||
    !nonEmptyString(value.id) ||
    Buffer.byteLength(value.id, "utf8") > 256 ||
    ids.has(value.id) ||
    !EVENT_TYPES.has(value.type) ||
    value.seq !== sequence ||
    !nonEmptyString(value.project) ||
    !exactKeys(value.actor, ["kind", "id"]) ||
    !["agent", "human", "system"].includes(value.actor.kind) ||
    !nonEmptyString(value.actor.id) ||
    !validDate(value.at) ||
    !plainObject(value.payload) ||
    (value.subject !== undefined &&
      (!exactKeys(value.subject, ["kind", "id"]) ||
        !nonEmptyString(value.subject.kind) ||
        !nonEmptyString(value.subject.id))) ||
    (value.causedBy !== undefined && !nonEmptyString(value.causedBy))
  ) {
    reject("event_log_invalid");
  }
  ids.add(value.id);
  if (value.type === "agent.registered") {
    if (
      ![value.payload.id, value.payload.name, value.payload.provider].every(
        nonEmptyString,
      ) ||
      !Array.isArray(value.payload.capabilities) ||
      value.payload.capabilities.some((item) => !nonEmptyString(item))
    ) {
      reject("event_log_invalid");
    }
    if (
      value.subject !== undefined &&
      (value.subject.kind !== "agent" || value.subject.id !== value.payload.id)
    ) {
      reject("event_log_invalid");
    }
  }
  if (TASK_STATUS[value.type]) {
    const taskId = value.subject?.id ?? value.payload.task;
    if (
      !nonEmptyString(taskId) ||
      (value.subject !== undefined && value.subject.kind !== "task") ||
      (value.subject !== undefined &&
        value.payload.task !== undefined &&
        value.payload.task !== value.subject.id) ||
      (value.payload.title !== undefined && !nonEmptyString(value.payload.title)) ||
      (value.payload.requires !== undefined &&
        (!Array.isArray(value.payload.requires) ||
          value.payload.requires.some((item) => !nonEmptyString(item)))) ||
      (value.payload.executor !== undefined &&
        value.payload.executor !== null &&
        !nonEmptyString(value.payload.executor))
    ) {
      reject("event_log_invalid");
    }
  }
  if (
    value.type === "message.sent" &&
    (![value.payload.from, value.payload.to, value.payload.type].every(nonEmptyString) ||
      typeof value.payload.content !== "string" ||
      value.payload.content.length === 0)
  ) {
    reject("event_log_invalid");
  }
}

function emptyOfflineProjection() {
  return {
    items: [],
    agents: Object.create(null),
    tasks: Object.create(null),
  };
}

function offlineLifecycleLabel(event, task) {
  switch (event.type) {
    case "task.created":
      return `建了任务 ${task.id}：${task.title}`;
    case "task.assigned":
      return `${task.id} 指派给 ${task.executor ?? "—"}`;
    case "task.started":
      return `${task.executor ?? "—"} 开始做 ${task.id}`;
    case "task.blocked":
      return `${task.id} 被阻塞`;
    case "task.unblocked":
      return `${task.id} 解除阻塞`;
    case "task.review.requested":
      return `${task.id} 交付待验收`;
    case "task.completed":
      return `${task.id} 已验收`;
    case "task.failed":
      return `${task.id} 失败`;
    case "task.cancelled":
      return `${task.id} 已取消`;
    default:
      reject("event_log_invalid");
  }
}

function applyOfflineProjection(state, event, itemsById) {
  if (event.type === "agent.registered") {
    const { id, name, provider, capabilities, integration } = event.payload;
    state.agents[id] = { id, name, provider, capabilities, integration };
    const item = {
      kind: "divider",
      id: event.id,
      at: event.at,
      seq: event.seq,
      label: `${name} 加入会话`,
      tone: "neutral",
    };
    state.items.push(item);
    itemsById.set(event.id, item);
    return;
  }
  const status = TASK_STATUS[event.type];
  if (status) {
    const id = event.subject?.id ?? event.payload.task;
    const prior = state.tasks[id] ?? {
      id,
      title: id,
      requires: [],
      executor: null,
    };
    state.tasks[id] = {
      ...prior,
      ...(event.payload.title ? { title: event.payload.title } : {}),
      ...(event.payload.requires ? { requires: event.payload.requires } : {}),
      ...(event.payload.executor !== undefined
        ? { executor: event.payload.executor }
        : {}),
      status,
    };
    const item = {
      kind: "lifecycle",
      id: event.id,
      at: event.at,
      seq: event.seq,
      task: id,
      status,
      label: offlineLifecycleLabel(event, state.tasks[id]),
      actorKind: event.actor.kind,
    };
    state.items.push(item);
    itemsById.set(event.id, item);
    return;
  }
  if (event.type === "message.sent") {
    const cause = event.causedBy ? itemsById.get(event.causedBy) : undefined;
    const depth = cause ? (cause.depth ?? 0) + 1 : 0;
    const ms = cause ? Date.parse(event.at) - Date.parse(cause.at) : undefined;
    const message = {
      kind: "message",
      id: event.id,
      at: event.at,
      seq: event.seq,
      actorKind: event.actor.kind,
      from: event.payload.from,
      to: event.payload.to,
      messageType: event.payload.type,
      text: event.payload.content,
      agent: state.agents[event.payload.from] ?? null,
      task: event.payload.task ?? null,
      causedBy: event.causedBy ?? null,
      depth,
      ...(ms !== undefined ? { ms } : {}),
    };
    state.items.push(message);
    itemsById.set(event.id, message);
  }
}

function createJsonLinesValidator() {
  const ids = new Set();
  const projection = emptyOfflineProjection();
  const itemsById = new Map();
  let projectId = null;
  let pending = Buffer.alloc(0);
  let sequence = 0;
  function activeTaskCount() {
    return Object.values(projection.tasks).filter((task) =>
      ["assigned", "running"].includes(task.status),
    ).length;
  }
  function rejectInvalidLog() {
    if (activeTaskCount() !== 0) reject("active_tasks_present");
    reject("event_log_invalid");
  }
  function parseLine(line) {
    if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_JSON_BYTES) {
      rejectInvalidLog();
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      rejectInvalidLog();
    }
    try {
      sequence += 1;
      if (sequence > MAX_EVENT_RECORDS || !plainObject(value)) {
        reject("event_log_invalid");
      }
      validateEventEnvelope(value, sequence, ids);
      if (projectId === null) projectId = value.project;
      if (value.project !== projectId) reject("event_log_invalid");
      applyOfflineProjection(projection, value, itemsById);
    } catch (error) {
      if (error instanceof SnapshotError && error.code === "event_log_invalid") {
        rejectInvalidLog();
      }
      throw error;
    }
  }
  return {
    finish() {
      if (pending.length !== 0) rejectInvalidLog();
      return {
        count: sequence,
        lastSeq: sequence,
        projectionHash: sha256(canonicalJson(projection)),
        activeTaskCount: activeTaskCount(),
      };
    },
    push(bytes) {
      pending = Buffer.concat([pending, bytes]);
      while (true) {
        const end = pending.indexOf(0x0a);
        if (end === -1) {
          if (pending.length > MAX_JSON_BYTES) rejectInvalidLog();
          return;
        }
        let line;
        try {
          line = new TextDecoder("utf-8", { fatal: true }).decode(
            pending.subarray(0, end),
          );
        } catch {
          rejectInvalidLog();
        }
        pending = pending.subarray(end + 1);
        parseLine(line);
      }
    },
  };
}

function inspectDataFile(
  path,
  relativePath,
  expected,
  { expectedOwner = null, fileMode },
) {
  if (
    relativePath.startsWith(`${LEDGER_DIRECTORY}/`) &&
    !LEDGER_PATH.test(relativePath)
  ) {
    reject("request_ledger_invalid");
  }
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    fileTypeMode(before) !== fileMode ||
    (expectedOwner &&
      (before.uid !== BigInt(expectedOwner.uid) ||
        before.gid !== BigInt(expectedOwner.gid)))
  ) {
    reject("snapshot_data_invalid");
  }
  if (sizeAsNumber(before) !== expected.size) reject("snapshot_data_mismatch");
  const collectJson = relativePath.endsWith(".json");
  if (collectJson && expected.size > MAX_JSON_BYTES) reject("json_state_invalid");
  const jsonChunks = [];
  const lines = relativePath.endsWith(".jsonl") ? createJsonLinesValidator() : null;
  let digest;
  let eventSummary = null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameIdentity(before, opened)) reject("snapshot_changed");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let total = 0;
    while (true) {
      const length = readSync(fd, buffer, 0, buffer.length, null);
      if (length === 0) break;
      total = safeAdd(total, length);
      const chunk = buffer.subarray(0, length);
      hash.update(chunk);
      if (collectJson) jsonChunks.push(Buffer.from(chunk));
      lines?.push(chunk);
    }
    eventSummary = lines?.finish() ?? null;
    const after = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    digest = hash.digest("hex");
    if (
      total !== expected.size ||
      !sameIdentity(opened, after) ||
      !sameIdentity(opened, afterPath) ||
      (expected.hash !== null && digest !== expected.hash)
    ) {
      reject("snapshot_data_mismatch");
    }
  } finally {
    closeSync(fd);
  }
  let placementCount = 0;
  let requestCount = 0;
  if (collectJson) {
    let value;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(jsonChunks)),
      );
    } catch {
      reject("json_state_invalid");
    }
    if (relativePath === "remote-placement.json") {
      placementCount = validatePlacement(value);
    }
    if (relativePath.startsWith(`${LEDGER_DIRECTORY}/`)) {
      validateLedger(relativePath, value);
      requestCount = 1;
    }
  }
  const type = eventSummary
    ? "event-log"
    : relativePath === "remote-placement.json"
      ? "remote-placement"
      : relativePath.startsWith(`${LEDGER_DIRECTORY}/`)
        ? "terminal-request"
        : collectJson
          ? "json"
          : "opaque";
  return {
    hash: digest,
    type,
    count: eventSummary?.count ?? placementCount + requestCount,
    lastSeq: eventSummary?.lastSeq ?? null,
    projectionHash: eventSummary?.projectionHash ?? null,
    activeTaskCount: eventSummary?.activeTaskCount ?? 0,
    eventCount: eventSummary?.count ?? 0,
    placementCount,
    requestCount,
  };
}

function measureTree(sourcePath, expectedOwner = null) {
  const { path: sourceRoot, stat: root } = exactExistingDirectory(
    sourcePath,
    "invalid_state_root",
  );
  if (
    fileTypeMode(root) !== STATE_DIRECTORY_MODE ||
    (expectedOwner &&
      (root.uid !== BigInt(expectedOwner.uid) || root.gid !== BigInt(expectedOwner.gid)))
  ) {
    reject("snapshot_data_invalid");
  }
  const rootDevice = root.dev;
  const directories = [];
  const files = [];
  const fingerprintDirectories = [
    {
      relativePath: ".",
      mode: STATE_DIRECTORY_MODE,
      uid: Number(root.uid),
      gid: Number(root.gid),
    },
  ];
  let entryCount = 1;
  let eventCount = 0;
  let placementCount = 0;
  let requestCount = 0;
  let activeTaskCount = 0;
  let totalBytes = 0;

  function walk(directory, depth) {
    if (depth > MAX_DEPTH) reject("state_depth_limit");
    const before = lstatSync(directory, { bigint: true });
    if (depth === 0 && !sameIdentity(root, before)) reject("source_changed");
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      before.dev !== rootDevice ||
      fileTypeMode(before) !== STATE_DIRECTORY_MODE ||
      (expectedOwner &&
        (before.uid !== BigInt(expectedOwner.uid) ||
          before.gid !== BigInt(expectedOwner.gid)))
    ) {
      reject("snapshot_data_invalid");
    }
    const opened = openDirectory(directory);
    try {
      if (!sameIdentity(before, opened.stat)) reject("source_changed");
      for (const name of readdirSync(directory).sort(compareText)) {
        if (!safeComponent(name)) reject("unsafe_state_path");
        if (transientStateName(name)) reject("temporary_state_entry");
        entryCount += 1;
        if (entryCount - 1 > MAX_ENTRIES) reject("state_entry_limit");
        const path = join(directory, name);
        const stat = lstatSync(path, { bigint: true });
        if (stat.dev !== rootDevice || stat.isSymbolicLink()) {
          reject("unsafe_state_tree");
        }
        const relativePath = relativeName(sourceRoot, path);
        if (stat.isDirectory()) {
          directories.push(relativePath);
          fingerprintDirectories.push({
            relativePath,
            mode: STATE_DIRECTORY_MODE,
            uid: Number(stat.uid),
            gid: Number(stat.gid),
          });
          walk(path, depth + 1);
        } else if (stat.isFile() && stat.nlink === 1n) {
          const size = sizeAsNumber(stat);
          const inspected = inspectDataFile(
            path,
            relativePath,
            { size, hash: null },
            { expectedOwner, fileMode: STATE_FILE_MODE },
          );
          totalBytes = safeAdd(totalBytes, size);
          eventCount = safeAdd(eventCount, inspected.eventCount);
          placementCount = safeAdd(placementCount, inspected.placementCount);
          requestCount = safeAdd(requestCount, inspected.requestCount);
          activeTaskCount = safeAdd(activeTaskCount, inspected.activeTaskCount);
          files.push({
            relativePath,
            type: inspected.type,
            mode: STATE_FILE_MODE,
            size,
            hash: inspected.hash,
            count: inspected.count,
            lastSeq: inspected.lastSeq,
            projectionHash: inspected.projectionHash,
            uid: Number(stat.uid),
            gid: Number(stat.gid),
          });
        } else {
          reject("unsafe_state_tree");
        }
      }
      const after = fstatSync(opened.fd, { bigint: true });
      const afterPath = lstatSync(directory, { bigint: true });
      if (!sameIdentity(opened.stat, after) || !sameIdentity(opened.stat, afterPath)) {
        reject("source_changed");
      }
    } finally {
      closeSync(opened.fd);
    }
  }

  walk(sourceRoot, 0);
  directories.sort(compareText);
  if (directories.some((path) => path.startsWith(`${LEDGER_DIRECTORY}/`))) {
    reject("request_ledger_invalid");
  }
  fingerprintDirectories.sort((left, right) =>
    compareText(left.relativePath, right.relativePath),
  );
  files.sort((left, right) => compareText(left.relativePath, right.relativePath));
  if (activeTaskCount !== 0) reject("active_tasks_present");
  const treeSha256 = sha256(
    canonicalJson({
      directories: fingerprintDirectories,
      files,
      version: FORMAT_VERSION,
    }),
  );
  return {
    entryCount,
    fileCount: files.length,
    totalBytes,
    eventCount,
    placementCount,
    requestCount,
    treeSha256,
  };
}

function verifyDataTree(
  dataRoot,
  manifest,
  { directoryMode, fileMode, owner: expectedOwner = null },
) {
  const root = lstatSync(dataRoot, { bigint: true });
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    fileTypeMode(root) !== directoryMode ||
    (expectedOwner &&
      (root.uid !== BigInt(expectedOwner.uid) || root.gid !== BigInt(expectedOwner.gid)))
  ) {
    reject("snapshot_data_invalid");
  }
  const rootDevice = root.dev;
  const actualDirectories = [];
  const actualFiles = [];
  const details = new Map();
  let activeTaskCount = 0;
  const expectedFiles = new Map(
    manifest.files.map((entry) => [entry.relativePath ?? entry.path, entry]),
  );
  let entries = 0;

  function walk(directory, depth) {
    if (depth > MAX_DEPTH) reject("state_depth_limit");
    const before = lstatSync(directory, { bigint: true });
    if (depth === 0 && !sameIdentity(root, before)) reject("snapshot_changed");
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      before.dev !== rootDevice ||
      fileTypeMode(before) !== directoryMode ||
      (expectedOwner &&
        (before.uid !== BigInt(expectedOwner.uid) ||
          before.gid !== BigInt(expectedOwner.gid)))
    ) {
      reject("snapshot_data_invalid");
    }
    const opened = openDirectory(directory);
    try {
      if (!sameIdentity(before, opened.stat)) reject("snapshot_changed");
      for (const name of readdirSync(directory).sort(compareText)) {
        if (!safeComponent(name)) reject("unsafe_state_path");
        if (transientStateName(name)) reject("temporary_state_entry");
        entries += 1;
        if (entries > MAX_ENTRIES) reject("state_entry_limit");
        const path = join(directory, name);
        const stat = lstatSync(path, { bigint: true });
        if (stat.dev !== rootDevice || stat.isSymbolicLink()) {
          reject("snapshot_data_invalid");
        }
        const relativePath = relativeName(dataRoot, path);
        if (stat.isDirectory()) {
          actualDirectories.push(relativePath);
          walk(path, depth + 1);
        } else if (stat.isFile() && stat.nlink === 1n) {
          const expected = expectedFiles.get(relativePath);
          if (!expected) reject("snapshot_extra_entry");
          actualFiles.push(relativePath);
          const inspected = inspectDataFile(path, relativePath, expected, {
            expectedOwner,
            fileMode,
          });
          if (inspected.activeTaskCount !== 0) reject("active_tasks_present");
          if (
            expected.type !== undefined &&
            (expected.type !== inspected.type ||
              expected.count !== inspected.count ||
              expected.lastSeq !== inspected.lastSeq ||
              expected.projectionHash !== inspected.projectionHash)
          ) {
            reject("snapshot_semantic_mismatch");
          }
          details.set(relativePath, inspected);
          activeTaskCount = safeAdd(activeTaskCount, inspected.activeTaskCount);
        } else {
          reject("snapshot_data_invalid");
        }
      }
      const after = fstatSync(opened.fd, { bigint: true });
      const afterPath = lstatSync(directory, { bigint: true });
      if (!sameIdentity(opened.stat, after) || !sameIdentity(opened.stat, afterPath)) {
        reject("snapshot_changed");
      }
    } finally {
      closeSync(opened.fd);
    }
  }

  walk(dataRoot, 0);
  actualDirectories.sort(compareText);
  if (actualDirectories.some((path) => path.startsWith(`${LEDGER_DIRECTORY}/`))) {
    reject("request_ledger_invalid");
  }
  actualFiles.sort(compareText);
  if (
    actualDirectories.length !== manifest.directories.length ||
    actualDirectories.some((value, index) => value !== manifest.directories[index]) ||
    actualFiles.length !== manifest.files.length ||
    actualFiles.some(
      (value, index) =>
        value !== (manifest.files[index].relativePath ?? manifest.files[index].path),
    )
  ) {
    reject("snapshot_entry_mismatch");
  }
  if (activeTaskCount !== 0) reject("active_tasks_present");
  return { activeTaskCount, details };
}

function verifySnapshot(snapshotPath) {
  const { stat } = exactExistingDirectory(snapshotPath, "snapshot_invalid");
  if (fileTypeMode(stat) !== SNAPSHOT_DIRECTORY_MODE) reject("snapshot_invalid");
  const opened = openDirectory(snapshotPath);
  const snapshotOwner = { uid: Number(stat.uid), gid: Number(stat.gid) };
  try {
    if (!sameIdentity(stat, opened.stat)) reject("snapshot_changed");
    const names = readdirSync(snapshotPath).sort(compareText);
    const expectedNames = ["COMPLETE", "data", "manifest.json", "manifest.sha256"].sort(
      compareText,
    );
    if (
      names.length !== expectedNames.length ||
      names.some((name, index) => name !== expectedNames[index])
    ) {
      reject("snapshot_extra_entry");
    }
    if (
      names.some(
        (name) => lstatSync(join(snapshotPath, name), { bigint: true }).dev !== stat.dev,
      )
    ) {
      reject("snapshot_invalid");
    }
    const { digest, manifest } = parseManifest(snapshotPath, snapshotOwner);
    verifyDataTree(join(snapshotPath, "data"), manifest, {
      directoryMode: SNAPSHOT_DIRECTORY_MODE,
      fileMode: SNAPSHOT_FILE_MODE,
      owner: snapshotOwner,
    });
    const after = fstatSync(opened.fd, { bigint: true });
    const afterPath = lstatSync(snapshotPath, { bigint: true });
    if (!sameIdentity(opened.stat, after) || !sameIdentity(opened.stat, afterPath)) {
      reject("snapshot_changed");
    }
    return { digest, manifest };
  } finally {
    closeSync(opened.fd);
  }
}

function lockName(targetPath) {
  return `.state-snapshot-${sha256(basename(targetPath)).slice(0, 24)}.lock`;
}

function procStarttime(pid) {
  if (process.platform !== "linux") return Object.freeze({ status: "portable" });
  const path = `/proc/${pid}/stat`;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = Buffer.alloc(4096);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count < 1 || count === bytes.length) {
      return Object.freeze({ status: "unknown" });
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, count),
    );
    const commandEnd = text.lastIndexOf(") ");
    if (commandEnd < 1) return Object.freeze({ status: "unknown" });
    const fields = text
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/u);
    const starttime = fields[19];
    return /^[0-9]+$/u.test(starttime ?? "")
      ? Object.freeze({ status: "read", value: starttime })
      : Object.freeze({ status: "unknown" });
  } catch (error) {
    return Object.freeze({
      status: error?.code === "ENOENT" || error?.code === "ESRCH" ? "absent" : "unknown",
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function lockOwnerState(record) {
  if (process.platform === "linux") {
    const current = procStarttime(record.pid);
    if (current.status === "absent") return "dead";
    if (current.status !== "read") return "unknown";
    return current.value === record.starttime ? "alive" : "dead";
  }
  try {
    process.kill(record.pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "dead";
    return "unknown";
  }
}

function readPublishLock(lockPath, expectedOwner) {
  const before = lstatSync(lockPath, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== BigInt(expectedOwner.uid) ||
    before.gid !== BigInt(expectedOwner.gid) ||
    before.nlink !== 2n ||
    fileTypeMode(before) !== PUBLISH_LOCK_MODE ||
    before.size > BigInt(MAX_PUBLISH_LOCK_BYTES)
  ) {
    reject("publish_locked");
  }
  const fd = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameIdentity(before, opened)) reject("publish_locked");
    const bytes = Buffer.alloc(sizeAsNumber(opened));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count < 1) reject("publish_locked");
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(lockPath, { bigint: true });
    if (!sameIdentity(opened, after) || !sameIdentity(opened, afterPath)) {
      reject("publish_locked");
    }
    let record;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      record = JSON.parse(text);
    } catch {
      reject("publish_locked");
    }
    if (
      !exactKeys(record, [
        "nonce",
        "ownerName",
        "pid",
        "starttime",
        "targetSha256",
        "version",
      ]) ||
      record.version !== PUBLISH_LOCK_VERSION ||
      !Number.isSafeInteger(record.pid) ||
      record.pid < 1 ||
      !(
        /^[0-9]+$/u.test(record.starttime) ||
        (process.platform !== "linux" && record.starttime === "portable")
      ) ||
      !/^[a-f0-9-]{36}$/u.test(record.nonce) ||
      !/^\.state-snapshot-owner-[a-f0-9]{24}-[a-f0-9-]{36}\.tmp$/u.test(
        record.ownerName,
      ) ||
      !SHA256.test(record.targetSha256)
    ) {
      reject("publish_locked");
    }
    return Object.freeze({ record, stat: opened });
  } finally {
    closeSync(fd);
  }
}

function reclaimStalePublishLock(
  parent,
  lockPath,
  expectedTargetSha256,
  owner,
  ownerState,
) {
  const observed = readPublishLock(lockPath, owner);
  if (observed.record.targetSha256 !== expectedTargetSha256) {
    reject("publish_locked");
  }
  const ownerPath = join(parent, observed.record.ownerName);
  const ownerStat = lstatSync(ownerPath, { bigint: true });
  if (!sameIdentity(observed.stat, ownerStat) || ownerState(observed.record) !== "dead") {
    reject("publish_locked");
  }
  unlinkSync(lockPath);
  syncDirectory(parent);
  const ownerAfter = lstatSync(ownerPath, { bigint: true });
  if (
    !ownerAfter.isFile() ||
    ownerAfter.isSymbolicLink() ||
    ownerAfter.nlink !== 1n ||
    ownerAfter.dev !== ownerStat.dev ||
    ownerAfter.ino !== ownerStat.ino ||
    ownerAfter.uid !== ownerStat.uid ||
    ownerAfter.gid !== ownerStat.gid ||
    fileTypeMode(ownerAfter) !== PUBLISH_LOCK_MODE
  ) {
    reject("publish_locked");
  }
  unlinkSync(ownerPath);
  syncDirectory(parent);
}

export function withPublishLock(
  targetPath,
  operation,
  { ownerState = lockOwnerState, selfStarttime = procStarttime } = {},
) {
  const parent = dirname(targetPath);
  const lockPath = join(parent, lockName(targetPath));
  const targetSha256 = sha256(targetPath);
  const nonce = randomUUID();
  const ownerName = `.state-snapshot-owner-${targetSha256.slice(0, 24)}-${nonce}.tmp`;
  const ownerPath = join(parent, ownerName);
  const owner = {
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
  };
  const selfStarttimeEvidence = selfStarttime(process.pid);
  if (
    (process.platform === "linux" && selfStarttimeEvidence.status !== "read") ||
    (process.platform !== "linux" && selfStarttimeEvidence.status !== "portable")
  ) {
    reject("publish_locked");
  }
  const starttime =
    selfStarttimeEvidence.status === "read" ? selfStarttimeEvidence.value : "portable";
  const record = canonicalJson({
    version: PUBLISH_LOCK_VERSION,
    nonce,
    ownerName,
    pid: process.pid,
    starttime,
    targetSha256,
  });
  try {
    writeExclusive(ownerPath, record, PUBLISH_LOCK_MODE);
    syncDirectory(parent);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        linkSync(ownerPath, lockPath);
        syncDirectory(parent);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST" || attempt === 2) reject("publish_locked");
        reclaimStalePublishLock(parent, lockPath, targetSha256, owner, ownerState);
      }
    }
    const acquired = readPublishLock(lockPath, owner);
    if (
      acquired.record.nonce !== nonce ||
      acquired.record.pid !== process.pid ||
      acquired.record.starttime !== starttime ||
      !sameIdentity(acquired.stat, lstatSync(ownerPath, { bigint: true }))
    ) {
      reject("publish_locked");
    }
  } catch (error) {
    try {
      const lockStat = lstatSync(lockPath, { bigint: true });
      const ownerStat = lstatSync(ownerPath, { bigint: true });
      if (sameIdentity(lockStat, ownerStat)) unlinkSync(lockPath);
    } catch {}
    try {
      unlinkSync(ownerPath);
      syncDirectory(parent);
    } catch {}
    if (error instanceof SnapshotError) throw error;
    reject("publish_locked");
  }
  try {
    return operation();
  } finally {
    try {
      unlinkSync(lockPath);
      syncDirectory(parent);
      const ownerStat = lstatSync(ownerPath, { bigint: true });
      if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.nlink !== 1n) {
        reject("publish_locked");
      }
      unlinkSync(ownerPath);
      syncDirectory(parent);
    } catch {
      // A completed operation is still safe if lock cleanup needs operator repair.
    }
  }
}

function incompletePath(parent) {
  return join(parent, `.incomplete-${randomUUID()}`);
}

function makeIncompleteRemovable(path) {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    const opened = openDirectory(path);
    try {
      fchmodSync(opened.fd, STATE_DIRECTORY_MODE);
    } finally {
      closeSync(opened.fd);
    }
    for (const name of readdirSync(path)) {
      if (!safeComponent(name)) reject("unsafe_cleanup_target");
      makeIncompleteRemovable(join(path, name));
    }
    return;
  }
  if (stat.isFile()) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fchmodSync(fd, STATE_FILE_MODE);
    } finally {
      closeSync(fd);
    }
  }
}

function cleanupIncomplete(path) {
  if (
    dirname(path) !== resolve(dirname(path)) ||
    !/^\.incomplete-[a-f0-9-]{36}$/u.test(basename(path))
  ) {
    reject("unsafe_cleanup_target");
  }
  try {
    makeIncompleteRemovable(path);
    rmSync(path, { force: true, recursive: true });
    syncDirectory(dirname(path));
  } catch {
    // The original operation remains failed; never widen cleanup scope.
  }
}

function publish(staging, target) {
  assertMissing(target, "target_exists");
  renameSync(staging, target);
  syncDirectory(dirname(target));
}

function summary(operation, digest, manifest) {
  return {
    operation,
    version: FORMAT_VERSION,
    files: manifest.totals.files,
    directories: manifest.totals.directories,
    bytes: manifest.totals.bytes,
    treeSha256: manifest.sourceTreeSha256,
    activeTaskCount: manifest.activeTaskCount,
    manifestSha256: digest,
  };
}

function createSnapshot(sourcePath, targetPath, expectedSourceOwner) {
  const source = exactExistingDirectory(sourcePath, "invalid_state_root");
  const target = newTarget(targetPath, "target_exists");
  if (source.path === target.parent || target.path.startsWith(`${source.path}/`)) {
    reject("unsafe_target_location");
  }
  return withPublishLock(target.path, () => {
    assertMissing(target.path, "target_exists");
    const staging = incompletePath(target.parent);
    try {
      const before = measureTree(source.path, expectedSourceOwner);
      createDirectory(staging, STATE_DIRECTORY_MODE);
      const dataRoot = join(staging, "data");
      createDirectory(dataRoot, STATE_DIRECTORY_MODE);
      const tree = copyTree(source.path, dataRoot, expectedSourceOwner);
      const provisional = {
        directories: tree.directories,
        files: tree.files.map((entry) => ({
          relativePath: entry.path,
          size: entry.size,
          hash: entry.sha256,
        })),
      };
      const verification = verifyDataTree(dataRoot, provisional, {
        directoryMode: SNAPSHOT_DIRECTORY_MODE,
        fileMode: SNAPSHOT_FILE_MODE,
      });
      const details = verification.details;
      const after = measureTree(source.path, expectedSourceOwner);
      if (before.treeSha256 !== after.treeSha256) reject("source_changed");
      const manifest = {
        version: FORMAT_VERSION,
        activeTaskCount: verification.activeTaskCount,
        createdAt: new Date().toISOString(),
        directories: tree.directories,
        files: tree.files.map((entry) => {
          const inspected = details.get(entry.path);
          if (!inspected) reject("copy_verification_failed");
          return {
            relativePath: entry.path,
            type: inspected.type,
            mode: SNAPSHOT_FILE_MODE,
            size: entry.size,
            hash: entry.sha256,
            count: inspected.count,
            lastSeq: inspected.lastSeq,
            projectionHash: inspected.projectionHash,
          };
        }),
        sourceTreeSha256: before.treeSha256,
        totals: tree.totals,
      };
      const manifestBody = canonicalJson(manifest);
      const digest = sha256(manifestBody);
      writeExclusive(join(staging, "manifest.json"), manifestBody);
      writeExclusive(join(staging, "manifest.sha256"), `${digest}\n`);
      verifyDataTree(dataRoot, manifest, {
        directoryMode: SNAPSHOT_DIRECTORY_MODE,
        fileMode: SNAPSHOT_FILE_MODE,
      });
      syncDirectory(staging);
      writeExclusive(join(staging, "COMPLETE"), `v1 ${digest}\n`);
      setDirectoryMetadata(staging, SNAPSHOT_DIRECTORY_MODE);
      publish(staging, target.path);
      const verified = verifySnapshot(target.path);
      return summary("create", verified.digest, verified.manifest);
    } catch (error) {
      cleanupIncomplete(staging);
      throw error;
    }
  });
}

function parseOwner(uidValue, gidValue) {
  if (!/^\d+$/u.test(uidValue) || !/^\d+$/u.test(gidValue)) {
    reject("ownership_invalid");
  }
  const uid = Number(uidValue);
  const gid = Number(gidValue);
  if (
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(gid) ||
    uid < 0 ||
    gid < 0 ||
    uid > 0xffff_ffff ||
    gid > 0xffff_ffff
  ) {
    reject("ownership_invalid");
  }
  return { gid, uid };
}

function parseOptions(values, expectedNames) {
  if (values.length !== expectedNames.length * 2) reject("invalid_arguments");
  const allowed = new Set(expectedNames);
  const found = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!allowed.has(name) || found.has(name) || value === undefined) {
      reject("invalid_arguments");
    }
    found.set(name, value);
  }
  if (expectedNames.some((name) => !found.has(name))) reject("invalid_arguments");
  return found;
}

function parseDigest(value) {
  if (!SHA256.test(value)) reject("manifest_digest_invalid");
  return value;
}

function parseVerifyArguments(argv) {
  if (argv.length === 2) {
    return { expectedDigest: null, snapshotPath: argv[1] };
  }
  const options = parseOptions(argv.slice(2), ["--manifest-sha256"]);
  return {
    expectedDigest: parseDigest(options.get("--manifest-sha256")),
    snapshotPath: argv[1],
  };
}

function materializeSnapshot(snapshotPath, targetPath, owner, expectedDigest) {
  const verified = verifySnapshot(snapshotPath);
  if (verified.digest !== expectedDigest) reject("manifest_digest_mismatch");
  const target = newTarget(targetPath, "destination_exists");
  if (target.path.startsWith(`${snapshotPath}/`)) reject("unsafe_target_location");
  return withPublishLock(target.path, () => {
    assertMissing(target.path, "destination_exists");
    const staging = incompletePath(target.parent);
    try {
      createDirectory(staging, STATE_DIRECTORY_MODE);
      for (const directory of verified.manifest.directories) {
        createDirectory(join(staging, ...directory.split("/")), STATE_DIRECTORY_MODE);
      }
      for (const entry of verified.manifest.files) {
        const source = join(snapshotPath, "data", ...entry.relativePath.split("/"));
        const destination = join(staging, ...entry.relativePath.split("/"));
        const stat = lstatSync(source, { bigint: true });
        const copied = copyFile(source, destination, stat, {
          destinationMode: STATE_FILE_MODE,
          destinationOwner: owner,
          expectedSourceMode: SNAPSHOT_FILE_MODE,
        });
        if (copied.size !== entry.size || copied.sha256 !== entry.hash) {
          reject("snapshot_data_mismatch");
        }
      }
      for (const directory of [...verified.manifest.directories]
        .sort((left, right) => right.split("/").length - left.split("/").length)
        .map((path) => join(staging, ...path.split("/")))) {
        setDirectoryMetadata(directory, STATE_DIRECTORY_MODE, owner);
      }
      setDirectoryMetadata(staging, STATE_DIRECTORY_MODE, owner);
      verifyDataTree(staging, verified.manifest, {
        directoryMode: STATE_DIRECTORY_MODE,
        fileMode: STATE_FILE_MODE,
        owner,
      });
      if (measureTree(staging, owner).treeSha256 !== verified.manifest.sourceTreeSha256) {
        reject("materialized_tree_mismatch");
      }
      publish(staging, target.path);
      verifyDataTree(target.path, verified.manifest, {
        directoryMode: STATE_DIRECTORY_MODE,
        fileMode: STATE_FILE_MODE,
        owner,
      });
      if (
        measureTree(target.path, owner).treeSha256 !== verified.manifest.sourceTreeSha256
      ) {
        reject("materialized_tree_mismatch");
      }
      return summary("materialize", verified.digest, verified.manifest);
    } catch (error) {
      cleanupIncomplete(staging);
      throw error;
    }
  });
}

function main(argv) {
  let result;
  if (argv[0] === "measure" && argv.length === 2) {
    existingDirectoryPathSyntax(argv[1]);
    result = measureTree(argv[1]);
  } else if (argv[0] === "create" && argv.length === 7) {
    const options = parseOptions(argv.slice(3), ["--owner-uid", "--owner-gid"]);
    const owner = parseOwner(options.get("--owner-uid"), options.get("--owner-gid"));
    existingDirectoryPathSyntax(argv[1]);
    newTargetPathSyntax(argv[2]);
    if (argv[1] === dirname(argv[2]) || argv[2].startsWith(`${argv[1]}/`)) {
      reject("unsafe_target_location");
    }
    result = createSnapshot(argv[1], argv[2], owner);
  } else if (argv[0] === "verify") {
    const { expectedDigest, snapshotPath } = parseVerifyArguments(argv);
    existingDirectoryPathSyntax(snapshotPath);
    const verified = verifySnapshot(snapshotPath);
    if (expectedDigest !== null && verified.digest !== expectedDigest) {
      reject("manifest_digest_mismatch");
    }
    result = summary("verify", verified.digest, verified.manifest);
  } else if (argv[0] === "materialize" && argv.length === 9) {
    const options = parseOptions(argv.slice(3), [
      "--manifest-sha256",
      "--owner-uid",
      "--owner-gid",
    ]);
    const owner = parseOwner(options.get("--owner-uid"), options.get("--owner-gid"));
    const digest = parseDigest(options.get("--manifest-sha256"));
    existingDirectoryPathSyntax(argv[1]);
    newTargetPathSyntax(argv[2]);
    if (argv[2].startsWith(`${argv[1]}/`)) reject("unsafe_target_location");
    result = materializeSnapshot(argv[1], argv[2], owner, digest);
  } else {
    reject("invalid_arguments");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof SnapshotError ? error.code : "operation_failed";
    process.stderr.write(`Hub state snapshot failed: ${code}\n`);
    process.exitCode = 1;
  }
}
