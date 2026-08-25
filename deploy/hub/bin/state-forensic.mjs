#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

const FORMAT_VERSION = 1;
const COPY_BUFFER_BYTES = 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_ENTRIES = 100_000;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_PATH_BYTES = 4_096;
const MAX_OWNER_ID = 4_294_967_294;
const SNAPSHOT_DIRECTORY_MODE = 0o500;
const SNAPSHOT_FILE_MODE = 0o400;
const STAGING_DIRECTORY_MODE = 0o700;
const SAFE_COMPONENT =
  /^(?!\.)(?!.*(?:^|[._-])(?:tmp|temp|partial|incomplete)(?:$|[._-]))[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTROL_NAMES = ["COMPLETE", "data", "manifest.json", "manifest.sha256"];

class ForensicError extends Error {
  constructor(code) {
    super(code);
    this.name = "ForensicError";
    this.code = code;
  }
}

function reject(code) {
  throw new ForensicError(code);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareBuffers(left, right) {
  return Buffer.compare(left, right);
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  return (
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
  );
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
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

function safeAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < left) reject("snapshot_limit");
  return result;
}

function numericStatValue(value) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) reject("snapshot_limit");
  return Number(value);
}

function mode(stat) {
  return Number(stat.mode & 0o7777n);
}

function ownerValue(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_OWNER_ID;
}

function parseOwner(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) {
    reject("ownership_invalid");
  }
  const parsed = Number(value);
  if (!ownerValue(parsed)) reject("ownership_invalid");
  return parsed;
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
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
  ) {
    return false;
  }
  return value.split("/").every(safeComponent);
}

function lexicalPath(value) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === parse(value).root ||
    value.includes("\\") ||
    value.includes("\0") ||
    !safeComponent(basename(value))
  ) {
    reject("unsafe_path");
  }
  return value;
}

function parseFlags(arguments_, allowed, required) {
  if (arguments_.length % 2 !== 0) reject("invalid_arguments");
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(flag) || values.has(flag) || value === undefined) {
      reject("invalid_arguments");
    }
    values.set(flag, value);
  }
  if (required.some((flag) => !values.has(flag))) reject("invalid_arguments");
  return values;
}

function parseDigest(value) {
  if (!SHA256.test(value)) reject("manifest_digest_invalid");
  return value;
}

function stableIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid];
}

function volatileIdentity(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.rdev,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ];
}

function sameIdentity(left, right) {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

function identityText(stat) {
  return volatileIdentity(stat)
    .map((value) => value.toString())
    .join(":");
}

function openDirectory(path) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    closeSync(fd);
    reject("unsafe_tree");
  }
  return { fd, stat };
}

function ancestorPaths(path) {
  const filesystemRoot = parse(path).root;
  const paths = [filesystemRoot];
  let current = filesystemRoot;
  for (const component of path.slice(filesystemRoot.length).split(sep)) {
    if (component.length === 0) continue;
    current = join(current, component);
    paths.push(current);
  }
  return paths;
}

function captureAncestors(path, code) {
  const identities = [];
  for (const current of ancestorPaths(path)) {
    let before;
    try {
      before = lstatSync(current, { bigint: true });
    } catch {
      reject(code);
    }
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      realpathSync.native(current) !== current
    ) {
      reject(code);
    }
    const opened = openDirectory(current);
    try {
      if (!sameIdentity(stableIdentity(before), stableIdentity(opened.stat))) {
        reject("tree_changed");
      }
      identities.push(stableIdentity(opened.stat));
    } finally {
      closeSync(opened.fd);
    }
  }
  return identities;
}

function sameAncestors(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => sameIdentity(value, right[index]))
  );
}

function existingDirectory(path, code) {
  const ancestors = captureAncestors(path, code);
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync.native(path) !== path
  ) {
    reject(code);
  }
  return { ancestors, stat };
}

function trustedTargetParent(path) {
  const context = existingDirectory(path, "unsafe_target_parent");
  if ((mode(context.stat) & 0o022) !== 0) reject("unsafe_target_parent");
  return context;
}

