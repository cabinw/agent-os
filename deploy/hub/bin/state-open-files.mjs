#!/usr/bin/env node

import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ACCESS_MODE_MASK = 0o3n;
const READ_ONLY = 0o0n;
const WRITE_ONLY = 0o1n;
const READ_WRITE = 0o2n;
const MAX_OPEN_FLAGS = 0xffff_ffffn;
const MAX_FDINFO_BYTES = 64 * 1024;
const MAX_DESCRIPTOR_TARGET_BYTES = 64 * 1024;
const MAX_CGROUP_BYTES = 64 * 1024;
const MAX_PROC_STAT_BYTES = 64 * 1024;
const MAX_PROC_STATUS_BYTES = 256 * 1024;
const MAX_MOUNTINFO_BYTES = 16 * 1024 * 1024;
const MAX_MAPS_BYTES = 64 * 1024 * 1024;
const MAX_SMAPS_BYTES = 128 * 1024 * 1024;
const MAX_STATE_ENTRIES = 100_000;
const MAX_STATE_DEPTH = 128;
const TEST_MARKER_NAME = ".agent-os-deploy-test-root";
const TEST_MARKER_MAX_BYTES = 256;
const PID_NAME = /^[1-9][0-9]*$/u;
const FD_NAME = /^(0|[1-9][0-9]*)$/u;
const OCTAL_FLAGS = /^flags:\t(0[0-7]+)$/u;
const FDINFO_MOUNT_ID = /^mnt_id:\t(0|[1-9][0-9]*)$/u;
const FDINFO_INODE = /^ino:\t(0|[1-9][0-9]*)$/u;
const CGROUP_LINE = /^(0|[1-9][0-9]*):([^:]*):(\/.*)$/u;
const CGROUP_CONTROLLERS = /^(?:[A-Za-z0-9_.=-]+(?:,[A-Za-z0-9_.=-]+)*)?$/u;
const POSITIVE_DECIMAL = /^(0|[1-9][0-9]*)$/u;
const POSITIVE_HEXADECIMAL = /^[0-9a-f]+$/u;
const PROC_STATE = /^[RSDZTtXxKWPI]$/u;
const MAP_LINE =
  /^([0-9a-f]+)-([0-9a-f]+) ([r-][w-][x-][ps]) ([0-9a-f]+) ([0-9a-f]+):([0-9a-f]+) (0|[1-9][0-9]*)(?:\s+(.*))?$/u;
const FILESYSTEM_TYPE = /^[A-Za-z0-9_.-]+$/u;
const DELETED_SUFFIX = " (deleted)";
const SCAN_COUNT = 2;
const MAX_TASK_SCAN_PASSES = 8;
const O_PATH = 0o10000000n;
const MAX_LINUX_UID = 0xffff_ffffn;
const UNIT_INACTIVE_PROOF = "inactive-mainpid0";
const OBSERVABLE_REFERENCE_GATE = "observable-reference";
const PF_KTHREAD = 0x0020_0000n;
const FILE_TYPE_MASK = 0o170000n;
const MOUNT_NAMESPACE_TARGET = /^mnt:\[(0|[1-9][0-9]*)\]$/u;

// This gate reports references observable through procfs. It does not prove
// exclusive writer ownership: queued SCM_RIGHTS, io_uring registrations,
// pidfd_getfd, and future opens through trusted ancestors are outside its view.
// Callers must also enforce a dedicated service UID, private state ACLs, and a
// trusted root boundary.

class OpenFilesError extends Error {
  constructor(code) {
    super(code);
    this.name = "OpenFilesError";
    this.code = code;
  }
}

function reject(code) {
  throw new OpenFilesError(code);
}

function safeStat(path, code) {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    reject(code);
  }
}

function entryIsAbsent(path, code) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return true;
    reject(code);
  }
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

export function procDirectoryIdentityProjection(stat) {
  if (
    stat === null ||
    typeof stat !== "object" ||
    typeof stat.dev !== "bigint" ||
    typeof stat.ino !== "bigint" ||
    typeof stat.mode !== "bigint"
  ) {
    reject("proc_unavailable");
  }
  return Object.freeze({
    dev: stat.dev,
    fileType: stat.mode & FILE_TYPE_MASK,
    ino: stat.ino,
  });
}

function sameProcDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev && left.ino === right.ino && left.fileType === right.fileType
  );
}

function procDirectoryIdentityMatches(identity, stat) {
  return sameProcDirectoryIdentity(identity, procDirectoryIdentityProjection(stat));
}

function sameFileIdentity(left, right) {
  return (
    sameIdentity(left, right) &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function requireCanonicalAbsolute(path, code, { allowRoot = false } = {}) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    (!allowRoot && path === "/") ||
    path.includes("\0") ||
    path.includes("\n") ||
    resolve(path) !== path
  ) {
    reject(code);
  }
  return path;
}

function pathComponents(path) {
  if (path === "/") return ["/"];
  const components = path.slice(1).split("/");
  const paths = ["/"];
  let current = "";
  for (const component of components) {
    current = `${current}/${component}`;
    paths.push(current);
  }
  return paths;
}

function inspectDirectoryChain(path, code, options = {}) {
  requireCanonicalAbsolute(path, code, options);
  const chain = [];
  for (const component of pathComponents(path)) {
    const stat = safeStat(component, code);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o444n) === 0n ||
      (stat.mode & 0o111n) === 0n
    ) {
      reject(code);
    }
    chain.push(Object.freeze({ path: component, stat }));
  }

  let canonical;
  let fd;
  try {
    canonical = realpathSync.native(path);
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(fd, { bigint: true });
    if (!sameIdentity(chain.at(-1).stat, opened) || !opened.isDirectory()) {
      reject(code);
    }
  } catch (error) {
    if (error instanceof OpenFilesError) throw error;
    reject(code);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (canonical !== path) reject(code);

  const directory = Object.freeze({ path, chain: Object.freeze(chain) });
  assertDirectoryUnchanged(directory, code);
  return directory;
}

function inspectChildDirectory(
  parent,
  name,
  code,
  { procfs = parent.procfs === true } = {},
) {
  const path = join(parent.path, name);
  assertDirectoryUnchanged(parent, code);
  const stat = safeStat(path, code);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o444n) === 0n ||
    (stat.mode & 0o111n) === 0n
  ) {
    reject(code);
  }

  let canonical;
  let fd;
  try {
    canonical = realpathSync.native(path);
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(fd, { bigint: true });
    const unchanged = procfs
      ? sameProcDirectoryIdentity(
          procDirectoryIdentityProjection(stat),
          procDirectoryIdentityProjection(opened),
        )
      : sameIdentity(stat, opened);
    if (!unchanged || !opened.isDirectory()) reject(code);
  } catch (error) {
    if (error instanceof OpenFilesError) throw error;
    reject(code);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (canonical !== path) reject(code);
  assertDirectoryUnchanged(parent, code);

  return Object.freeze({ path, parent, procfs, stat });
}

function inspectOptionalChildDirectory(parent, name, code, options) {
  const path = join(parent.path, name);
  try {
    return inspectChildDirectory(parent, name, code, options);
  } catch (error) {
    if (error instanceof OpenFilesError && entryIsAbsent(path, code)) {
      assertDirectoryUnchanged(parent, code);
      return null;
    }
    throw error;
  }
}

function inspectOptionalDescendantDirectory(root, relativePath, code) {
  let current = root;
  for (const component of relativePath.split("/")) {
    if (component.length === 0) continue;
    current = inspectOptionalChildDirectory(current, component, code);
    if (current === null) return null;
  }
  return current;
}

function assertDirectoryUnchanged(directory, code) {
  if (directory.chain) {
    for (const component of directory.chain) {
      const current = safeStat(component.path, code);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !sameIdentity(component.stat, current)
      ) {
        reject(code);
      }
    }
    let canonical;
    try {
      canonical = realpathSync.native(directory.path);
    } catch {
      reject(code);
    }
    if (canonical !== directory.path) reject(code);
    return;
  }

  assertDirectoryUnchanged(directory.parent, code);
  const current = safeStat(directory.path, code);
  const unchanged = directory.procfs
    ? procDirectoryIdentityMatches(
        procDirectoryIdentityProjection(directory.stat),
        current,
      )
    : sameIdentity(directory.stat, current);
  if (!current.isDirectory() || current.isSymbolicLink() || !unchanged) {
    reject(code);
  }
}

function readDirectory(directory, code) {
  assertDirectoryUnchanged(directory, code);
  let entries;
  try {
    entries = readdirSync(directory.path);
  } catch {
    reject(code);
  }
  assertDirectoryUnchanged(directory, code);
  return entries;
}

function numericEntries(directory, pattern, code, { ignoreOther = false } = {}) {
  const entries = readDirectory(directory, code);
  const names = [];
  for (const name of entries) {
    if (pattern.test(name)) {
      names.push(name);
      continue;
    }
    if (/^[0-9]+$/u.test(name)) reject(code);
    if (!ignoreOther) reject(code);
  }
  names.sort((left, right) => {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
    return 0;
  });
  return names;
}

function exactSameNames(left, right) {
  return (
    left.length === right.length && left.every((name, index) => name === right[index])
  );
}

function readBoundedRegularFile(path, code, maxBytes = MAX_FDINFO_BYTES) {
  const before = safeStat(path, code);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    (before.mode & 0o444n) === 0n
  ) {
    reject(code);
  }

  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) reject(code);

    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(4096, maxBytes + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) reject(code);
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(opened, after)) reject(code);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, total),
      );
    } catch {
      reject(code);
    }
  } catch (error) {
    if (error instanceof OpenFilesError) throw error;
    reject(code);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readDescriptorTarget(path, code) {
  const before = safeStat(path, code);
  if (!before.isSymbolicLink()) reject(code);
  let followed;
  let target;
  try {
    const rawTarget = readlinkSync(path, { encoding: "buffer" });
    if (rawTarget.length > MAX_DESCRIPTOR_TARGET_BYTES) reject(code);
    target = new TextDecoder("utf-8", { fatal: true }).decode(rawTarget);
    followed = statSync(path, { bigint: true });
  } catch (error) {
    if (error instanceof OpenFilesError) throw error;
    reject(code);
  }
  const after = safeStat(path, code);
  if (!after.isSymbolicLink() || !sameFileIdentity(before, after)) reject(code);
  return Object.freeze({
    device: linuxDeviceIdentity(followed.dev),
    fileType: followed.mode & FILE_TYPE_MASK,
    inode: followed.ino,
    nlink: followed.nlink,
    target,
  });
}

function sameMountNamespaceIdentity(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.target === right.target &&
    sameProcDirectoryIdentity(left.namespaceIdentity, right.namespaceIdentity)
  );
}

