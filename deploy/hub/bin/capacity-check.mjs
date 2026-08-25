#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const MIN_RESERVE_BYTES = 1024n * 1024n * 1024n;
export const MIN_RESERVE_INODES = 1024n;

const MAX_UNSIGNED_64 = (1n << 64n) - 1n;
const TEST_MARKER_NAME = ".agent-os-deploy-test-root";
const TEST_STATFS_MAX_BYTES = 16 * 1024;
const ROLE_ORDER = Object.freeze(["state", "backup"]);

function reject(message) {
  throw new Error(message);
}

function assertUnsigned(value, label, { positive = false } = {}) {
  if (
    typeof value !== "bigint" ||
    value < (positive ? 1n : 0n) ||
    value > MAX_UNSIGNED_64
  ) {
    reject(`${label} is outside the supported range`);
  }
  return value;
}

function normalizeSample(sample, role) {
  if (sample === null || typeof sample !== "object" || Array.isArray(sample)) {
    reject(`${role} filesystem statistics are invalid`);
  }
  const device = sample.device;
  if (typeof device !== "string" || !/^(0|[1-9][0-9]*)$/u.test(device)) {
    reject(`${role} filesystem device is invalid`);
  }
  const bavail = assertUnsigned(sample.bavail, `${role} available block count`);
  const bsize = assertUnsigned(sample.bsize, `${role} block size`, {
    positive: true,
  });
  const ffree = assertUnsigned(sample.ffree, `${role} free inode count`);
  return Object.freeze({
    availableBytes: bavail * bsize,
    availableInodes: ffree,
    device,
    role,
  });
}

export function evaluateCapacity({
  state,
  backup,
  requiredBytes = 0n,
  requiredInodes = 0n,
  requiredStateBytes = 0n,
  requiredStateInodes = 0n,
}) {
  const snapshotBytes = assertUnsigned(requiredBytes, "required byte count");
  const snapshotInodes = assertUnsigned(requiredInodes, "required inode count");
  const stateBytes = assertUnsigned(requiredStateBytes, "required state byte count");
  const stateInodes = assertUnsigned(requiredStateInodes, "required state inode count");
  const samples = [normalizeSample(state, "state"), normalizeSample(backup, "backup")];
  const byDevice = new Map();

  for (const sample of samples) {
    const existing = byDevice.get(sample.device);
    if (existing) {
      existing.roles.push(sample.role);
      if (sample.availableBytes < existing.availableBytes) {
        existing.availableBytes = sample.availableBytes;
      }
      if (sample.availableInodes < existing.availableInodes) {
        existing.availableInodes = sample.availableInodes;
      }
      if (sample.role === "backup") {
        existing.requiredBytes += snapshotBytes;
        existing.requiredInodes += snapshotInodes;
      } else {
        existing.requiredBytes += stateBytes;
        existing.requiredInodes += stateInodes;
      }
      continue;
    }
    byDevice.set(sample.device, {
      availableBytes: sample.availableBytes,
      availableInodes: sample.availableInodes,
      requiredBytes:
        MIN_RESERVE_BYTES + (sample.role === "backup" ? snapshotBytes : stateBytes),
      requiredInodes:
        MIN_RESERVE_INODES + (sample.role === "backup" ? snapshotInodes : stateInodes),
      roles: [sample.role],
    });
  }

  const filesystems = [...byDevice.values()].map((filesystem) => {
    filesystem.roles.sort(
      (left, right) => ROLE_ORDER.indexOf(left) - ROLE_ORDER.indexOf(right),
    );
    return Object.freeze({
      ...filesystem,
      roles: Object.freeze(filesystem.roles),
      sufficient:
        filesystem.availableBytes >= filesystem.requiredBytes &&
        filesystem.availableInodes >= filesystem.requiredInodes,
    });
  });
  return Object.freeze({
    filesystems: Object.freeze(filesystems),
    ok: filesystems.every((filesystem) => filesystem.sufficient),
  });
}