function assertSameAncestors(path, expected, code = "tree_changed") {
  if (!sameAncestors(expected, captureAncestors(path, code))) reject("tree_changed");
}

function assertMissing(path, code) {
  try {
    lstatSync(path);
    reject(code);
  } catch (error) {
    if (error instanceof ForensicError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
}

function readNames(path) {
  const names = readdirSync(path, { encoding: "buffer" }).sort(compareBuffers);
  for (const buffer of names) {
    const value = buffer.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(buffer) || !safeComponent(value)) {
      reject("unsafe_tree");
    }
  }
  return names;
}

function sameNames(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value.equals(right[index]))
  );
}

function relativeName(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (!safeRelativePath(value)) reject("unsafe_tree");
  return value;
}

function scanTree(root) {
  const rootContext = existingDirectory(root, "unsafe_source");
  const rootIdentity = volatileIdentity(rootContext.stat);
  const rootDevice = rootContext.stat.dev;
  const directories = [];
  const files = [];
  const identities = new Map();
  let entries = 0;
  let totalBytes = 0;

  function record(path, stat) {
    if (identities.has(path)) reject("unsafe_tree");
    identities.set(path, identityText(stat));
  }

  function readFile(path, relativePath, before) {
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.dev !== rootDevice
    ) {
      reject("unsafe_tree");
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        !sameIdentity(volatileIdentity(before), volatileIdentity(opened))
      ) {
        reject("tree_changed");
      }
      const expectedSize = numericStatValue(opened.size);
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let total = 0;
      while (true) {
        const length = readSync(fd, buffer, 0, buffer.length, null);
        if (length === 0) break;
        total = safeAdd(total, length);
        if (total > expectedSize) reject("tree_changed");
        hash.update(buffer.subarray(0, length));
      }
      const after = fstatSync(fd, { bigint: true });
      const afterPath = lstatSync(path, { bigint: true });
      if (
        total !== expectedSize ||
        !sameIdentity(volatileIdentity(opened), volatileIdentity(after)) ||
        !sameIdentity(volatileIdentity(opened), volatileIdentity(afterPath))
      ) {
        reject("tree_changed");
      }
      record(relativePath, opened);
      totalBytes = safeAdd(totalBytes, total);
      files.push({
        relativePath,
        type: "file",
        mode: mode(opened),
        uid: numericStatValue(opened.uid),
        gid: numericStatValue(opened.gid),
        size: total,
        sha256: hash.digest("hex"),
      });
    } finally {
      closeSync(fd);
    }
  }

  function walk(path, relativePath, expected, depth) {
    if (depth > MAX_DEPTH) reject("snapshot_limit");
    const before = lstatSync(path, { bigint: true });
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      before.dev !== rootDevice ||
      !sameIdentity(volatileIdentity(before), volatileIdentity(expected))
    ) {
      reject("tree_changed");
    }
    const opened = openDirectory(path);
    try {
      if (!sameIdentity(volatileIdentity(before), volatileIdentity(opened.stat)))
        reject("tree_changed");
      record(relativePath, opened.stat);
      directories.push({
        relativePath,
        type: "directory",
        mode: mode(opened.stat),
        uid: numericStatValue(opened.stat.uid),
        gid: numericStatValue(opened.stat.gid),
      });
      const namesBefore = readNames(path);
      for (const nameBuffer of namesBefore) {
        entries = safeAdd(entries, 1);
        if (entries > MAX_ENTRIES) reject("snapshot_limit");
        const name = nameBuffer.toString("utf8");
        const child = join(path, name);
        const childRelative = relativePath === "." ? name : `${relativePath}/${name}`;
        if (!safeRelativePath(childRelative)) reject("unsafe_tree");
        const childStat = lstatSync(child, { bigint: true });
        if (childStat.isSymbolicLink() || childStat.dev !== rootDevice)
          reject("unsafe_tree");
        if (childStat.isDirectory()) {
          walk(child, childRelative, childStat, depth + 1);
        } else if (childStat.isFile()) {
          readFile(child, childRelative, childStat);
        } else {
          reject("unsafe_tree");
        }
      }
      const namesAfter = readNames(path);
      const after = fstatSync(opened.fd, { bigint: true });
      const afterPath = lstatSync(path, { bigint: true });
      if (
        !sameNames(namesBefore, namesAfter) ||
        !sameIdentity(volatileIdentity(opened.stat), volatileIdentity(after)) ||
        !sameIdentity(volatileIdentity(opened.stat), volatileIdentity(afterPath))
      ) {
        reject("tree_changed");
      }
    } finally {
      closeSync(opened.fd);
    }
  }

  walk(root, ".", rootContext.stat, 0);
  assertSameAncestors(root, rootContext.ancestors);
  if (!sameIdentity(rootIdentity, volatileIdentity(lstatSync(root, { bigint: true })))) {
    reject("tree_changed");
  }
  directories.sort((left, right) => compareText(left.relativePath, right.relativePath));
  files.sort((left, right) => compareText(left.relativePath, right.relativePath));
  const sourceTreeSha256 = sha256(
    canonicalJson({ directories, files, version: FORMAT_VERSION }),
  );
  return {
    directories,
    files,
    identities,
    sourceTreeSha256,
    totals: {
      entries,
      directories: directories.length,
      files: files.length,
      bytes: totalBytes,
    },
  };
}

