#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

const COPY_BUFFER_BYTES = 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_ENTRIES = 100_000;
const MAX_PATH_BYTES = 4_096;

class TreeDigestError extends Error {
  constructor(code) {
    super(code);
    this.name = "TreeDigestError";
    this.code = code;
  }
}

function reject(code) {
  throw new TreeDigestError(code);
}

function compareBuffers(left, right) {
  return Buffer.compare(left, right);
}

function stableNodeIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid];
}

function volatileNodeIdentity(stat) {
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

function statIdentity(stat) {
  return volatileNodeIdentity(stat)
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

function ancestorPaths(root) {
  const filesystemRoot = parse(root).root;
  const result = [filesystemRoot];
  let current = filesystemRoot;
  for (const component of root.slice(filesystemRoot.length).split(sep)) {
    if (component.length === 0) continue;
    current = join(current, component);
    result.push(current);
  }
  return result;
}

function captureAncestorIdentity(root) {
  const result = [];
  const paths = ancestorPaths(root);
  for (const [index, path] of paths.entries()) {
    const before = lstatSync(path, { bigint: true });
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      realpathSync.native(path) !== path
    ) {
      reject("unsafe_ancestor");
    }
    const opened = openDirectory(path);
    try {
      if (!sameIdentity(stableNodeIdentity(before), stableNodeIdentity(opened.stat))) {
        reject("tree_changed");
      }
      result.push(
        index >= paths.length - 2
          ? volatileNodeIdentity(opened.stat)
          : stableNodeIdentity(opened.stat),
      );
    } finally {
      closeSync(opened.fd);
    }
  }
  return result;
}

function sameAncestorIdentity(left, right) {
  return (
    left.length === right.length &&
    left.every((identity, index) => sameIdentity(identity, right[index]))
  );
}

function canonicalRoot(value) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === parse(value).root
  ) {
    reject("unsafe_root");
  }
  const ancestors = captureAncestorIdentity(value);
  if (realpathSync.native(value) !== value) reject("unsafe_root");
  return { ancestors, root: value };
}

function safeName(buffer) {
  if (buffer.length === 0 || buffer.length > 255) reject("unsafe_tree");
  const name = buffer.toString("utf8");
  if (
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    !Buffer.from(name, "utf8").equals(buffer)
  ) {
    reject("unsafe_tree");
  }
  return name;
}

function safeRelativePath(parent, name) {
  const path = parent.length === 0 ? name : `${parent}/${name}`;
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) reject("tree_limit");
  return path;
}

function mode(stat) {
  return Number(stat.mode & 0o7777n);
}

function sizeAsNumber(stat) {
  if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    reject("tree_limit");
  }
  return Number(stat.size);
}

function updateFrame(hash, type, path, stat, size, canonicalOwner) {
  const frame = Buffer.from(
    JSON.stringify([
      type,
      path,
      mode(stat),
      canonicalOwner?.uid ?? stat.uid.toString(),
      canonicalOwner?.gid ?? stat.gid.toString(),
      size,
    ]),
    "utf8",
  );
  hash.update(Buffer.from(`${frame.length}:`, "ascii"));
  hash.update(frame);
}

function safeAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < left) reject("tree_limit");
  return result;
}

function readNames(directory) {
  const names = readdirSync(directory, { encoding: "buffer" }).sort(compareBuffers);
  for (const name of names) safeName(name);
  return names;
}

function sameNames(left, right) {
  return (
    left.length === right.length && left.every((name, index) => name.equals(right[index]))
  );
}