export function serializeCapacity(result) {
  return JSON.stringify({
    ok: result.ok,
    filesystemCount: result.filesystems.length,
    filesystems: result.filesystems.map((filesystem) => ({
      roles: filesystem.roles,
      availableBytes: filesystem.availableBytes.toString(),
      requiredBytes: filesystem.requiredBytes.toString(),
      availableInodes: filesystem.availableInodes.toString(),
      requiredInodes: filesystem.requiredInodes.toString(),
      sufficient: filesystem.sufficient,
    })),
  });
}

function parseUnsignedDecimal(raw, label) {
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]{0,19})$/u.test(raw)) {
    reject(`${label} must be a canonical unsigned decimal`);
  }
  return assertUnsigned(BigInt(raw), label);
}

function parseArguments(argv) {
  const allowed = new Set([
    "--state",
    "--backup",
    "--required-bytes",
    "--required-inodes",
    "--required-state-bytes",
    "--required-state-inodes",
    "--test-statfs-json",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || values.has(name)) {
      reject(
        "usage: capacity-check.mjs --state PATH --backup PATH [--required-bytes N] [--required-inodes N] [--required-state-bytes N] [--required-state-inodes N]",
      );
    }
    values.set(name, value);
  }
  if (!values.has("--state") || !values.has("--backup")) {
    reject(
      "usage: capacity-check.mjs --state PATH --backup PATH [--required-bytes N] [--required-inodes N] [--required-state-bytes N] [--required-state-inodes N]",
    );
  }
  return Object.freeze({
    backup: values.get("--backup"),
    requiredBytes: parseUnsignedDecimal(
      values.get("--required-bytes") ?? "0",
      "required byte count",
    ),
    requiredInodes: parseUnsignedDecimal(
      values.get("--required-inodes") ?? "0",
      "required inode count",
    ),
    requiredStateBytes: parseUnsignedDecimal(
      values.get("--required-state-bytes") ?? "0",
      "required state byte count",
    ),
    requiredStateInodes: parseUnsignedDecimal(
      values.get("--required-state-inodes") ?? "0",
      "required state inode count",
    ),
    state: values.get("--state"),
    testStatfsJson: values.get("--test-statfs-json") ?? null,
  });
}

function inspectDirectory(path, role) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.includes("\n") ||
    path.includes("\0") ||
    resolve(path) !== path
  ) {
    reject(`${role} directory must be a canonical absolute path`);
  }
  let stat;
  let canonical;
  try {
    stat = lstatSync(path, { bigint: true });
    canonical = realpathSync(path);
  } catch {
    reject(`${role} directory is not readable`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== path) {
    reject(`${role} directory must be a canonical real directory`);
  }
  return Object.freeze({ dev: stat.dev, ino: stat.ino, path });
}

function assertDirectoryUnchanged(directory, role) {
  let stat;
  try {
    stat = lstatSync(directory.path, { bigint: true });
  } catch {
    reject(`${role} directory changed during inspection`);
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== directory.dev ||
    stat.ino !== directory.ino
  ) {
    reject(`${role} directory changed during inspection`);
  }
}

function realStatfs(directory, role) {
  let statfs;
  try {
    statfs = statfsSync(directory.path, { bigint: true });
  } catch {
    reject(`${role} filesystem statistics are unavailable`);
  }
  assertDirectoryUnchanged(directory, role);
  return {
    bavail: statfs.bavail,
    bsize: statfs.bsize,
    device: directory.dev.toString(),
    ffree: statfs.ffree,
  };
}