function sameScan(left, right) {
  if (
    left.sourceTreeSha256 !== right.sourceTreeSha256 ||
    canonicalJson(left.totals) !== canonicalJson(right.totals) ||
    left.identities.size !== right.identities.size
  ) {
    return false;
  }
  for (const [path, identity] of left.identities) {
    if (right.identities.get(path) !== identity) return false;
  }
  return true;
}

function setOwnerAndMode(fd, owner, fileMode) {
  const before = fstatSync(fd, { bigint: true });
  if (before.uid !== BigInt(owner.uid) || before.gid !== BigInt(owner.gid)) {
    fchownSync(fd, owner.uid, owner.gid);
  }
  fchmodSync(fd, fileMode);
}

function setDirectory(path, owner, directoryMode) {
  const opened = openDirectory(path);
  try {
    setOwnerAndMode(opened.fd, owner, directoryMode);
    fsyncSync(opened.fd);
  } finally {
    closeSync(opened.fd);
  }
}

function createDirectory(path, owner) {
  mkdirSync(path, { recursive: false, mode: STAGING_DIRECTORY_MODE });
  setDirectory(path, owner, STAGING_DIRECTORY_MODE);
}

function copyExactFile(sourceRoot, destinationRoot, entry, expectedIdentity, owner) {
  const source = join(sourceRoot, ...entry.relativePath.split("/"));
  const destination = join(destinationRoot, ...entry.relativePath.split("/"));
  const before = lstatSync(source, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    identityText(before) !== expectedIdentity
  ) {
    reject("tree_changed");
  }
  const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationFd = null;
  try {
    const opened = fstatSync(sourceFd, { bigint: true });
    if (!sameIdentity(volatileIdentity(before), volatileIdentity(opened)))
      reject("tree_changed");
    destinationFd = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      SNAPSHOT_FILE_MODE,
    );
    setOwnerAndMode(destinationFd, owner, SNAPSHOT_FILE_MODE);
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    const hash = createHash("sha256");
    let total = 0;
    while (true) {
      const length = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (length === 0) break;
      total = safeAdd(total, length);
      if (total > entry.size) reject("tree_changed");
      hash.update(buffer.subarray(0, length));
      let offset = 0;
      while (offset < length) {
        const written = writeSync(destinationFd, buffer, offset, length - offset, null);
        if (written <= 0) reject("copy_failed");
        offset += written;
      }
    }
    const after = fstatSync(sourceFd, { bigint: true });
    const afterPath = lstatSync(source, { bigint: true });
    if (
      total !== entry.size ||
      hash.digest("hex") !== entry.sha256 ||
      !sameIdentity(volatileIdentity(opened), volatileIdentity(after)) ||
      !sameIdentity(volatileIdentity(opened), volatileIdentity(afterPath))
    ) {
      reject("tree_changed");
    }
    fsyncSync(destinationFd);
    const copied = fstatSync(destinationFd, { bigint: true });
    const copiedPath = lstatSync(destination, { bigint: true });
    if (
      !copied.isFile() ||
      copied.nlink !== 1n ||
      mode(copied) !== SNAPSHOT_FILE_MODE ||
      copied.size !== BigInt(entry.size) ||
      copied.uid !== BigInt(owner.uid) ||
      copied.gid !== BigInt(owner.gid) ||
      !sameIdentity(volatileIdentity(copied), volatileIdentity(copiedPath))
    ) {
      reject("copy_failed");
    }
  } finally {
    if (destinationFd !== null) closeSync(destinationFd);
    closeSync(sourceFd);
  }
}