function digestPass(root, expectedRootIdentity, canonicalOwner) {
  const hash = createHash("sha256");
  const identities = new Map();
  const rootStat = lstatSync(root, { bigint: true });
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !sameIdentity(volatileNodeIdentity(rootStat), expectedRootIdentity)
  ) {
    reject("tree_changed");
  }
  const rootDevice = rootStat.dev;
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;

  function recordIdentity(path, stat) {
    const identity = statIdentity(stat);
    if (identities.has(path)) reject("unsafe_tree");
    identities.set(path, identity);
  }

  function hashFile(path, relativePath, before) {
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
        !sameIdentity(volatileNodeIdentity(before), volatileNodeIdentity(opened))
      ) {
        reject("tree_changed");
      }
      const expectedSize = sizeAsNumber(opened);
      updateFrame(hash, "file", relativePath, opened, expectedSize, canonicalOwner);
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let readBytes = 0;
      while (true) {
        const length = readSync(fd, buffer, 0, buffer.length, null);
        if (length === 0) break;
        readBytes = safeAdd(readBytes, length);
        if (readBytes > expectedSize) reject("tree_changed");
        hash.update(buffer.subarray(0, length));
      }
      const after = fstatSync(fd, { bigint: true });
      const afterPath = lstatSync(path, { bigint: true });
      if (
        readBytes !== expectedSize ||
        !sameIdentity(volatileNodeIdentity(opened), volatileNodeIdentity(after)) ||
        !sameIdentity(volatileNodeIdentity(opened), volatileNodeIdentity(afterPath))
      ) {
        reject("tree_changed");
      }
      recordIdentity(relativePath, opened);
      fileCount = safeAdd(fileCount, 1);
      totalBytes = safeAdd(totalBytes, expectedSize);
    } finally {
      closeSync(fd);
    }
  }

  function walk(directory, relativePath, expected, depth) {
    if (depth > MAX_DEPTH) reject("tree_limit");
    const before = lstatSync(directory, { bigint: true });
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      before.dev !== rootDevice ||
      !sameIdentity(volatileNodeIdentity(before), volatileNodeIdentity(expected))
    ) {
      reject("tree_changed");
    }
    const opened = openDirectory(directory);
    try {
      if (
        !sameIdentity(volatileNodeIdentity(before), volatileNodeIdentity(opened.stat))
      ) {
        reject("tree_changed");
      }
      updateFrame(hash, "directory", relativePath, opened.stat, 0, canonicalOwner);
      recordIdentity(relativePath, opened.stat);
      const namesBefore = readNames(directory);
      for (const nameBuffer of namesBefore) {
        entryCount = safeAdd(entryCount, 1);
        if (entryCount > MAX_ENTRIES) reject("tree_limit");
        const name = safeName(nameBuffer);
        const child = join(directory, name);
        const childRelativePath = safeRelativePath(relativePath, name);
        const childStat = lstatSync(child, { bigint: true });
        if (childStat.isSymbolicLink() || childStat.dev !== rootDevice) {
          reject("unsafe_tree");
        }
        if (childStat.isDirectory()) {
          walk(child, childRelativePath, childStat, depth + 1);
        } else if (childStat.isFile()) {
          hashFile(child, childRelativePath, childStat);
        } else {
          reject("unsafe_tree");
        }
      }
      const namesAfter = readNames(directory);
      const after = fstatSync(opened.fd, { bigint: true });
      const afterPath = lstatSync(directory, { bigint: true });
      if (
        !sameNames(namesBefore, namesAfter) ||
        !sameIdentity(volatileNodeIdentity(opened.stat), volatileNodeIdentity(after)) ||
        !sameIdentity(volatileNodeIdentity(opened.stat), volatileNodeIdentity(afterPath))
      ) {
        reject("tree_changed");
      }
    } finally {
      closeSync(opened.fd);
    }
  }

  walk(root, "", rootStat, 0);
  return {
    entryCount,
    fileCount,
    identities,
    totalBytes,
    treeSha256: hash.digest("hex"),
  };
}

function samePass(left, right) {
  if (
    left.entryCount !== right.entryCount ||
    left.fileCount !== right.fileCount ||
    left.totalBytes !== right.totalBytes ||
    left.treeSha256 !== right.treeSha256 ||
    left.identities.size !== right.identities.size
  ) {
    return false;
  }
  for (const [path, identity] of left.identities) {
    if (right.identities.get(path) !== identity) return false;
  }
  return true;
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] !== "--canonical-root-owner") {
    return { canonicalOwner: null, root: argv[0] };
  }
  if (argv.length === 2 && argv[0] === "--canonical-root-owner") {
    return { canonicalOwner: { gid: "0", uid: "0" }, root: argv[1] };
  }
  reject("invalid_arguments");
}

function main(argv) {
  const { canonicalOwner, root: rootArgument } = parseArguments(argv);
  const { ancestors, root } = canonicalRoot(rootArgument);
  const rootIdentity = volatileNodeIdentity(lstatSync(root, { bigint: true }));
  const first = digestPass(root, rootIdentity, canonicalOwner);
  const middleAncestors = captureAncestorIdentity(root);
  if (!sameAncestorIdentity(ancestors, middleAncestors)) reject("tree_changed");
  const second = digestPass(root, rootIdentity, canonicalOwner);
  const finalAncestors = captureAncestorIdentity(root);
  if (!sameAncestorIdentity(ancestors, finalAncestors) || !samePass(first, second)) {
    reject("tree_changed");
  }
  process.stdout.write(
    `${JSON.stringify({
      entryCount: first.entryCount,
      fileCount: first.fileCount,
      totalBytes: first.totalBytes,
      treeSha256: first.treeSha256,
    })}\n`,
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const code = error instanceof TreeDigestError ? error.code : "filesystem_error";
  process.stderr.write(`tree digest failed: ${code}\n`);
  process.exitCode = 1;
}