function readMountNamespaceIdentity(taskDirectory) {
  const namespaceDirectory = inspectChildDirectory(
    taskDirectory,
    "ns",
    "alias_inspection_unavailable",
  );
  const namespacePath = join(namespaceDirectory.path, "mnt");
  try {
    const before = safeStat(namespacePath, "alias_inspection_unavailable");
    if (!before.isSymbolicLink()) reject("alias_inspection_unavailable");
    const firstTargetBuffer = readlinkSync(namespacePath, { encoding: "buffer" });
    if (firstTargetBuffer.length > MAX_DESCRIPTOR_TARGET_BYTES) {
      reject("alias_inspection_unavailable");
    }
    const target = new TextDecoder("utf-8", { fatal: true }).decode(firstTargetBuffer);
    if (!MOUNT_NAMESPACE_TARGET.test(target)) reject("alias_inspection_unavailable");
    const firstNamespace = statSync(namespacePath, { bigint: true });
    const secondTargetBuffer = readlinkSync(namespacePath, { encoding: "buffer" });
    const secondTarget = new TextDecoder("utf-8", { fatal: true }).decode(
      secondTargetBuffer,
    );
    const secondNamespace = statSync(namespacePath, { bigint: true });
    const after = safeStat(namespacePath, "alias_inspection_unavailable");
    const linkIdentity = procDirectoryIdentityProjection(before);
    if (
      target !== secondTarget ||
      !procDirectoryIdentityMatches(linkIdentity, after) ||
      !sameProcDirectoryIdentity(
        procDirectoryIdentityProjection(firstNamespace),
        procDirectoryIdentityProjection(secondNamespace),
      )
    ) {
      reject("alias_inspection_unavailable");
    }
    assertDirectoryUnchanged(namespaceDirectory, "alias_inspection_unavailable");
    return Object.freeze({
      namespaceIdentity: procDirectoryIdentityProjection(firstNamespace),
      target,
    });
  } catch (error) {
    if (error instanceof OpenFilesError) throw error;
    reject("alias_inspection_unavailable");
  }
}

export function parseFdinfoFlags(fdinfo) {
  if (typeof fdinfo !== "string" || Buffer.byteLength(fdinfo) > MAX_FDINFO_BYTES) {
    reject("fdinfo_invalid");
  }
  const flagLines = fdinfo.split("\n").filter((line) => line.startsWith("flags:"));
  if (flagLines.length !== 1) reject("fdinfo_invalid");
  const match = OCTAL_FLAGS.exec(flagLines[0]);
  if (!match) reject("fdinfo_invalid");

  let flags;
  try {
    flags = BigInt(`0o${match[1].slice(1) || "0"}`);
  } catch {
    reject("fdinfo_invalid");
  }
  if (flags > MAX_OPEN_FLAGS) reject("fdinfo_invalid");
  return flags;
}

export function hasWritableAccess(flags) {
  if (typeof flags !== "bigint" || flags < 0n || flags > MAX_OPEN_FLAGS) {
    reject("fdinfo_invalid");
  }
  const access = flags & ACCESS_MODE_MASK;
  if (access === WRITE_ONLY || access === READ_WRITE) return true;
  if (access === READ_ONLY) return false;
  reject("fdinfo_invalid");
}

export function normalizeDescriptorTarget(target) {
  if (typeof target !== "string") reject("descriptor_target_invalid");
  return target.endsWith(DELETED_SUFFIX)
    ? target.slice(0, -DELETED_SUFFIX.length)
    : target;
}

export function targetIsWithinState(target, stateRoot) {
  if (typeof target !== "string" || typeof stateRoot !== "string") return false;
  const normalized = normalizeDescriptorTarget(target);
  if (!isAbsolute(normalized)) return false;
  if (
    normalized.includes("\0") ||
    normalized.includes("\n") ||
    resolve(normalized) !== normalized
  ) {
    reject("descriptor_target_invalid");
  }
  return normalized === stateRoot || normalized.startsWith(`${stateRoot}${sep}`);
}

export function descriptorWritesState({ fdinfo, stateRoot, target }) {
  const flags = parseFdinfoFlags(fdinfo);
  return hasWritableAccess(flags) && targetIsWithinState(target, stateRoot);
}

function uniqueLine(contents, prefix, pattern, code) {
  const matches = contents.split("\n").filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) reject(code);
  const match = pattern.exec(matches[0]);
  if (!match) reject(code);
  return match;
}

export function parseFdinfoIdentity(fdinfo) {
  if (typeof fdinfo !== "string" || Buffer.byteLength(fdinfo) > MAX_FDINFO_BYTES) {
    reject("fdinfo_invalid");
  }
  const flags = parseFdinfoFlags(fdinfo);
  const mount = uniqueLine(fdinfo, "mnt_id:", FDINFO_MOUNT_ID, "fdinfo_invalid");
  const inode = uniqueLine(fdinfo, "ino:", FDINFO_INODE, "fdinfo_invalid");
  return Object.freeze({
    flags,
    inode: BigInt(inode[1]),
    mountId: mount[1],
  });
}

function parseProcStatIdentity(contents, expectedPid) {
  if (
    typeof contents !== "string" ||
    typeof expectedPid !== "string" ||
    !PID_NAME.test(expectedPid) ||
    contents.length === 0 ||
    Buffer.byteLength(contents) > MAX_PROC_STAT_BYTES ||
    !contents.endsWith("\n")
  ) {
    reject("proc_stat_invalid");
  }
  const body = contents.slice(0, -1);
  if (!body.startsWith(`${expectedPid} (`)) reject("proc_stat_invalid");
  const commandEnd = body.lastIndexOf(") ");
  if (commandEnd < expectedPid.length + 2) reject("proc_stat_invalid");
  const fields = body.slice(commandEnd + 2).split(" ");
  if (fields.length < 20 || fields.some((field) => field.length === 0)) {
    reject("proc_stat_invalid");
  }
  const starttime = fields[19];
  const state = fields[0];
  const flags = fields[6];
  if (
    !PROC_STATE.test(state) ||
    !POSITIVE_DECIMAL.test(starttime) ||
    !POSITIVE_DECIMAL.test(flags)
  ) {
    reject("proc_stat_invalid");
  }
  let parsedFlags;
  try {
    parsedFlags = BigInt(flags);
  } catch {
    reject("proc_stat_invalid");
  }
  return Object.freeze({
    kernelThread: (parsedFlags & PF_KTHREAD) !== 0n,
    state,
    starttime,
  });
}

export function parseProcStatStarttime(contents, expectedPid) {
  return parseProcStatIdentity(contents, expectedPid).starttime;
}

export function parseProcStatusUids(contents) {
  if (
    typeof contents !== "string" ||
    contents.length === 0 ||
    Buffer.byteLength(contents) > MAX_PROC_STATUS_BYTES ||
    !contents.endsWith("\n")
  ) {
    reject("proc_status_invalid");
  }
  const lines = contents.split("\n").filter((line) => line.startsWith("Uid:"));
  if (lines.length !== 1) reject("proc_status_invalid");
  const match =
    /^Uid:\t(0|[1-9][0-9]*)\t(0|[1-9][0-9]*)\t(0|[1-9][0-9]*)\t(0|[1-9][0-9]*)$/u.exec(
      lines[0],
    );
  if (!match) reject("proc_status_invalid");
  const uids = match.slice(1).map((value) => BigInt(value));
  if (uids.some((uid) => uid > MAX_LINUX_UID)) reject("proc_status_invalid");
  return Object.freeze(uids);
}

function decodeMountToken(value) {
  if (typeof value !== "string" || value.length === 0) reject("mountinfo_invalid");
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") {
      decoded += value[index];
      continue;
    }
    const escapedSequence = value.slice(index, index + 4);
    const replacements = new Map([
      ["\\040", " "],
      ["\\011", "\t"],
      ["\\012", "\n"],
      ["\\134", "\\"],
    ]);
    const replacement = replacements.get(escapedSequence);
    if (replacement === undefined) reject("mountinfo_invalid");
    decoded += replacement;
    index += 3;
  }
  if (decoded.length === 0 || decoded.includes("\0") || decoded.includes("\n")) {
    reject("mountinfo_invalid");
  }
  return decoded;
}

function canonicalAbsoluteMountPath(value) {
  return posix.isAbsolute(value) && posix.normalize(value) === value;
}

function decodeMountPoint(value) {
  const decoded = decodeMountToken(value);
  if (!canonicalAbsoluteMountPath(decoded)) reject("mountinfo_invalid");
  return decoded;
}

function normalizeDevice(major, minor, radix, code) {
  const pattern = radix === 16 ? POSITIVE_HEXADECIMAL : POSITIVE_DECIMAL;
  if (!pattern.test(major) || !pattern.test(minor)) reject(code);
  try {
    return `${BigInt(radix === 16 ? `0x${major}` : major)}:${BigInt(
      radix === 16 ? `0x${minor}` : minor,
    )}`;
  } catch {
    reject(code);
  }
}

export function parseMountinfo(contents) {
  if (
    typeof contents !== "string" ||
    contents.length === 0 ||
    Buffer.byteLength(contents) > MAX_MOUNTINFO_BYTES ||
    !contents.endsWith("\n")
  ) {
    reject("mountinfo_invalid");
  }
  const entries = [];
  const ids = new Set();
  for (const line of contents.slice(0, -1).split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0 || line.indexOf(" - ", separator + 3) !== -1) {
      reject("mountinfo_invalid");
    }
    const left = line.slice(0, separator).split(" ");
    const right = line.slice(separator + 3).split(" ");
    if (left.length < 6 || right.length < 3) reject("mountinfo_invalid");
    const [mountId, parentId, device] = left;
    const mountOptions = new Set(left[5].split(","));
    const readWrite = mountOptions.has("rw");
    if (
      !PID_NAME.test(mountId) ||
      !POSITIVE_DECIMAL.test(parentId) ||
      ids.has(mountId) ||
      !/^[0-9]+:[0-9]+$/u.test(device) ||
      mountOptions.has("") ||
      mountOptions.size !== left[5].split(",").length ||
      readWrite === mountOptions.has("ro") ||
      !FILESYSTEM_TYPE.test(right[0])
    ) {
      reject("mountinfo_invalid");
    }
    const [major, minor] = device.split(":");
    ids.add(mountId);
    const root = decodeMountToken(left[3]);
    entries.push(
      Object.freeze({
        device: normalizeDevice(major, minor, 10, "mountinfo_invalid"),
        filesystemType: right[0],
        mountId,
        mountPoint: decodeMountPoint(left[4]),
        parentId,
        readWrite,
        root,
        rootIsCanonicalAbsolute: canonicalAbsoluteMountPath(root),
      }),
    );
  }
  if (entries.length === 0) reject("mountinfo_invalid");
  return Object.freeze(entries);
}