function writeExclusive(path, body, owner) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    SNAPSHOT_FILE_MODE,
  );
  try {
    setOwnerAndMode(fd, owner, SNAPSHOT_FILE_MODE);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) reject("copy_failed");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path) {
  const opened = openDirectory(path);
  try {
    fsyncSync(opened.fd);
  } finally {
    closeSync(opened.fd);
  }
}

function strictUtf8(bytes, code) {
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    reject(code);
  }
  if (!Buffer.from(value, "utf8").equals(bytes)) reject(code);
  return value;
}

function readRegular(path, maxBytes, expectedMode = SNAPSHOT_FILE_MODE) {
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    mode(before) !== expectedMode ||
    before.size > BigInt(maxBytes)
  ) {
    reject("snapshot_invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameIdentity(volatileIdentity(before), volatileIdentity(opened)))
      reject("snapshot_changed");
    const size = numericStatValue(opened.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const length = readSync(fd, bytes, offset, size - offset, null);
      if (length === 0) reject("snapshot_changed");
      offset += length;
    }
    const after = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      !sameIdentity(volatileIdentity(opened), volatileIdentity(after)) ||
      !sameIdentity(volatileIdentity(opened), volatileIdentity(afterPath))
    ) {
      reject("snapshot_changed");
    }
    return { bytes, stat: opened };
  } finally {
    closeSync(fd);
  }
}

function validMode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0o7777;
}