function testRoot() {
  const requested = process.env.AGENT_OS_DEPLOY_TEST_ROOT ?? "";
  if (process.env.AGENT_OS_DEPLOY_TEST_MODE !== "1") {
    reject("test filesystem injection requires deploy test mode");
  }
  if (
    !isAbsolute(requested) ||
    requested === "/" ||
    requested.includes("//") ||
    requested.includes("\n") ||
    resolve(requested) !== requested
  ) {
    reject("deploy test root is not canonical");
  }
  let rootStat;
  let canonical;
  try {
    rootStat = lstatSync(requested);
    canonical = realpathSync(requested);
  } catch {
    reject("deploy test root is not readable");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || canonical !== requested) {
    reject("deploy test root must be a canonical real directory");
  }

  const nonce = process.env.AGENT_OS_DEPLOY_TEST_NONCE ?? "";
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(nonce)) {
    reject("deploy test root nonce is missing or invalid");
  }
  const markerPath = resolve(requested, TEST_MARKER_NAME);
  let markerStat;
  let marker;
  try {
    markerStat = lstatSync(markerPath);
    marker = readFileSync(markerPath, "utf8");
  } catch {
    reject("deploy test root marker is missing or invalid");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    (markerStat.mode & 0o777) !== 0o600 ||
    (currentUid !== null && markerStat.uid !== currentUid) ||
    marker !== nonce
  ) {
    reject("deploy test root marker is missing or invalid");
  }
  return requested;
}

function assertInsideTestRoot(path, root, role) {
  const offset = relative(root, path);
  if (offset === "" || offset === ".." || offset.startsWith(`..${sep}`)) {
    reject(`${role} directory is outside the deploy test root`);
  }
}

function parseInjectedSample(value, role) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject("test filesystem statistics are invalid");
  }
  const expected = ["bavail", "bsize", "dev", "ffree"];
  if (
    Object.keys(value).sort().join("\0") !== expected.join("\0") ||
    expected.some((name) => typeof value[name] !== "string")
  ) {
    reject("test filesystem statistics are invalid");
  }
  return {
    bavail: parseUnsignedDecimal(value.bavail, `${role} available block count`),
    bsize: (() => {
      const size = parseUnsignedDecimal(value.bsize, `${role} block size`);
      if (size === 0n) reject(`${role} block size is outside the supported range`);
      return size;
    })(),
    device: parseUnsignedDecimal(value.dev, `${role} filesystem device`).toString(),
    ffree: parseUnsignedDecimal(value.ffree, `${role} free inode count`),
  };
}

function injectedStatfs(raw, directories) {
  if (Buffer.byteLength(raw) > TEST_STATFS_MAX_BYTES) {
    reject("test filesystem statistics are invalid");
  }
  const root = testRoot();
  assertInsideTestRoot(directories.state.path, root, "state");
  assertInsideTestRoot(directories.backup.path, root, "backup");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reject("test filesystem statistics are invalid");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join("\0") !== "backup\0state"
  ) {
    reject("test filesystem statistics are invalid");
  }
  const samples = {
    backup: parseInjectedSample(parsed.backup, "backup"),
    state: parseInjectedSample(parsed.state, "state"),
  };
  assertDirectoryUnchanged(directories.state, "state");
  assertDirectoryUnchanged(directories.backup, "backup");
  return samples;
}

export function runCapacityCheck(argv) {
  const args = parseArguments(argv);
  const directories = {
    state: inspectDirectory(args.state, "state"),
    backup: inspectDirectory(args.backup, "backup"),
  };
  const samples =
    args.testStatfsJson === null
      ? {
          state: realStatfs(directories.state, "state"),
          backup: realStatfs(directories.backup, "backup"),
        }
      : injectedStatfs(args.testStatfsJson, directories);
  return evaluateCapacity({
    ...samples,
    requiredBytes: args.requiredBytes,
    requiredInodes: args.requiredInodes,
    requiredStateBytes: args.requiredStateBytes,
    requiredStateInodes: args.requiredStateInodes,
  });
}

function main() {
  try {
    const result = runCapacityCheck(process.argv.slice(2));
    process.stdout.write(`${serializeCapacity(result)}\n`);
    if (!result.ok) {
      process.stderr.write(
        "Hub capacity check failed: insufficient filesystem capacity\n",
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `Hub capacity check failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) main();