function mountForPath(entries, path, code = "alias_inspection_unavailable") {
  const candidates = entries.filter((entry) =>
    entry.mountPoint === "/"
      ? path.startsWith("/")
      : path === entry.mountPoint || path.startsWith(`${entry.mountPoint}/`),
  );
  if (candidates.length === 0) reject(code);
  const mountPoints = new Set();
  for (const candidate of candidates) {
    if (mountPoints.has(candidate.mountPoint)) reject(code);
    mountPoints.add(candidate.mountPoint);
  }
  const longest = candidates.reduce(
    (maximum, entry) => Math.max(maximum, entry.mountPoint.length),
    0,
  );
  const selected = candidates.filter((entry) => entry.mountPoint.length === longest);
  if (selected.length !== 1) reject(code);
  const byId = new Map(entries.map((entry) => [entry.mountId, entry]));
  const visibleChain = [...candidates].sort(
    (left, right) => left.mountPoint.length - right.mountPoint.length,
  );
  for (let index = 0; index < visibleChain.length; index += 1) {
    const mount = visibleChain[index];
    const expectedParent = visibleChain[index - 1];
    if (
      (expectedParent === undefined &&
        byId.has(mount.parentId) &&
        mount.parentId !== mount.mountId) ||
      (expectedParent !== undefined && mount.parentId !== expectedParent.mountId)
    ) {
      reject(code);
    }
  }
  return selected[0];
}

function sameMountIdentity(left, right) {
  return (
    left.mountId === right.mountId &&
    left.device === right.device &&
    left.filesystemType === right.filesystemType &&
    left.readWrite === right.readWrite &&
    left.root === right.root &&
    left.rootIsCanonicalAbsolute === right.rootIsCanonicalAbsolute
  );
}

function mountProjectionSignature(entries) {
  return JSON.stringify(
    entries
      .map(
        ({
          device,
          filesystemType,
          mountId,
          mountPoint,
          parentId,
          readWrite,
          root,
          rootIsCanonicalAbsolute,
        }) => [
          mountId,
          parentId,
          device,
          mountPoint,
          root,
          filesystemType,
          readWrite,
          rootIsCanonicalAbsolute,
        ],
      )
      .sort(([leftId], [rightId]) => {
        const left = BigInt(leftId);
        const right = BigInt(rightId);
        return left < right ? -1 : left > right ? 1 : 0;
      }),
  );
}

function filesystemInternalPath(mount, path) {
  if (mount.rootIsCanonicalAbsolute !== true) {
    reject("alias_inspection_unavailable");
  }
  requireCanonicalAbsolute(path, "alias_inspection_unavailable", {
    allowRoot: true,
  });
  const offset = posix.relative(mount.mountPoint, path);
  if (offset === ".." || offset.startsWith("../") || posix.isAbsolute(offset)) {
    reject("alias_inspection_unavailable");
  }
  const internal = offset === "" ? mount.root : posix.join(mount.root, offset);
  if (!posix.isAbsolute(internal) || posix.normalize(internal) !== internal) {
    reject("alias_inspection_unavailable");
  }
  return internal;
}

function internalPathIsWithin(path, root) {
  return root === "/" || path === root || path.startsWith(`${root}${posix.sep}`);
}

export function deletedDescriptorTargetWritesState({
  descriptorMount,
  inspectorMountNamespaceIdentity,
  nlink,
  readerMountEntries,
  stateFilesystemDevice,
  stateFilesystemRoot,
  taskMountNamespaceIdentity,
  target,
}) {
  if (
    descriptorMount === null ||
    typeof descriptorMount !== "object" ||
    typeof descriptorMount.device !== "string" ||
    typeof descriptorMount.mountPoint !== "string" ||
    typeof descriptorMount.root !== "string" ||
    inspectorMountNamespaceIdentity === null ||
    typeof inspectorMountNamespaceIdentity !== "object" ||
    !Array.isArray(readerMountEntries) ||
    typeof stateFilesystemDevice !== "string" ||
    typeof stateFilesystemRoot !== "string" ||
    !posix.isAbsolute(stateFilesystemRoot) ||
    posix.normalize(stateFilesystemRoot) !== stateFilesystemRoot ||
    typeof nlink !== "bigint" ||
    nlink < 0n ||
    taskMountNamespaceIdentity === null ||
    typeof taskMountNamespaceIdentity !== "object"
  ) {
    reject("alias_inspection_unavailable");
  }
  if (nlink !== 0n) return false;
  if (descriptorMount.device !== stateFilesystemDevice) return false;
  if (
    !sameMountNamespaceIdentity(
      inspectorMountNamespaceIdentity,
      taskMountNamespaceIdentity,
    )
  ) {
    reject("alias_inspection_unavailable");
  }
  const readerDescriptorMount = readerMountEntries.find(
    ({ mountId }) => mountId === descriptorMount.mountId,
  );
  if (
    readerDescriptorMount === undefined ||
    !sameMountIdentity(readerDescriptorMount, descriptorMount)
  ) {
    reject("alias_inspection_unavailable");
  }
  const normalizedTarget = normalizeDescriptorTarget(target);
  if (!isAbsolute(normalizedTarget)) reject("alias_inspection_unavailable");
  const readerMount = mountForPath(readerMountEntries, normalizedTarget);
  if (!sameMountIdentity(readerMount, descriptorMount)) {
    reject("alias_inspection_unavailable");
  }
  const internalPath = filesystemInternalPath(readerMount, normalizedTarget);
  return internalPathIsWithin(internalPath, stateFilesystemRoot);
}

function identityKey(device, inode) {
  if (typeof device !== "string" || typeof inode !== "bigint" || inode < 0n) {
    reject("alias_inspection_unavailable");
  }
  return `${device}:${inode}`;
}

function rawIdentityKey(device, inode) {
  if (typeof device !== "bigint" || typeof inode !== "bigint" || inode < 0n) {
    reject("alias_inspection_unavailable");
  }
  return `${device}:${inode}`;
}

export function linuxDeviceIdentity(device) {
  if (typeof device !== "bigint" || device < 0n) {
    reject("state_root_cross_mount");
  }
  const major = ((device & 0xfff00n) >> 8n) | ((device & 0xffff_f000_0000_0000n) >> 32n);
  const minor = (device & 0xffn) | ((device & 0xfff_fff0_0000n) >> 12n);
  return `${major}:${minor}`;
}

function parseMappings(contents) {
  if (
    typeof contents !== "string" ||
    Buffer.byteLength(contents) > MAX_MAPS_BYTES ||
    (contents.length > 0 && !contents.endsWith("\n"))
  ) {
    reject("proc_maps_invalid");
  }
  const mappings = [];
  for (const line of contents.length === 0 ? [] : contents.slice(0, -1).split("\n")) {
    const match = MAP_LINE.exec(line);
    if (!match) reject("proc_maps_invalid");
    const device = normalizeDevice(match[5], match[6], 16, "proc_maps_invalid");
    mappings.push(
      Object.freeze({
        device,
        inode: BigInt(match[7]),
        permissions: match[3],
      }),
    );
  }
  return Object.freeze(mappings);
}

export function parseSharedWritableMappings(contents) {
  return Object.freeze(
    parseMappings(contents)
      .filter(
        ({ inode, permissions }) =>
          inode !== 0n && permissions[1] === "w" && permissions[3] === "s",
      )
      .map(({ device, inode }) => Object.freeze({ device, inode })),
  );
}

function parseSmaps(contents) {
  if (
    typeof contents !== "string" ||
    Buffer.byteLength(contents) > MAX_SMAPS_BYTES ||
    (contents.length > 0 && !contents.endsWith("\n"))
  ) {
    reject("proc_smaps_invalid");
  }
  const mappings = [];
  const sharedMayWrite = [];
  let current = null;
  let vmFlagsSeen = false;
  for (const line of contents.length === 0 ? [] : contents.slice(0, -1).split("\n")) {
    const header = MAP_LINE.exec(line);
    if (header) {
      if (current !== null && !vmFlagsSeen) reject("proc_smaps_invalid");
      current = Object.freeze({
        device: normalizeDevice(header[5], header[6], 16, "proc_smaps_invalid"),
        inode: BigInt(header[7]),
        permissions: header[3],
      });
      vmFlagsSeen = false;
      continue;
    }
    if (/^[0-9a-f]+-[0-9a-f]+ /u.test(line) || current === null) {
      reject("proc_smaps_invalid");
    }
    if (!line.startsWith("VmFlags:")) continue;
    if (vmFlagsSeen) reject("proc_smaps_invalid");
    const match = /^VmFlags: ([a-z]{2}(?: [a-z]{2})*)$/u.exec(line);
    if (!match) reject("proc_smaps_invalid");
    const flags = new Set(match[1].split(" "));
    if (flags.has("sh") !== (current.permissions[3] === "s")) {
      reject("proc_smaps_invalid");
    }
    const evidence = Object.freeze({
      ...current,
      sharedMayWrite: flags.has("sh") && flags.has("mw"),
    });
    mappings.push(evidence);
    if (evidence.sharedMayWrite && current.inode !== 0n) {
      sharedMayWrite.push(evidence);
    }
    vmFlagsSeen = true;
  }
  if (current !== null && !vmFlagsSeen) reject("proc_smaps_invalid");
  return Object.freeze({
    mappings: Object.freeze(mappings),
    sharedMayWrite: Object.freeze(sharedMayWrite),
  });
}

export function parseSharedMayWriteMappings(contents) {
  return Object.freeze(
    parseSmaps(contents).sharedMayWrite.map(({ device, inode }) =>
      Object.freeze({ device, inode }),
    ),
  );
}

export function parseCgroupEvents(contents) {
  if (
    typeof contents !== "string" ||
    contents.length === 0 ||
    Buffer.byteLength(contents) > MAX_CGROUP_BYTES ||
    !contents.endsWith("\n")
  ) {
    reject("cgroup_events_invalid");
  }
  const values = new Map();
  for (const line of contents.slice(0, -1).split("\n")) {
    const match = /^([a-z][a-z0-9_]*) (0|[1-9][0-9]*)$/u.exec(line);
    if (!match || values.has(match[1])) reject("cgroup_events_invalid");
    values.set(match[1], BigInt(match[2]));
  }
  if (!values.has("populated")) reject("cgroup_events_invalid");
  if (values.get("populated") > 1n) reject("cgroup_events_invalid");
  return Object.freeze({ populated: values.get("populated") });
}