function validDate(value) {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validateManifest(value, raw) {
  if (
    !exactKeys(value, [
      "artifactOwner",
      "createdAt",
      "directories",
      "files",
      "sourceTreeSha256",
      "totals",
      "version",
    ]) ||
    value.version !== FORMAT_VERSION ||
    !validDate(value.createdAt) ||
    !exactKeys(value.artifactOwner, ["gid", "uid"]) ||
    !ownerValue(value.artifactOwner.uid) ||
    !ownerValue(value.artifactOwner.gid) ||
    !Array.isArray(value.directories) ||
    !Array.isArray(value.files) ||
    !SHA256.test(value.sourceTreeSha256) ||
    !exactKeys(value.totals, ["bytes", "directories", "entries", "files"]) ||
    raw !== canonicalJson(value)
  ) {
    reject("manifest_invalid");
  }
  if (
    value.directories.length === 0 ||
    value.directories.length + value.files.length - 1 > MAX_ENTRIES ||
    value.totals.directories !== value.directories.length ||
    value.totals.files !== value.files.length ||
    value.totals.entries !== value.directories.length + value.files.length - 1 ||
    !Number.isSafeInteger(value.totals.bytes) ||
    value.totals.bytes < 0
  ) {
    reject("manifest_invalid");
  }
  const directories = new Set();
  for (const [index, entry] of value.directories.entries()) {
    if (
      !exactKeys(entry, ["gid", "mode", "relativePath", "type", "uid"]) ||
      entry.type !== "directory" ||
      (index === 0
        ? entry.relativePath !== "."
        : !safeRelativePath(entry.relativePath)) ||
      !validMode(entry.mode) ||
      !ownerValue(entry.uid) ||
      !ownerValue(entry.gid) ||
      (index > 0 && value.directories[index - 1].relativePath >= entry.relativePath)
    ) {
      reject("manifest_invalid");
    }
    directories.add(entry.relativePath);
  }
  const files = new Set();
  let totalBytes = 0;
  for (const [index, entry] of value.files.entries()) {
    if (
      !exactKeys(entry, [
        "gid",
        "mode",
        "relativePath",
        "sha256",
        "size",
        "type",
        "uid",
      ]) ||
      entry.type !== "file" ||
      !safeRelativePath(entry.relativePath) ||
      !validMode(entry.mode) ||
      !ownerValue(entry.uid) ||
      !ownerValue(entry.gid) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !SHA256.test(entry.sha256) ||
      (index > 0 && value.files[index - 1].relativePath >= entry.relativePath) ||
      directories.has(entry.relativePath)
    ) {
      reject("manifest_invalid");
    }
    const parent = entry.relativePath.includes("/")
      ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf("/"))
      : ".";
    if (!directories.has(parent)) reject("manifest_invalid");
    files.add(entry.relativePath);
    totalBytes = safeAdd(totalBytes, entry.size);
  }
  for (const entry of value.directories.slice(1)) {
    const parent = entry.relativePath.includes("/")
      ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf("/"))
      : ".";
    if (!directories.has(parent) || files.has(entry.relativePath))
      reject("manifest_invalid");
  }
  if (totalBytes !== value.totals.bytes) reject("manifest_invalid");
  const treeHash = sha256(
    canonicalJson({
      directories: value.directories,
      files: value.files,
      version: FORMAT_VERSION,
    }),
  );
  if (treeHash !== value.sourceTreeSha256) reject("manifest_invalid");
  return value;
}

function parseManifest(snapshotRoot) {
  const manifestFile = readRegular(
    join(snapshotRoot, "manifest.json"),
    MAX_MANIFEST_BYTES,
  );
  const raw = strictUtf8(manifestFile.bytes, "manifest_invalid");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    reject("manifest_invalid");
  }
  const manifest = validateManifest(value, raw);
  const digest = sha256(manifestFile.bytes);
  const checksumFile = readRegular(join(snapshotRoot, "manifest.sha256"), 65);
  const completeFile = readRegular(join(snapshotRoot, "COMPLETE"), 80);
  const checksum = strictUtf8(checksumFile.bytes, "snapshot_incomplete");
  const complete = strictUtf8(completeFile.bytes, "snapshot_incomplete");
  if (checksum !== `${digest}\n` || complete !== `forensic-v1 ${digest}\n`) {
    reject("snapshot_incomplete");
  }
  return {
    digest,
    manifest,
    controlStats: [manifestFile.stat, checksumFile.stat, completeFile.stat],
  };
}

function verifyOwnerAndMode(stat, owner, expectedMode, type) {
  if (
    (type === "directory" ? !stat.isDirectory() : !stat.isFile()) ||
    stat.isSymbolicLink() ||
    (type === "file" && stat.nlink !== 1n) ||
    mode(stat) !== expectedMode ||
    stat.uid !== BigInt(owner.uid) ||
    stat.gid !== BigInt(owner.gid)
  ) {
    reject("snapshot_invalid");
  }
}

