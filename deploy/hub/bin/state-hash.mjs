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
import { relative, resolve, sep } from "node:path";

function reject(message) {
  throw new Error(message);
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

function frame(hash, kind, path, stat) {
  hash.update(
    `${kind}\0${Buffer.byteLength(path)}\0${path}\0${stat.mode}\0${stat.uid}\0${stat.gid}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0`,
  );
}

function hashFile(hash, root, path, before) {
  const name = relative(root, path).split(sep).join("/");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(before, opened)) {
      reject("state file changed before it could be hashed");
    }
    frame(hash, "file", name, opened);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let length;
    let total = 0n;
    while (true) {
      length = readSync(fd, buffer, 0, buffer.length, null);
      if (length === 0) break;
      total += BigInt(length);
      if (total > opened.size) reject("state file grew while it was hashed");
      hash.update(buffer.subarray(0, length));
    }
    const after = fstatSync(fd, { bigint: true });
    if (total !== opened.size || !sameIdentity(opened, after)) {
      reject("state file changed while it was hashed");
    }
  } finally {
    closeSync(fd);
  }
}

function walk(hash, root, directory) {
  const beforeDirectory = lstatSync(directory, { bigint: true });
  if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink()) {
    reject("state hash refuses non-directory traversal");
  }
  const relativeDirectory = relative(root, directory).split(sep).join("/");
  frame(hash, "directory", relativeDirectory, beforeDirectory);
  for (const name of readdirSync(directory).sort()) {
    const path = resolve(directory, name);
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) reject("state hash refuses symbolic links");
    if (stat.isDirectory()) {
      walk(hash, root, path);
    } else if (stat.isFile() && stat.nlink === 1n) {
      hashFile(hash, root, path, stat);
    } else {
      reject("state hash refuses special or multiply-linked files");
    }
  }
  const afterDirectory = lstatSync(directory, { bigint: true });
  if (!sameIdentity(beforeDirectory, afterDirectory)) {
    reject("state directory changed while it was hashed");
  }
}

function main(argv) {
  if (argv.length !== 1) reject("usage: state-hash.mjs STATE_ROOT");
  const unresolvedRoot = resolve(argv[0]);
  const rootStat = lstatSync(unresolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    reject("state root must be a real directory");
  }
  const root = realpathSync(unresolvedRoot);
  if (root !== unresolvedRoot) reject("state root contains a symbolic link");
  const hashes = [];
  for (let pass = 0; pass < 2; pass += 1) {
    const hash = createHash("sha256");
    walk(hash, root, root);
    hashes.push(hash.digest("hex"));
  }
  if (hashes[0] !== hashes[1]) {
    reject("state tree changed between verification passes");
  }
  process.stdout.write(`${hashes[0]}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `Hub state hash failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}