function parseMountinfoForInspection(contents) {
  try {
    return parseMountinfo(contents);
  } catch {
    reject("alias_inspection_unavailable");
  }
}

function parseTaskMountinfoForInspection(contents) {
  // Linux may expose a stable zero-byte task mountinfo for a non-dumpable
  // process (notably OpenSSH privilege separation) even to the privileged
  // deployment helper.  An empty projection is sufficient to inspect live
  // descriptors by their followed dev+inode identity.  Deleted/O_TMPFILE
  // descriptors on the state device still require a concrete mount object and
  // fail closed in deletedDescriptorTargetWritesState when none is available.
  if (contents === "") return Object.freeze([]);
  return parseMountinfoForInspection(contents);
}

function parseMappingsForInspection(contents) {
  try {
    return parseMappings(contents);
  } catch {
    reject("alias_inspection_unavailable");
  }
}

function parseSmapsForInspection(contents) {
  try {
    return parseSmaps(contents);
  } catch {
    reject("alias_inspection_unavailable");
  }
}

export function normalizeForbiddenCgroup(cgroup) {
  if (
    typeof cgroup !== "string" ||
    cgroup === "/" ||
    cgroup.includes("\0") ||
    cgroup.includes("\n") ||
    !posix.isAbsolute(cgroup) ||
    posix.normalize(cgroup) !== cgroup
  ) {
    reject("forbidden_cgroup_invalid");
  }
  return cgroup;
}

export function parseProcCgroup(contents) {
  if (
    typeof contents !== "string" ||
    contents.length === 0 ||
    Buffer.byteLength(contents) > MAX_CGROUP_BYTES ||
    !contents.endsWith("\n")
  ) {
    reject("proc_cgroup_invalid");
  }
  const memberships = [];
  const hierarchies = new Set();
  for (const line of contents.slice(0, -1).split("\n")) {
    const match = CGROUP_LINE.exec(line);
    if (!match || !CGROUP_CONTROLLERS.test(match[2]) || hierarchies.has(match[1])) {
      reject("proc_cgroup_invalid");
    }
    if (posix.normalize(match[3]) !== match[3]) reject("proc_cgroup_invalid");
    hierarchies.add(match[1]);
    memberships.push(match[3]);
  }
  if (memberships.length === 0) reject("proc_cgroup_invalid");
  return Object.freeze(memberships);
}

export function cgroupPathIsWithin(path, forbiddenCgroup) {
  if (typeof path !== "string") reject("proc_cgroup_invalid");
  const forbidden = normalizeForbiddenCgroup(forbiddenCgroup);
  return path === forbidden || path.startsWith(`${forbidden}/`);
}

export function procCgroupContains(contents, forbiddenCgroup) {
  return parseProcCgroup(contents).some((path) =>
    cgroupPathIsWithin(path, forbiddenCgroup),
  );
}

function buildProtectedIdentityIndex(
  stateDirectory,
  mountEntries,
  { verifyStatDevices },
) {
  const all = new Set();
  const directories = new Set();
  const allRaw = new Set();
  const directoriesRaw = new Set();
  const relativeIdentities = [];
  let entryCount = 0;

  const parent = stateDirectory.chain.at(-2);
  const stateLeaf = stateDirectory.chain.at(-1);
  if (
    parent === undefined ||
    stateLeaf === undefined ||
    !parent.stat.isDirectory() ||
    !stateLeaf.stat.isDirectory()
  ) {
    reject("alias_inspection_unavailable");
  }
  const parentMount = mountForPath(mountEntries, parent.path);
  const stateMount = mountForPath(
    mountEntries,
    stateDirectory.path,
    "state_root_cross_mount",
  );
  if (stateMount.filesystemType !== "ext4" || !stateMount.readWrite) {
    reject("state_root_filesystem_unsupported");
  }
  if (
    verifyStatDevices &&
    (parentMount.device !== linuxDeviceIdentity(parent.stat.dev) ||
      stateMount.device !== linuxDeviceIdentity(stateLeaf.stat.dev))
  ) {
    reject("state_root_cross_mount");
  }
  const stateFilesystemRoot = filesystemInternalPath(stateMount, stateDirectory.path);
  const parentDirectories = new Set([identityKey(parentMount.device, parent.stat.ino)]);
  const parentDirectoriesRaw = new Set([
    rawIdentityKey(parent.stat.dev, parent.stat.ino),
  ]);

  function walk(path, relativePath, depth) {
    if (depth > MAX_STATE_DEPTH) reject("state_root_changed");
    const before = safeStat(path, "state_root_changed");
    if (before.isSymbolicLink()) reject("alias_inspection_unavailable");
    const mount = mountForPath(mountEntries, path, "state_root_cross_mount");
    if (!sameMountIdentity(mount, stateMount)) reject("state_root_cross_mount");
    if (verifyStatDevices && mount.device !== linuxDeviceIdentity(before.dev)) {
      reject("state_root_cross_mount");
    }
    const key = identityKey(mount.device, before.ino);
    const rawKey = rawIdentityKey(before.dev, before.ino);
    if (all.has(key) || allRaw.has(rawKey)) reject("alias_inspection_unavailable");
    all.add(key);
    allRaw.add(rawKey);
    relativeIdentities.push(`${relativePath}\0${key}\0${rawKey}\0${before.mode}`);
    entryCount += 1;
    if (entryCount > MAX_STATE_ENTRIES) reject("alias_inspection_unavailable");
    if (before.isFile()) {
      if (before.nlink !== 1n) reject("alias_inspection_unavailable");
      return;
    }
    if (!before.isDirectory()) reject("alias_inspection_unavailable");
    directories.add(key);
    directoriesRaw.add(rawKey);
    let names;
    try {
      names = readdirSync(path).sort();
    } catch {
      reject("state_root_changed");
    }
    for (const name of names) {
      if (name.includes("/") || name.includes("\0") || name === "." || name === "..") {
        reject("alias_inspection_unavailable");
      }
      walk(
        join(path, name),
        relativePath === "" ? name : `${relativePath}/${name}`,
        depth + 1,
      );
    }
    const after = safeStat(path, "state_root_changed");
    if (!sameFileIdentity(before, after)) reject("state_root_changed");
  }

  walk(stateDirectory.path, "", 0);
  return Object.freeze({
    all,
    allRaw,
    directories,
    directoriesRaw,
    fingerprint: relativeIdentities.sort().join("\n"),
    parentDirectories,
    parentDirectoriesRaw,
    stateFilesystemDevice: stateMount.device,
    stateFilesystemRoot,
  });
}

function emptyInspectionResult(
  inspectionComplete = true,
  aliasInspectionComplete = true,
) {
  return {
    aliasInspectionComplete,
    cgroupDirectoryAbsent: false,
    cgroupPopulatedDetected: false,
    directoryDescriptorDetected: false,
    forbiddenCgroupMemberDetected: false,
    gate: OBSERVABLE_REFERENCE_GATE,
    inspectionComplete,
    processRootDetected: false,
    serviceUidProcessDetected: false,
    sharedWritableMappingDetected: false,
    workingDirectoryDetected: false,
    writableDescriptorDetected: false,
  };
}

function resultIsOk(result) {
  return (
    result.inspectionComplete &&
    result.aliasInspectionComplete &&
    !result.cgroupPopulatedDetected &&
    !result.directoryDescriptorDetected &&
    !result.forbiddenCgroupMemberDetected &&
    !result.processRootDetected &&
    !result.serviceUidProcessDetected &&
    !result.sharedWritableMappingDetected &&
    !result.workingDirectoryDetected &&
    !result.writableDescriptorDetected
  );
}

export function serializeStateOpenFilesResult(result) {
  const keys = [
    "aliasInspectionComplete",
    "cgroupDirectoryAbsent",
    "cgroupPopulatedDetected",
    "directoryDescriptorDetected",
    "forbiddenCgroupMemberDetected",
    "inspectionComplete",
    "processRootDetected",
    "serviceUidProcessDetected",
    "sharedWritableMappingDetected",
    "workingDirectoryDetected",
    "writableDescriptorDetected",
  ];
  if (
    result === null ||
    typeof result !== "object" ||
    result.gate !== OBSERVABLE_REFERENCE_GATE ||
    keys.some((key) => typeof result[key] !== "boolean")
  ) {
    reject("result_invalid");
  }
  return JSON.stringify({
    aliasInspectionComplete: result.aliasInspectionComplete,
    cgroupDirectoryAbsent: result.cgroupDirectoryAbsent,
    cgroupPopulatedDetected: result.cgroupPopulatedDetected,
    directoryDescriptorDetected: result.directoryDescriptorDetected,
    forbiddenCgroupMemberDetected: result.forbiddenCgroupMemberDetected,
    gate: OBSERVABLE_REFERENCE_GATE,
    inspectionComplete: result.inspectionComplete,
    ok: resultIsOk(result),
    processRootDetected: result.processRootDetected,
    scanCount: SCAN_COUNT,
    serviceUidProcessDetected: result.serviceUidProcessDetected,
    sharedWritableMappingDetected: result.sharedWritableMappingDetected,
    workingDirectoryDetected: result.workingDirectoryDetected,
    writableDescriptorDetected: result.writableDescriptorDetected,
  });
}

function readProcessIdentity(processDirectory, processName) {
  return parseProcStatIdentity(
    readBoundedRegularFile(
      join(processDirectory.path, "stat"),
      "proc_unavailable",
      MAX_PROC_STAT_BYTES,
    ),
    processName,
  );
}

function processIdentityProjectionChanged(left, right) {
  return (
    left.starttime !== right.starttime || (left.state === "Z") !== (right.state === "Z")
  );
}

function taskChangedOrUnavailable(taskDirectory, taskName, expectedIdentity) {
  if (
    entryIsAbsent(taskDirectory.path, "proc_unavailable") ||
    entryIsAbsent(join(taskDirectory.path, "stat"), "proc_unavailable")
  ) {
    return true;
  }
  const currentDirectoryIdentity = safeStat(taskDirectory.path, "proc_unavailable");
  if (
    !currentDirectoryIdentity.isDirectory() ||
    currentDirectoryIdentity.isSymbolicLink() ||
    !procDirectoryIdentityMatches(
      procDirectoryIdentityProjection(taskDirectory.stat),
      currentDirectoryIdentity,
    )
  ) {
    return true;
  }
  let currentIdentity;
  try {
    currentIdentity = readProcessIdentity(taskDirectory, taskName);
  } catch (error) {
    if (
      error instanceof OpenFilesError &&
      (entryIsAbsent(taskDirectory.path, "proc_unavailable") ||
        entryIsAbsent(join(taskDirectory.path, "stat"), "proc_unavailable"))
    ) {
      return true;
    }
    throw error;
  }
  return processIdentityProjectionChanged(expectedIdentity, currentIdentity);
}