function verifyData(snapshotRoot, manifest, snapshotDevice) {
  const owner = manifest.artifactOwner;
  const dataRoot = join(snapshotRoot, "data");
  const rootStat = lstatSync(dataRoot, { bigint: true });
  if (rootStat.dev !== snapshotDevice) reject("snapshot_invalid");
  verifyOwnerAndMode(rootStat, owner, SNAPSHOT_DIRECTORY_MODE, "directory");
  const rootDevice = rootStat.dev;
  const expectedDirectories = new Map(
    manifest.directories.map((entry) => [entry.relativePath, entry]),
  );
  const expectedFiles = new Map(
    manifest.files.map((entry) => [entry.relativePath, entry]),
  );
  const actualDirectories = new Set();
  const actualFiles = new Set();
  let totalBytes = 0;

  function walk(path, relativePath, depth) {
    if (depth > MAX_DEPTH) reject("snapshot_limit");
    const before = lstatSync(path, { bigint: true });
    if (before.dev !== rootDevice) reject("snapshot_invalid");
    verifyOwnerAndMode(before, owner, SNAPSHOT_DIRECTORY_MODE, "directory");
    const opened = openDirectory(path);
    try {
      if (!sameIdentity(volatileIdentity(before), volatileIdentity(opened.stat)))
        reject("snapshot_changed");
      actualDirectories.add(relativePath);
      const namesBefore = readNames(path);
      for (const nameBuffer of namesBefore) {
        const name = nameBuffer.toString("utf8");
        const child = join(path, name);
        const childRelative = relativePath === "." ? name : `${relativePath}/${name}`;
        const childStat = lstatSync(child, { bigint: true });
        if (childStat.dev !== rootDevice || childStat.isSymbolicLink())
          reject("snapshot_invalid");
        if (childStat.isDirectory()) {
          if (!expectedDirectories.has(childRelative)) reject("snapshot_extra_entry");
          walk(child, childRelative, depth + 1);
        } else if (childStat.isFile()) {
          verifyOwnerAndMode(childStat, owner, SNAPSHOT_FILE_MODE, "file");
          const file = expectedFiles.get(childRelative);
          if (!file) reject("snapshot_extra_entry");
          if (childStat.size !== BigInt(file.size)) reject("snapshot_data_mismatch");
          const openedFile = openSync(child, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const openedStat = fstatSync(openedFile, { bigint: true });
            if (!sameIdentity(volatileIdentity(childStat), volatileIdentity(openedStat)))
              reject("snapshot_changed");
            const hash = createHash("sha256");
            const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
            let total = 0;
            while (true) {
              const length = readSync(openedFile, buffer, 0, buffer.length, null);
              if (length === 0) break;
              total = safeAdd(total, length);
              if (total > file.size) reject("snapshot_data_mismatch");
              hash.update(buffer.subarray(0, length));
            }
            const after = fstatSync(openedFile, { bigint: true });
            const afterPath = lstatSync(child, { bigint: true });
            if (
              total !== file.size ||
              hash.digest("hex") !== file.sha256 ||
              !sameIdentity(volatileIdentity(openedStat), volatileIdentity(after)) ||
              !sameIdentity(volatileIdentity(openedStat), volatileIdentity(afterPath))
            ) {
              reject("snapshot_data_mismatch");
            }
            totalBytes = safeAdd(totalBytes, total);
            actualFiles.add(childRelative);
          } finally {
            closeSync(openedFile);
          }
        } else {
          reject("snapshot_invalid");
        }
      }
      const namesAfter = readNames(path);
      const after = fstatSync(opened.fd, { bigint: true });
      const afterPath = lstatSync(path, { bigint: true });
      if (
        !sameNames(namesBefore, namesAfter) ||
        !sameIdentity(volatileIdentity(opened.stat), volatileIdentity(after)) ||
        !sameIdentity(volatileIdentity(opened.stat), volatileIdentity(afterPath))
      ) {
        reject("snapshot_changed");
      }
    } finally {
      closeSync(opened.fd);
    }
  }

  walk(dataRoot, ".", 0);
  if (
    actualDirectories.size !== expectedDirectories.size ||
    actualFiles.size !== expectedFiles.size ||
    totalBytes !== manifest.totals.bytes
  ) {
    reject("snapshot_data_mismatch");
  }
}

