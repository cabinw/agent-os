#!/usr/bin/env node

import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

function reject(message) {
  throw new Error(message);
}

function writeAll(fd, buffer, length) {
  let offset = 0;
  while (offset < length) {
    offset += writeSync(fd, buffer, offset, length - offset);
  }
}

function main(argv) {
  if (argv.length !== 2) reject("usage: copy-artifact.mjs SOURCE DESTINATION");
  const [source, destination] = argv;
  let sourceFd;
  let destinationFd;
  let destinationCreated = false;
  let completed = false;
  try {
    const resolvedDestination = resolve(destination);
    if (resolvedDestination !== destination) {
      reject("destination artifact path must be absolute and canonical");
    }
    const destinationParent = dirname(resolvedDestination);
    const destinationParentStat = lstatSync(destinationParent);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      !destinationParentStat.isDirectory() ||
      destinationParentStat.isSymbolicLink() ||
      realpathSync(destinationParent) !== destinationParent ||
      (expectedUid !== null && destinationParentStat.uid !== expectedUid) ||
      (destinationParentStat.mode & 0o022) !== 0
    ) {
      reject("destination parent must be a trusted canonical private directory");
    }
    sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const sourceStat = fstatSync(sourceFd);
    if (!sourceStat.isFile() || sourceStat.nlink !== 1) {
      reject("source artifact must be a single-link regular file");
    }
    if (expectedUid !== null && sourceStat.uid !== expectedUid) {
      reject("source artifact must be owned by the installing account");
    }
    if ((sourceStat.mode & 0o022) !== 0) {
      reject("source artifact must not be group/world writable");
    }
    if (sourceStat.size < 1 || sourceStat.size > MAX_ARCHIVE_BYTES) {
      reject("source artifact size is outside the 1..512 MiB boundary");
    }

    destinationFd = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o400,
    );
    destinationCreated = true;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead;
    let copiedBytes = 0;
    while (true) {
      bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      copiedBytes += bytesRead;
      if (copiedBytes > sourceStat.size || copiedBytes > MAX_ARCHIVE_BYTES) {
        reject("source artifact changed or exceeded its audited size while copying");
      }
      writeAll(destinationFd, buffer, bytesRead);
    }
    const finalSourceStat = fstatSync(sourceFd);
    if (
      copiedBytes !== sourceStat.size ||
      finalSourceStat.size !== sourceStat.size ||
      finalSourceStat.dev !== sourceStat.dev ||
      finalSourceStat.ino !== sourceStat.ino ||
      finalSourceStat.nlink !== sourceStat.nlink ||
      finalSourceStat.mode !== sourceStat.mode ||
      finalSourceStat.uid !== sourceStat.uid ||
      finalSourceStat.gid !== sourceStat.gid ||
      finalSourceStat.mtimeMs !== sourceStat.mtimeMs ||
      finalSourceStat.ctimeMs !== sourceStat.ctimeMs
    ) {
      reject("source artifact changed while copying");
    }
    fsyncSync(destinationFd);
    completed = true;
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    if (sourceFd !== undefined) closeSync(sourceFd);
    if (!completed && destinationCreated) {
      try {
        unlinkSync(destination);
      } catch {}
    }
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `Hub artifact copy rejected: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}