function readMagicDirectoryIdentity(path, code, { allowAbsent = false } = {}) {
  let before;
  let followed;
  try {
    before = lstatSync(path, { bigint: true });
    if (!before.isSymbolicLink()) reject(code);
    followed = statSync(path, { bigint: true });
  } catch (error) {
    if (allowAbsent && (error?.code === "ENOENT" || error?.code === "ESRCH")) {
      return null;
    }
    if (error instanceof OpenFilesError) throw error;
    reject(code);
  }
  const after = safeStat(path, code);
  if (
    !followed.isDirectory() ||
    !after.isSymbolicLink() ||
    !sameFileIdentity(before, after)
  ) {
    reject(code);
  }
  return Object.freeze({
    key: rawIdentityKey(followed.dev, followed.ino),
  });
}

function descriptorSecurityFlags(flags) {
  return flags & (ACCESS_MODE_MASK | O_PATH);
}

function numericNameUnion(left, right) {
  return [...new Set([...left, ...right])].sort((leftName, rightName) => {
    const leftValue = BigInt(leftName);
    const rightValue = BigInt(rightName);
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
    return 0;
  });
}

function sameDescriptorFdinfoIdentity(left, right) {
  return (
    left.inode === right.inode &&
    left.mountId === right.mountId &&
    descriptorSecurityFlags(left.flags) === descriptorSecurityFlags(right.flags)
  );
}

function sameDescriptorTargetEvidence(left, right) {
  return (
    left.device === right.device &&
    left.fileType === right.fileType &&
    left.inode === right.inode &&
    left.nlink === right.nlink &&
    left.target === right.target
  );
}

function readDescriptorEvidence(
  fdDirectory,
  fdinfoDirectory,
  descriptor,
  mountsById,
  verifyTargetIdentity,
  onEvidenceStage,
) {
  const linkPath = join(fdDirectory.path, descriptor);
  const infoPath = join(fdinfoDirectory.path, descriptor);
  let fdinfo0;
  let fdinfo1;
  let fdinfo2;
  let targetEvidence0;
  let targetEvidence1;
  try {
    fdinfo0 = parseFdinfoIdentity(readBoundedRegularFile(infoPath, "proc_unavailable"));
    onEvidenceStage?.("f0", descriptor);
    targetEvidence0 = readDescriptorTarget(linkPath, "proc_unavailable");
    onEvidenceStage?.("t0", descriptor);
    fdinfo1 = parseFdinfoIdentity(readBoundedRegularFile(infoPath, "proc_unavailable"));
    onEvidenceStage?.("f1", descriptor);
    targetEvidence1 = readDescriptorTarget(linkPath, "proc_unavailable");
    onEvidenceStage?.("t1", descriptor);
    fdinfo2 = parseFdinfoIdentity(readBoundedRegularFile(infoPath, "proc_unavailable"));
    onEvidenceStage?.("f2", descriptor);
  } catch (error) {
    if (
      error instanceof OpenFilesError &&
      entryIsAbsent(linkPath, "proc_unavailable") &&
      entryIsAbsent(infoPath, "proc_unavailable")
    ) {
      return null;
    }
    throw error;
  }
  if (
    !sameDescriptorFdinfoIdentity(fdinfo0, fdinfo1) ||
    !sameDescriptorFdinfoIdentity(fdinfo1, fdinfo2) ||
    !sameDescriptorTargetEvidence(targetEvidence0, targetEvidence1)
  ) {
    reject("proc_unavailable");
  }
  const identity = fdinfo2;
  const targetEvidence = targetEvidence1;
  const target = targetEvidence.target;
  const normalizedTarget = normalizeDescriptorTarget(target);
  if (
    isAbsolute(normalizedTarget) &&
    (normalizedTarget.includes("\0") ||
      normalizedTarget.includes("\n") ||
      resolve(normalizedTarget) !== normalizedTarget)
  ) {
    reject("alias_inspection_unavailable");
  }
  if (verifyTargetIdentity && identity.inode !== targetEvidence.inode) {
    reject("proc_unavailable");
  }
  const mount = mountsById.get(identity.mountId);
  if (
    verifyTargetIdentity &&
    mount !== undefined &&
    mount.device !== targetEvidence.device
  ) {
    reject("proc_unavailable");
  }
  if (mount === undefined) {
    return Object.freeze({
      device: targetEvidence.device,
      identity,
      key: identityKey(targetEvidence.device, identity.inode),
      mount: null,
      nlink: targetEvidence.nlink,
      normalizedTarget,
      signature: `${target}\0${targetEvidence.fileType}\0${targetEvidence.nlink}\0${descriptorSecurityFlags(identity.flags)}\0${identity.mountId}\0${targetEvidence.device}\0${identity.inode}`,
    });
  }
  const boundDevice = verifyTargetIdentity ? targetEvidence.device : mount.device;
  return Object.freeze({
    device: boundDevice,
    identity,
    key: identityKey(boundDevice, identity.inode),
    mount,
    nlink: targetEvidence.nlink,
    normalizedTarget,
    signature: `${target}\0${targetEvidence.fileType}\0${targetEvidence.nlink}\0${descriptorSecurityFlags(identity.flags)}\0${identity.mountId}\0${boundDevice}\0${identity.inode}`,
  });
}

function mappingEvidence(processDirectory, protectedIndex) {
  const maps = readBoundedRegularFile(
    join(processDirectory.path, "maps"),
    "alias_inspection_unavailable",
    MAX_MAPS_BYTES,
  );
  const stateMappings = parseMappingsForInspection(maps).filter(
    ({ device, inode }) =>
      inode !== 0n && protectedIndex.all.has(identityKey(device, inode)),
  );
  const mappingSignature = stateMappings
    .map(({ device, inode, permissions }) => `${device}:${inode}:${permissions[3]}`)
    .sort()
    .join("\n");
  if (stateMappings.length === 0) {
    return Object.freeze({
      mappingSignature,
      related: false,
      sharedMayWriteSignature: "",
      sharedWritableMappingDetected: false,
    });
  }
  const smaps = readBoundedRegularFile(
    join(processDirectory.path, "smaps"),
    "alias_inspection_unavailable",
    MAX_SMAPS_BYTES,
  );
  const smapsEvidence = parseSmapsForInspection(smaps);
  const stateSmaps = smapsEvidence.mappings.filter(({ device, inode }) =>
    protectedIndex.all.has(identityKey(device, inode)),
  );
  const smapsMappingSignature = stateSmaps
    .map(({ device, inode, permissions }) => `${device}:${inode}:${permissions[3]}`)
    .sort()
    .join("\n");
  if (smapsMappingSignature !== mappingSignature) {
    reject("alias_inspection_unavailable");
  }
  const sharedMayWrite = smapsEvidence.sharedMayWrite.filter(({ device, inode }) =>
    protectedIndex.all.has(identityKey(device, inode)),
  );
  const sharedMayWriteSignature = sharedMayWrite
    .map(({ device, inode }) => `${device}:${inode}`)
    .sort()
    .join("\n");
  return Object.freeze({
    mappingSignature,
    related: true,
    sharedMayWriteSignature,
    sharedWritableMappingDetected: sharedMayWrite.length > 0,
  });
}

const PROCESS_DETECTION_KEYS = Object.freeze([
  "directoryDescriptorDetected",
  "forbiddenCgroupMemberDetected",
  "processRootDetected",
  "serviceUidProcessDetected",
  "sharedWritableMappingDetected",
  "workingDirectoryDetected",
  "writableDescriptorDetected",
]);