function verifySnapshot(snapshotRoot, expectedDigest = null) {
  const rootContext = existingDirectory(snapshotRoot, "snapshot_invalid");
  const rootBefore = lstatSync(snapshotRoot, { bigint: true });
  const namesBefore = readdirSync(snapshotRoot).sort(compareText);
  if (canonicalJson(namesBefore) !== canonicalJson(CONTROL_NAMES))
    reject("snapshot_extra_entry");
  const { digest, manifest, controlStats } = parseManifest(snapshotRoot);
  if (expectedDigest !== null && digest !== expectedDigest)
    reject("manifest_digest_mismatch");
  verifyOwnerAndMode(
    rootBefore,
    manifest.artifactOwner,
    SNAPSHOT_DIRECTORY_MODE,
    "directory",
  );
  for (const stat of controlStats) {
    if (stat.dev !== rootBefore.dev) reject("snapshot_invalid");
    verifyOwnerAndMode(stat, manifest.artifactOwner, SNAPSHOT_FILE_MODE, "file");
  }
  verifyData(snapshotRoot, manifest, rootBefore.dev);
  const namesAfter = readdirSync(snapshotRoot).sort(compareText);
  const rootAfter = lstatSync(snapshotRoot, { bigint: true });
  if (
    canonicalJson(namesBefore) !== canonicalJson(namesAfter) ||
    !sameIdentity(volatileIdentity(rootBefore), volatileIdentity(rootAfter))
  ) {
    reject("snapshot_changed");
  }
  assertSameAncestors(snapshotRoot, rootContext.ancestors, "snapshot_changed");
  return {
    operation: "verify",
    version: FORMAT_VERSION,
    files: manifest.totals.files,
    directories: manifest.totals.directories,
    bytes: manifest.totals.bytes,
    treeSha256: manifest.sourceTreeSha256,
    manifestSha256: digest,
  };
}

function finalizeDirectories(dataRoot, directories, owner) {
  const paths = directories
    .filter((entry) => entry.relativePath !== ".")
    .map((entry) => join(dataRoot, ...entry.relativePath.split("/")))
    .sort((left, right) => right.split(sep).length - left.split(sep).length);
  for (const path of paths) setDirectory(path, owner, SNAPSHOT_DIRECTORY_MODE);
  setDirectory(dataRoot, owner, SNAPSHOT_DIRECTORY_MODE);
}

function makeWritable(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, STAGING_DIRECTORY_MODE);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  } else if (stat.isFile()) {
    chmodSync(path, 0o600);
  }
}

function cleanupPartial(path, parent, expectedAncestors, expectedIdentity) {
  try {
    assertSameAncestors(parent, expectedAncestors, "cleanup_failed");
    const before = lstatSync(path, { bigint: true });
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      before.dev !== expectedIdentity.dev ||
      before.ino !== expectedIdentity.ino
    ) {
      reject("cleanup_failed");
    }
    const opened = openDirectory(path);
    try {
      if (
        opened.stat.dev !== expectedIdentity.dev ||
        opened.stat.ino !== expectedIdentity.ino
      ) {
        reject("cleanup_failed");
      }
    } finally {
      closeSync(opened.fd);
    }
    makeWritable(path);
    rmSync(path, { force: true, recursive: true });
  } catch {
    reject("cleanup_failed");
  }
}

