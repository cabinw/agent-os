#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

function parseManifest(argv) {
  const separator = argv.indexOf("--runtime");
  if (separator < 1) throw new Error("invalid_manifest");
  const adminFiles = argv.slice(0, separator);
  const runtimeFiles = argv.slice(separator + 1).map((spec) => {
    const fields = spec.split("|");
    if (fields.length !== 4) throw new Error("invalid_manifest");
    return [fields[1], fields[3]];
  });
  if (adminFiles.length !== 25 || runtimeFiles.length !== 5) {
    throw new Error("invalid_manifest");
  }
  const byteSort = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
  adminFiles.sort(byteSort);
  runtimeFiles.sort((left, right) => byteSort(left[1], right[1]));
  return { adminFiles, runtimeFiles };
}

function frame(hash, type, path, mode, uid, gid, size) {
  const value = Buffer.from(JSON.stringify([type, path, mode, uid, gid, size]));
  hash.update(Buffer.from(`${value.length}:`, "ascii"));
  hash.update(value);
}

function readStable(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw new Error("unsafe_source");
    }
    const chunks = [];
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      size += count;
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(size) !== before.size
    ) {
      throw new Error("source_changed");
    }
    return { bytes: Buffer.concat(chunks), size };
  } finally {
    closeSync(fd);
  }
}

function digestAdmin(root, adminFiles) {
  const hash = createHash("sha256");
  const directories = ["", "bin", "nginx", "systemd"];
  const children = new Map(directories.map((path) => [path, []]));
  for (const directory of directories.slice(1)) children.get("").push(directory);
  for (const path of adminFiles) {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    children.get(parent).push(path);
  }
  let totalBytes = 0;
  function walk(directory) {
    frame(hash, "directory", directory, 0o555, "0", "0", 0);
    for (const child of children.get(directory).sort()) {
      if (children.has(child)) {
        walk(child);
        continue;
      }
      const value = readStable(join(root, child));
      const mode =
        child.endsWith(".sh") || child === "pre-upgrade-snapshot" ? 0o555 : 0o444;
      frame(hash, "file", child, mode, "0", "0", value.size);
      hash.update(value.bytes);
      totalBytes += value.size;
    }
  }
  walk("");
  return { entryCount: 28, fileCount: 25, totalBytes, treeSha256: hash.digest("hex") };
}

function digestRuntime(root, runtimeFiles) {
  const hash = createHash("sha256");
  const uid = "0";
  const gid = "0";
  frame(hash, "directory", "", 0o500, uid, gid, 0);
  let totalBytes = 0;
  for (const [source, label] of runtimeFiles) {
    const value = readStable(join(root, source));
    frame(hash, "file", label, 0o400, uid, gid, value.size);
    hash.update(value.bytes);
    totalBytes += value.size;
  }
  return { entryCount: 5, fileCount: 5, totalBytes, treeSha256: hash.digest("hex") };
}

if (process.argv.length < 5 || !process.argv[2].startsWith("/")) process.exit(2);
try {
  const root = process.argv[2];
  const { adminFiles, runtimeFiles } = parseManifest(process.argv.slice(3));
  process.stdout.write(
    `${JSON.stringify({ admin: digestAdmin(root, adminFiles), runtime: digestRuntime(root, runtimeFiles) })}\n`,
  );
} catch {
  process.stderr.write("Hub admin generation digest failed: unsafe_source\n");
  process.exit(1);
}