function scanTask(
  taskDirectory,
  processName,
  taskName,
  protectedIndex,
  forbiddenCgroup,
  serviceUid,
  inspector,
  inspectorMountNamespaceIdentity,
  onDescriptorRead,
  onDescriptorEvidenceStage,
  onMappingEvidenceStored,
  readerMountEntries,
  verifyDescriptorTargetIdentity,
) {
  let taskMountNamespaceIdentity = null;
  const ensureTaskMountNamespaceIdentity = () => {
    if (taskMountNamespaceIdentity === null) {
      taskMountNamespaceIdentity = readMountNamespaceIdentity(taskDirectory);
    }
    return taskMountNamespaceIdentity;
  };
  const processIdentity = readProcessIdentity(taskDirectory, taskName);
  const status = readBoundedRegularFile(
    join(taskDirectory.path, "status"),
    "proc_unavailable",
    MAX_PROC_STATUS_BYTES,
  );
  const uids = parseProcStatusUids(status);
  const cgroup = readBoundedRegularFile(
    join(taskDirectory.path, "cgroup"),
    "proc_unavailable",
    MAX_CGROUP_BYTES,
  );
  let forbiddenCgroupMemberDetected = procCgroupContains(cgroup, forbiddenCgroup);
  let serviceUidProcessDetected = uids.some((uid) => uid === serviceUid);
  if (inspector && (forbiddenCgroupMemberDetected || serviceUidProcessDetected)) {
    reject("inspector_identity_invalid");
  }

  if (processIdentity.state === "Z") {
    if (inspector) reject("inspector_identity_invalid");
    const finalUids = parseProcStatusUids(
      readBoundedRegularFile(
        join(taskDirectory.path, "status"),
        "proc_unavailable",
        MAX_PROC_STATUS_BYTES,
      ),
    );
    const finalCgroup = readBoundedRegularFile(
      join(taskDirectory.path, "cgroup"),
      "proc_unavailable",
      MAX_CGROUP_BYTES,
    );
    serviceUidProcessDetected ||= finalUids.some((uid) => uid === serviceUid);
    forbiddenCgroupMemberDetected ||= procCgroupContains(finalCgroup, forbiddenCgroup);
    const finalIdentity = readProcessIdentity(taskDirectory, taskName);
    if (
      finalIdentity.state !== "Z" ||
      finalIdentity.starttime !== processIdentity.starttime
    ) {
      reject("proc_unavailable");
    }
    assertDirectoryUnchanged(taskDirectory, "proc_unavailable");
    return Object.freeze({
      directoryIdentity: procDirectoryIdentityProjection(taskDirectory.stat),
      directoryDescriptorDetected: false,
      forbiddenCgroupMemberDetected,
      processRootDetected: false,
      related: forbiddenCgroupMemberDetected || serviceUidProcessDetected,
      serviceUidProcessDetected,
      sharedWritableMappingDetected: false,
      starttime: processIdentity.starttime,
      taskMountNamespaceIdentity: null,
      taskMountProjection: null,
      workingDirectoryDetected: false,
      writableDescriptorDetected: false,
      zombie: true,
    });
  }

  const mountinfo = readBoundedRegularFile(
    join(taskDirectory.path, "mountinfo"),
    "alias_inspection_unavailable",
    MAX_MOUNTINFO_BYTES,
  );
  const mounts = parseTaskMountinfoForInspection(mountinfo);
  const mountSignature = mountProjectionSignature(mounts);
  const mountsById = new Map(mounts.map((entry) => [entry.mountId, entry]));
  const fdDirectory = inspectChildDirectory(taskDirectory, "fd", "proc_unavailable");
  const fdinfoDirectory = inspectChildDirectory(
    taskDirectory,
    "fdinfo",
    "proc_unavailable",
  );
  const descriptors = numericEntries(fdDirectory, FD_NAME, "proc_unavailable");
  const descriptorInfo = numericEntries(fdinfoDirectory, FD_NAME, "proc_unavailable");

  let directoryDescriptorDetected = false;
  let writableDescriptorDetected = false;
  const relatedDescriptorSignatures = new Map();
  for (const descriptor of numericNameUnion(descriptors, descriptorInfo)) {
    assertDirectoryUnchanged(taskDirectory, "proc_unavailable");
    const evidence = readDescriptorEvidence(
      fdDirectory,
      fdinfoDirectory,
      descriptor,
      mountsById,
      verifyDescriptorTargetIdentity,
      onDescriptorEvidenceStage === undefined
        ? undefined
        : (stage, descriptorName) =>
            onDescriptorEvidenceStage(processName, taskName, descriptorName, stage),
    );
    if (evidence === null) continue;
    const writable = hasWritableAccess(evidence.identity.flags);
    const stateRelated = evidence.key !== null && protectedIndex.all.has(evidence.key);
    const targetStateRelated =
      writable &&
      !stateRelated &&
      evidence.nlink === 0n &&
      evidence.device === protectedIndex.stateFilesystemDevice &&
      (() => {
        if (evidence.mount === null) reject("alias_inspection_unavailable");
        return deletedDescriptorTargetWritesState({
          descriptorMount: evidence.mount,
          inspectorMountNamespaceIdentity,
          nlink: evidence.nlink,
          readerMountEntries,
          stateFilesystemDevice: protectedIndex.stateFilesystemDevice,
          stateFilesystemRoot: protectedIndex.stateFilesystemRoot,
          taskMountNamespaceIdentity: ensureTaskMountNamespaceIdentity(),
          target: evidence.normalizedTarget,
        });
      })();
    if (targetStateRelated && writable) {
      relatedDescriptorSignatures.set(descriptor, evidence.signature);
      writableDescriptorDetected = true;
    }
    if (evidence.key === null) continue;
    const parentRelated = protectedIndex.parentDirectories.has(evidence.key);
    if (!stateRelated && !parentRelated) continue;
    relatedDescriptorSignatures.set(descriptor, evidence.signature);
    if (
      parentRelated ||
      protectedIndex.directories.has(evidence.key) ||
      (evidence.identity.flags & O_PATH) !== 0n
    ) {
      directoryDescriptorDetected = true;
    }
    if (stateRelated && writable) {
      writableDescriptorDetected = true;
    }
  }

  if (onDescriptorRead !== undefined) onDescriptorRead(processName, taskName);

  const mappings = mappingEvidence(taskDirectory, protectedIndex);
  if (onMappingEvidenceStored !== undefined) {
    onMappingEvidenceStored(processName, taskName);
  }
  let sharedWritableMappingDetected = mappings.sharedWritableMappingDetected;

  const cwd = readMagicDirectoryIdentity(
    join(taskDirectory.path, "cwd"),
    "proc_unavailable",
    { allowAbsent: processIdentity.kernelThread },
  );
  const processRoot = readMagicDirectoryIdentity(
    join(taskDirectory.path, "root"),
    "proc_unavailable",
    { allowAbsent: processIdentity.kernelThread },
  );
  let workingDirectoryDetected =
    cwd !== null &&
    (protectedIndex.directoriesRaw.has(cwd.key) ||
      protectedIndex.parentDirectoriesRaw.has(cwd.key));
  let processRootDetected =
    processRoot !== null &&
    (protectedIndex.directoriesRaw.has(processRoot.key) ||
      protectedIndex.parentDirectoriesRaw.has(processRoot.key));

  const finalUids = parseProcStatusUids(
    readBoundedRegularFile(
      join(taskDirectory.path, "status"),
      "proc_unavailable",
      MAX_PROC_STATUS_BYTES,
    ),
  );
  const finalCgroup = readBoundedRegularFile(
    join(taskDirectory.path, "cgroup"),
    "proc_unavailable",
    MAX_CGROUP_BYTES,
  );
  serviceUidProcessDetected ||= finalUids.some((uid) => uid === serviceUid);
  forbiddenCgroupMemberDetected ||= procCgroupContains(finalCgroup, forbiddenCgroup);
  if (inspector && (forbiddenCgroupMemberDetected || serviceUidProcessDetected)) {
    reject("inspector_identity_invalid");
  }
  const finalIdentity = readProcessIdentity(taskDirectory, taskName);
  if (
    finalIdentity.starttime !== processIdentity.starttime ||
    finalIdentity.state === "Z"
  ) {
    reject("proc_unavailable");
  }

  const related =
    inspector ||
    forbiddenCgroupMemberDetected ||
    serviceUidProcessDetected ||
    relatedDescriptorSignatures.size > 0 ||
    mappings.related ||
    workingDirectoryDetected ||
    processRootDetected;

  if (related) {
    const stableMountNamespaceIdentity = ensureTaskMountNamespaceIdentity();
    const finalMounts = parseTaskMountinfoForInspection(
      readBoundedRegularFile(
        join(taskDirectory.path, "mountinfo"),
        "alias_inspection_unavailable",
        MAX_MOUNTINFO_BYTES,
      ),
    );
    if (mountProjectionSignature(finalMounts) !== mountSignature) {
      reject("proc_unavailable");
    }
    const finalMountsById = new Map(finalMounts.map((entry) => [entry.mountId, entry]));
    for (const [descriptor, signature] of relatedDescriptorSignatures) {
      const finalEvidence = readDescriptorEvidence(
        fdDirectory,
        fdinfoDirectory,
        descriptor,
        finalMountsById,
        verifyDescriptorTargetIdentity,
        onDescriptorEvidenceStage === undefined
          ? undefined
          : (stage, descriptorName) =>
              onDescriptorEvidenceStage(
                processName,
                taskName,
                descriptorName,
                `final-${stage}`,
              ),
      );
      if (finalEvidence === null || finalEvidence.signature !== signature) {
        reject("proc_unavailable");
      }
    }

    const finalMappings = mappingEvidence(taskDirectory, protectedIndex);
    if (
      finalMappings.mappingSignature !== mappings.mappingSignature ||
      finalMappings.sharedMayWriteSignature !== mappings.sharedMayWriteSignature
    ) {
      reject("proc_unavailable");
    }
    sharedWritableMappingDetected ||= finalMappings.sharedWritableMappingDetected;

    const finalCwd = readMagicDirectoryIdentity(
      join(taskDirectory.path, "cwd"),
      "proc_unavailable",
      { allowAbsent: processIdentity.kernelThread },
    );
    const finalRoot = readMagicDirectoryIdentity(
      join(taskDirectory.path, "root"),
      "proc_unavailable",
      { allowAbsent: processIdentity.kernelThread },
    );
    workingDirectoryDetected ||=
      finalCwd !== null &&
      (protectedIndex.directoriesRaw.has(finalCwd.key) ||
        protectedIndex.parentDirectoriesRaw.has(finalCwd.key));
    processRootDetected ||=
      finalRoot !== null &&
      (protectedIndex.directoriesRaw.has(finalRoot.key) ||
        protectedIndex.parentDirectoriesRaw.has(finalRoot.key));

    const stableIdentity = readProcessIdentity(taskDirectory, taskName);
    if (
      stableIdentity.starttime !== processIdentity.starttime ||
      stableIdentity.state === "Z"
    ) {
      reject("proc_unavailable");
    }
    const finalMountNamespaceIdentity = readMountNamespaceIdentity(taskDirectory);
    if (
      !sameMountNamespaceIdentity(
        stableMountNamespaceIdentity,
        finalMountNamespaceIdentity,
      )
    ) {
      reject("alias_inspection_unavailable");
    }
    assertDirectoryUnchanged(taskDirectory, "proc_unavailable");
  }

  return Object.freeze({
    directoryIdentity: procDirectoryIdentityProjection(taskDirectory.stat),
    directoryDescriptorDetected,
    forbiddenCgroupMemberDetected,
    processRootDetected,
    related,
    serviceUidProcessDetected,
    sharedWritableMappingDetected,
    starttime: processIdentity.starttime,
    taskMountNamespaceIdentity,
    taskMountProjection: mountSignature,
    workingDirectoryDetected,
    writableDescriptorDetected,
    zombie: false,
  });
}