function createSnapshot(sourceRoot, snapshotRoot, owner) {
  const targetParent = dirname(snapshotRoot);
  const targetContext = trustedTargetParent(targetParent);
  assertMissing(snapshotRoot, "target_exists");
  const pre = scanTree(sourceRoot);
  assertSameAncestors(targetParent, targetContext.ancestors);
  assertMissing(snapshotRoot, "target_exists");
  const partial = join(
    targetParent,
    `.${basename(snapshotRoot)}.partial-${randomUUID()}`,
  );
  let partialCreated = false;
  let partialIdentity = null;
  let published = false;
  try {
    mkdirSync(partial, { recursive: false, mode: STAGING_DIRECTORY_MODE });
    partialCreated = true;
    partialIdentity = lstatSync(partial, { bigint: true });
    setDirectory(partial, owner, STAGING_DIRECTORY_MODE);
    const dataRoot = join(partial, "data");
    createDirectory(dataRoot, owner);
    for (const directory of pre.directories.filter(
      (entry) => entry.relativePath !== ".",
    )) {
      createDirectory(join(dataRoot, ...directory.relativePath.split("/")), owner);
    }
    for (const file of pre.files) {
      copyExactFile(
        sourceRoot,
        dataRoot,
        file,
        pre.identities.get(file.relativePath),
        owner,
      );
    }
    const post = scanTree(sourceRoot);
    if (!sameScan(pre, post)) reject("tree_changed");
    finalizeDirectories(dataRoot, pre.directories, owner);
    const manifest = {
      version: FORMAT_VERSION,
      artifactOwner: owner,
      createdAt: new Date().toISOString(),
      directories: pre.directories,
      files: pre.files,
      sourceTreeSha256: pre.sourceTreeSha256,
      totals: pre.totals,
    };
    const manifestBody = canonicalJson(manifest);
    if (Buffer.byteLength(manifestBody, "utf8") > MAX_MANIFEST_BYTES)
      reject("snapshot_limit");
    const manifestDigest = sha256(manifestBody);
    writeExclusive(join(partial, "manifest.json"), manifestBody, owner);
    writeExclusive(join(partial, "manifest.sha256"), `${manifestDigest}\n`, owner);
    writeExclusive(join(partial, "COMPLETE"), `forensic-v1 ${manifestDigest}\n`, owner);
    syncDirectory(partial);
    setDirectory(partial, owner, SNAPSHOT_DIRECTORY_MODE);
    verifySnapshot(partial, manifestDigest);
    assertSameAncestors(targetParent, targetContext.ancestors);
    assertMissing(snapshotRoot, "target_exists");
    syncDirectory(targetParent);
    renameSync(partial, snapshotRoot);
    published = true;
    syncDirectory(targetParent);
    const verified = verifySnapshot(snapshotRoot, manifestDigest);
    return { ...verified, operation: "create" };
  } finally {
    if (partialCreated && !published) {
      cleanupPartial(partial, targetParent, targetContext.ancestors, partialIdentity);
    }
  }
}

function createArguments(argv) {
  if (argv.length < 3 || argv[0] !== "create") reject("invalid_arguments");
  const flags = parseFlags(argv.slice(3), new Set(["--owner-gid", "--owner-uid"]), [
    "--owner-uid",
    "--owner-gid",
  ]);
  const owner = {
    uid: parseOwner(flags.get("--owner-uid")),
    gid: parseOwner(flags.get("--owner-gid")),
  };
  const source = lexicalPath(argv[1]);
  const snapshot = lexicalPath(argv[2]);
  if (snapshot === source || snapshot.startsWith(`${source}${sep}`))
    reject("unsafe_path");
  return { owner, snapshot, source };
}

function verifyArguments(argv) {
  if (argv.length < 2 || argv[0] !== "verify") reject("invalid_arguments");
  const flags = parseFlags(argv.slice(2), new Set(["--manifest-sha256"]), []);
  const expectedDigest = flags.has("--manifest-sha256")
    ? parseDigest(flags.get("--manifest-sha256"))
    : null;
  return { expectedDigest, snapshot: lexicalPath(argv[1]) };
}

function main(argv) {
  if (argv[0] === "create") {
    const { owner, snapshot, source } = createArguments(argv);
    process.stdout.write(`${JSON.stringify(createSnapshot(source, snapshot, owner))}\n`);
    return;
  }
  if (argv[0] === "verify") {
    const { expectedDigest, snapshot } = verifyArguments(argv);
    process.stdout.write(`${JSON.stringify(verifySnapshot(snapshot, expectedDigest))}\n`);
    return;
  }
  reject("invalid_arguments");
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const code = error instanceof ForensicError ? error.code : "filesystem_error";
  process.stderr.write(`Hub state forensic snapshot failed: ${code}\n`);
  process.exitCode = 1;
}