function scanProcessGroup(
  processDirectory,
  processName,
  protectedIndex,
  forbiddenCgroup,
  serviceUid,
  inspector,
  inspectorMountNamespaceIdentity,
  hooks,
  readerMountEntries,
  verifyDescriptorTargetIdentity,
) {
  const leaderIdentity = readProcessIdentity(processDirectory, processName);
  const taskRoot = inspectChildDirectory(processDirectory, "task", "proc_unavailable");
  const taskIdentityHistory = new Map();
  let sameTickReplacementDetected = false;

  taskScan: for (let pass = 0; pass < MAX_TASK_SCAN_PASSES; pass += 1) {
    const evidenceByTask = new Map();
    const taskNames = numericEntries(taskRoot, PID_NAME, "proc_unavailable");
    if (taskNames.length === 0) reject("proc_unavailable");
    if (!taskNames.includes(processName)) reject("proc_unavailable");
    if (
      leaderIdentity.state === "Z" &&
      (taskNames.length !== 1 || taskNames[0] !== processName)
    ) {
      reject("proc_unavailable");
    }
    for (const taskName of taskNames) {
      const taskDirectory = inspectOptionalChildDirectory(
        taskRoot,
        taskName,
        "proc_unavailable",
      );
      if (taskDirectory === null) continue taskScan;
      let currentIdentity;
      try {
        currentIdentity = readProcessIdentity(taskDirectory, taskName);
      } catch (error) {
        if (
          error instanceof OpenFilesError &&
          (entryIsAbsent(taskDirectory.path, "proc_unavailable") ||
            entryIsAbsent(join(taskDirectory.path, "stat"), "proc_unavailable"))
        ) {
          continue taskScan;
        }
        throw error;
      }
      if (
        taskName === processName &&
        (currentIdentity.state === "Z") !== (leaderIdentity.state === "Z")
      ) {
        reject("proc_unavailable");
      }
      const historicalIdentity = taskIdentityHistory.get(taskName);
      if (
        historicalIdentity?.starttime === currentIdentity.starttime &&
        !procDirectoryIdentityMatches(
          historicalIdentity.directoryIdentity,
          taskDirectory.stat,
        )
      ) {
        sameTickReplacementDetected = true;
      }
      taskIdentityHistory.set(
        taskName,
        Object.freeze({
          directoryIdentity: procDirectoryIdentityProjection(taskDirectory.stat),
          starttime: currentIdentity.starttime,
        }),
      );
      let taskResult;
      try {
        taskResult = scanTask(
          taskDirectory,
          processName,
          taskName,
          protectedIndex,
          forbiddenCgroup,
          serviceUid,
          inspector,
          inspectorMountNamespaceIdentity,
          hooks.onDescriptorRead,
          hooks.onDescriptorEvidenceStage,
          hooks.onMappingEvidenceStored,
          readerMountEntries,
          verifyDescriptorTargetIdentity,
        );
      } catch (error) {
        if (
          error instanceof OpenFilesError &&
          taskChangedOrUnavailable(taskDirectory, taskName, currentIdentity)
        ) {
          continue taskScan;
        }
        throw error;
      }
      evidenceByTask.set(taskName, taskResult);
      if (hooks.onTaskEvidenceStored !== undefined) {
        hooks.onTaskEvidenceStored(processName, taskName);
      }
    }

    const finalTaskNames = numericEntries(taskRoot, PID_NAME, "proc_unavailable");
    const finalTaskSet = new Set(finalTaskNames);
    for (const taskName of evidenceByTask.keys()) {
      if (!finalTaskSet.has(taskName)) evidenceByTask.delete(taskName);
    }
    let stable = finalTaskNames.length > 0;
    for (const taskName of finalTaskNames) {
      const taskDirectory = inspectOptionalChildDirectory(
        taskRoot,
        taskName,
        "proc_unavailable",
      );
      if (taskDirectory === null) {
        stable = false;
        continue;
      }
      let currentIdentity;
      try {
        currentIdentity = readProcessIdentity(taskDirectory, taskName);
      } catch (error) {
        if (
          error instanceof OpenFilesError &&
          (entryIsAbsent(taskDirectory.path, "proc_unavailable") ||
            entryIsAbsent(join(taskDirectory.path, "stat"), "proc_unavailable"))
        ) {
          stable = false;
          continue;
        }
        throw error;
      }
      const evidence = evidenceByTask.get(taskName);
      if (hooks.onTaskFinalIdentity !== undefined) {
        hooks.onTaskFinalIdentity(processName, taskName);
      }
      if (
        evidence?.starttime !== currentIdentity.starttime ||
        evidence.zombie !== (currentIdentity.state === "Z") ||
        !procDirectoryIdentityMatches(evidence.directoryIdentity, taskDirectory.stat)
      ) {
        stable = false;
      }
    }
    if (!stable) continue;

    const finalLeaderIdentity = readProcessIdentity(processDirectory, processName);
    if (
      finalLeaderIdentity.starttime !== leaderIdentity.starttime ||
      (finalLeaderIdentity.state === "Z") !== (leaderIdentity.state === "Z")
    ) {
      reject("proc_unavailable");
    }
    assertDirectoryUnchanged(taskRoot, "proc_unavailable");
    assertDirectoryUnchanged(processDirectory, "proc_unavailable");

    const result = emptyInspectionResult();
    const identities = new Map();
    for (const [taskName, taskResult] of evidenceByTask) {
      identities.set(
        `${processName}/${taskName}`,
        Object.freeze({
          directoryIdentity: taskResult.directoryIdentity,
          related: taskResult.related,
          starttime: taskResult.starttime,
          taskMountNamespaceIdentity: taskResult.taskMountNamespaceIdentity,
          taskMountProjection: taskResult.taskMountProjection,
        }),
      );
      for (const key of PROCESS_DETECTION_KEYS) {
        if (taskResult[key]) result[key] = true;
      }
    }
    if (sameTickReplacementDetected && resultIsOk(result)) {
      reject("proc_unavailable");
    }
    return Object.freeze({ identities, result: Object.freeze(result) });
  }

  reject("proc_unavailable");
}

function scanProc(
  procDirectory,
  protectedIndex,
  forbiddenCgroup,
  serviceUid,
  inspectorPid,
  inspectorMountNamespaceIdentity,
  hooks,
  readerMountEntries,
  verifyDescriptorTargetIdentity,
) {
  assertDirectoryUnchanged(procDirectory, "proc_unavailable");
  const processes = numericEntries(procDirectory, PID_NAME, "proc_unavailable", {
    ignoreOther: true,
  });
  const result = emptyInspectionResult();
  const identities = new Map();
  let inspectorProved = false;
  for (const processName of processes) {
    const processDirectory = inspectOptionalChildDirectory(
      procDirectory,
      processName,
      "proc_unavailable",
      { procfs: true },
    );
    if (processDirectory === null) continue;
    let processResult;
    try {
      processResult = scanProcessGroup(
        processDirectory,
        processName,
        protectedIndex,
        forbiddenCgroup,
        serviceUid,
        processName === inspectorPid,
        inspectorMountNamespaceIdentity,
        hooks,
        readerMountEntries,
        verifyDescriptorTargetIdentity,
      );
    } catch (error) {
      if (
        processName !== inspectorPid &&
        error instanceof OpenFilesError &&
        entryIsAbsent(processDirectory.path, "proc_unavailable")
      ) {
        continue;
      }
      throw error;
    }
    for (const [identity, observation] of processResult.identities) {
      identities.set(identity, observation);
    }
    if (processName === inspectorPid) inspectorProved = true;
    for (const key of PROCESS_DETECTION_KEYS) {
      if (processResult.result[key]) result[key] = true;
    }
  }
  if (!inspectorProved) reject("inspector_identity_invalid");
  return Object.freeze({ identities, result: Object.freeze(result) });
}

function inspectMarker(root, nonce) {
  const markerPath = join(root.path, TEST_MARKER_NAME);
  const marker = safeStat(markerPath, "test_root_invalid");
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !marker.isFile() ||
    marker.isSymbolicLink() ||
    marker.nlink !== 1n ||
    (marker.mode & 0o777n) !== 0o600n ||
    (currentUid !== null && marker.uid !== BigInt(currentUid)) ||
    marker.size > BigInt(TEST_MARKER_MAX_BYTES)
  ) {
    reject("test_root_invalid");
  }
  const contents = readBoundedRegularFile(
    markerPath,
    "test_root_invalid",
    TEST_MARKER_MAX_BYTES,
  );
  const after = safeStat(markerPath, "test_root_invalid");
  if (!sameFileIdentity(marker, after)) reject("test_root_invalid");
  if (contents !== nonce) reject("test_root_invalid");
  assertDirectoryUnchanged(root, "test_root_invalid");
}

function strictDescendant(path, root) {
  const offset = relative(root, path);
  return offset !== "" && offset !== ".." && !offset.startsWith(`..${sep}`);
}

function authorizeTestRoots(procRoot, cgroupRoot, stateRoot) {
  if (process.env.AGENT_OS_DEPLOY_TEST_MODE !== "1") reject("test_mode_required");
  const requestedRoot = process.env.AGENT_OS_DEPLOY_TEST_ROOT ?? "";
  const nonce = process.env.AGENT_OS_DEPLOY_TEST_NONCE ?? "";
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(nonce)) reject("test_root_invalid");
  const root = inspectDirectoryChain(requestedRoot, "test_root_invalid");
  inspectMarker(root, nonce);
  if (
    !strictDescendant(procRoot, root.path) ||
    !strictDescendant(cgroupRoot, root.path) ||
    !strictDescendant(stateRoot, root.path)
  ) {
    reject("test_root_invalid");
  }
  return root;
}

function parseArguments(argv) {
  if (argv.length < 1 || argv[0].startsWith("--") || argv.length % 2 === 0) {
    reject("usage");
  }
  const values = new Map();
  const allowed = new Set([
    "--cgroup-root",
    "--forbidden-cgroup",
    "--inspector-pid",
    "--proc-root",
    "--service-uid",
    "--unit-inactive-proof",
  ]);
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || values.has(name)) reject("usage");
    values.set(name, value);
  }
  const forbiddenCgroup = values.get("--forbidden-cgroup");
  const serviceUid = values.get("--service-uid");
  if (forbiddenCgroup === undefined || serviceUid === undefined) reject("usage");
  if (serviceUid.length > 10 || !POSITIVE_DECIMAL.test(serviceUid)) reject("usage");
  const parsedServiceUid = BigInt(serviceUid);
  if (parsedServiceUid === 0n || parsedServiceUid > MAX_LINUX_UID) reject("usage");
  const unitInactiveProof = values.get("--unit-inactive-proof");
  if (unitInactiveProof !== undefined && unitInactiveProof !== UNIT_INACTIVE_PROOF) {
    reject("usage");
  }
  const testOverride =
    values.has("--proc-root") ||
    values.has("--cgroup-root") ||
    values.has("--inspector-pid");
  const inspectorPid = values.get("--inspector-pid") ?? String(process.pid);
  if (!PID_NAME.test(inspectorPid)) reject("usage");
  return Object.freeze({
    cgroupRoot: values.get("--cgroup-root") ?? "/sys/fs/cgroup",
    forbiddenCgroup,
    inspectorPid,
    procRoot: values.get("--proc-root") ?? "/proc",
    serviceUid: parsedServiceUid,
    stateRoot: argv[0],
    testOverride,
    unitInactiveProof,
  });
}

function readCgroupPopulated(cgroupDirectory) {
  assertDirectoryUnchanged(cgroupDirectory, "cgroup_unavailable");
  const events = parseCgroupEvents(
    readBoundedRegularFile(
      join(cgroupDirectory.path, "cgroup.events"),
      "cgroup_unavailable",
      MAX_CGROUP_BYTES,
    ),
  );
  assertDirectoryUnchanged(cgroupDirectory, "cgroup_unavailable");
  return events.populated !== 0n;
}

function readServiceCgroupState(cgroupRootDirectory, forbiddenCgroup, unitInactiveProof) {
  const relativePath = forbiddenCgroup.slice(1);
  let directory = inspectOptionalDescendantDirectory(
    cgroupRootDirectory,
    relativePath,
    "cgroup_unavailable",
  );
  if (directory === null) {
    if (unitInactiveProof !== UNIT_INACTIVE_PROOF) reject("cgroup_unavailable");
    return Object.freeze({ absent: true, populated: false });
  }
  try {
    return Object.freeze({
      absent: false,
      populated: readCgroupPopulated(directory),
    });
  } catch (error) {
    directory = inspectOptionalDescendantDirectory(
      cgroupRootDirectory,
      relativePath,
      "cgroup_unavailable",
    );
    if (
      error instanceof OpenFilesError &&
      directory === null &&
      unitInactiveProof === UNIT_INACTIVE_PROOF
    ) {
      return Object.freeze({ absent: true, populated: false });
    }
    throw error;
  }
}

export function inspectStateOpenFiles({
  cgroupRoot = "/sys/fs/cgroup",
  forbiddenCgroup,
  inspectorPid = String(process.pid),
  onBetweenScans,
  onDescriptorRead,
  onDescriptorEvidenceStage,
  onMappingEvidenceStored,
  onTaskEvidenceStored,
  onTaskFinalIdentity,
  procRoot,
  serviceUid,
  stateRoot,
  testOverride = false,
  unitInactiveProof,
  verifyDescriptorTargetIdentity,
}) {
  requireCanonicalAbsolute(stateRoot, "state_root_invalid");
  requireCanonicalAbsolute(procRoot, "proc_unavailable");
  requireCanonicalAbsolute(cgroupRoot, "cgroup_unavailable", { allowRoot: true });
  normalizeForbiddenCgroup(forbiddenCgroup);
  if (typeof serviceUid !== "bigint" || serviceUid <= 0n || serviceUid > MAX_LINUX_UID) {
    reject("service_uid_invalid");
  }
  if (typeof inspectorPid !== "string" || !PID_NAME.test(inspectorPid)) {
    reject("inspector_identity_invalid");
  }
  if (onDescriptorRead !== undefined && typeof onDescriptorRead !== "function") {
    reject("inspection_invalid");
  }
  if (
    onDescriptorEvidenceStage !== undefined &&
    typeof onDescriptorEvidenceStage !== "function"
  ) {
    reject("inspection_invalid");
  }
  if (
    verifyDescriptorTargetIdentity !== undefined &&
    (!testOverride || verifyDescriptorTargetIdentity !== true)
  ) {
    reject("inspection_invalid");
  }
  if (
    onMappingEvidenceStored !== undefined &&
    typeof onMappingEvidenceStored !== "function"
  ) {
    reject("inspection_invalid");
  }
  if (
    (onTaskEvidenceStored !== undefined && typeof onTaskEvidenceStored !== "function") ||
    (onTaskFinalIdentity !== undefined && typeof onTaskFinalIdentity !== "function") ||
    (!testOverride &&
      (onMappingEvidenceStored !== undefined ||
        onDescriptorEvidenceStage !== undefined ||
        onTaskEvidenceStored !== undefined ||
        onTaskFinalIdentity !== undefined))
  ) {
    reject("inspection_invalid");
  }
  const hooks = Object.freeze({
    onDescriptorRead,
    onDescriptorEvidenceStage,
    onMappingEvidenceStored,
    onTaskEvidenceStored,
    onTaskFinalIdentity,
  });
  if (unitInactiveProof !== undefined && unitInactiveProof !== UNIT_INACTIVE_PROOF) {
    reject("unit_inactive_proof_invalid");
  }
  const testRoot = testOverride
    ? authorizeTestRoots(procRoot, cgroupRoot, stateRoot)
    : null;
  const stateDirectory = inspectDirectoryChain(stateRoot, "state_root_invalid");
  const procDirectory = inspectDirectoryChain(procRoot, "proc_unavailable");
  const cgroupRootDirectory = inspectDirectoryChain(cgroupRoot, "cgroup_unavailable", {
    allowRoot: true,
  });
  if (testRoot) assertDirectoryUnchanged(testRoot, "test_root_invalid");

  const inspectorDirectory = inspectChildDirectory(
    procDirectory,
    inspectorPid,
    "inspector_identity_invalid",
    { procfs: true },
  );
  const inspectorTaskRoot = inspectChildDirectory(
    inspectorDirectory,
    "task",
    "inspector_identity_invalid",
  );
  const inspectorTaskDirectory = inspectChildDirectory(
    inspectorTaskRoot,
    inspectorPid,
    "inspector_identity_invalid",
  );
  const inspectorMountNamespaceIdentity =
    readMountNamespaceIdentity(inspectorTaskDirectory);
  const inspectorMountinfoPath = join(inspectorTaskDirectory.path, "mountinfo");
  const inspectorMountinfoContents = readBoundedRegularFile(
    inspectorMountinfoPath,
    "alias_inspection_unavailable",
    MAX_MOUNTINFO_BYTES,
  );
  const inspectorMountinfo = parseMountinfoForInspection(inspectorMountinfoContents);
  const inspectorMountProjection = mountProjectionSignature(inspectorMountinfo);
  const protectedIndex = buildProtectedIdentityIndex(stateDirectory, inspectorMountinfo, {
    verifyStatDevices: !testOverride,
  });
  const result = emptyInspectionResult();
  let priorIdentities = null;
  for (let scan = 0; scan < SCAN_COUNT; scan += 1) {
    const cgroupBefore = readServiceCgroupState(
      cgroupRootDirectory,
      forbiddenCgroup,
      unitInactiveProof,
    );
    result.cgroupDirectoryAbsent ||= cgroupBefore.absent;
    result.cgroupPopulatedDetected ||= cgroupBefore.populated;
    const scanResult = scanProc(
      procDirectory,
      protectedIndex,
      forbiddenCgroup,
      serviceUid,
      inspectorPid,
      inspectorMountNamespaceIdentity,
      hooks,
      inspectorMountinfo,
      !testOverride || verifyDescriptorTargetIdentity === true,
    );
    for (const key of PROCESS_DETECTION_KEYS) {
      if (scanResult.result[key]) result[key] = true;
    }
    if (priorIdentities !== null) {
      for (const [identity, prior] of priorIdentities) {
        const current = scanResult.identities.get(identity);
        if (
          prior.related &&
          current !== undefined &&
          (current.starttime !== prior.starttime ||
            !sameProcDirectoryIdentity(
              current.directoryIdentity,
              prior.directoryIdentity,
            ) ||
            (prior.taskMountProjection !== null &&
              current.taskMountProjection !== prior.taskMountProjection) ||
            (prior.taskMountNamespaceIdentity !== null &&
              (current.taskMountNamespaceIdentity === null ||
                !sameMountNamespaceIdentity(
                  current.taskMountNamespaceIdentity,
                  prior.taskMountNamespaceIdentity,
                ))))
        ) {
          reject("proc_unavailable");
        }
      }
    }
    priorIdentities = scanResult.identities;
    if (scan === 0 && onBetweenScans !== undefined) {
      if (typeof onBetweenScans !== "function") reject("inspection_invalid");
      onBetweenScans();
    }
    const finalInspectorMountinfo = parseMountinfoForInspection(
      readBoundedRegularFile(
        inspectorMountinfoPath,
        "alias_inspection_unavailable",
        MAX_MOUNTINFO_BYTES,
      ),
    );
    if (mountProjectionSignature(finalInspectorMountinfo) !== inspectorMountProjection) {
      reject("alias_inspection_unavailable");
    }
    if (
      !sameMountNamespaceIdentity(
        readMountNamespaceIdentity(inspectorTaskDirectory),
        inspectorMountNamespaceIdentity,
      )
    ) {
      reject("alias_inspection_unavailable");
    }
    const currentIndex = buildProtectedIdentityIndex(
      stateDirectory,
      finalInspectorMountinfo,
      { verifyStatDevices: !testOverride },
    );
    if (currentIndex.fingerprint !== protectedIndex.fingerprint) {
      reject("state_root_changed");
    }
    const cgroupAfter = readServiceCgroupState(
      cgroupRootDirectory,
      forbiddenCgroup,
      unitInactiveProof,
    );
    result.cgroupDirectoryAbsent ||= cgroupAfter.absent;
    result.cgroupPopulatedDetected ||= cgroupAfter.populated;
    assertDirectoryUnchanged(inspectorTaskDirectory, "inspector_identity_invalid");
    assertDirectoryUnchanged(inspectorTaskRoot, "inspector_identity_invalid");
    assertDirectoryUnchanged(inspectorDirectory, "inspector_identity_invalid");
    assertDirectoryUnchanged(stateDirectory, "state_root_changed");
    assertDirectoryUnchanged(procDirectory, "proc_unavailable");
    assertDirectoryUnchanged(cgroupRootDirectory, "cgroup_unavailable");
    if (testRoot) assertDirectoryUnchanged(testRoot, "test_root_invalid");
  }
  return Object.freeze({ ...result, ok: resultIsOk(result), scanCount: SCAN_COUNT });
}

export function runStateOpenFiles(argv, options = {}) {
  const args = parseArguments(argv);
  return inspectStateOpenFiles({
    ...args,
    onBetweenScans: options.onBetweenScans,
    onDescriptorRead: options.onDescriptorRead,
    onDescriptorEvidenceStage: options.onDescriptorEvidenceStage,
    onMappingEvidenceStored: options.onMappingEvidenceStored,
    onTaskEvidenceStored: options.onTaskEvidenceStored,
    onTaskFinalIdentity: options.onTaskFinalIdentity,
  });
}

function main() {
  try {
    const result = runStateOpenFiles(process.argv.slice(2));
    process.stdout.write(`${serializeStateOpenFilesResult(result)}\n`);
    if (!result.ok) {
      const reason = result.cgroupPopulatedDetected
        ? "service cgroup is populated"
        : result.serviceUidProcessDetected
          ? "service uid process detected"
          : result.forbiddenCgroupMemberDetected
            ? "forbidden cgroup member detected"
            : result.sharedWritableMappingDetected
              ? "shared writable mapping detected"
              : result.processRootDetected
                ? "process root intersects state"
                : result.workingDirectoryDetected
                  ? "working directory intersects state"
                  : result.directoryDescriptorDetected
                    ? "state directory descriptor detected"
                    : "writable descriptor detected";
      process.stderr.write(`Hub state observable-reference gate failed: ${reason}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    const aliasInspectionComplete = error?.code !== "alias_inspection_unavailable";
    process.stdout.write(
      `${serializeStateOpenFilesResult(
        emptyInspectionResult(false, aliasInspectionComplete),
      )}\n`,
    );
    const reason = aliasInspectionComplete
      ? "inspection unavailable"
      : "mount alias inspection unavailable";
    process.stderr.write(`Hub state observable-reference gate failed: ${reason}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) main();
