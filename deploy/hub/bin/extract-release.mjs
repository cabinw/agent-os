#!/usr/bin/env node

import {
  constants,
  closeSync,
  createReadStream,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";

const BLOCK_BYTES = 512;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 50_000;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_STREAM_BYTES = 640 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function reject(message) {
  throw new Error(message);
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return (
    path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

function text(field, label) {
  const end = field.indexOf(0);
  try {
    return decoder.decode(end === -1 ? field : field.subarray(0, end));
  } catch {
    reject(`tar ${label} is not valid UTF-8`);
  }
}

function octal(field, label) {
  const value = text(field, label).trim();
  if (value === "") return 0;
  if (!/^[0-7]+$/u.test(value)) reject(`tar ${label} is not canonical octal`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) reject(`tar ${label} is out of range`);
  return parsed;
}

function checksum(header) {
  const expected = octal(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) reject("tar header checksum mismatch");
}

function releasePath(root, header) {
  const name = text(header.subarray(0, 100), "name");
  const prefix = text(header.subarray(345, 500), "prefix");
  let path = prefix ? `${prefix}/${name}` : name;
  while (path.startsWith("./")) path = path.slice(2);
  path = path.replace(/\/+$/u, "");
  if (path === "") return { path: root, relativePath: "" };
  const hasControlCharacter = Array.from(path).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (path.includes("\\") || hasControlCharacter || isAbsolute(path)) {
    reject("tar member path is unsafe");
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    reject("tar member path contains traversal");
  }
  const top = parts[0];
  const rootFiles = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
  if (top === "apps") {
    if (parts.length > 1 && parts[1] !== "chat-spike") {
      reject("tar contains an application outside the Hub release allowlist");
    }
  } else if (!rootFiles.has(top)) {
    reject("tar contains a top-level path outside the Hub release allowlist");
  }
  const destination = resolve(root, ...parts);
  if (!inside(root, destination)) reject("tar member escaped the release root");
  return { path: destination, relativePath: path };
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

async function extract(archive, destination) {
  const unresolvedRoot = resolve(destination);
  const rootStat = lstatSync(unresolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    reject("release destination must be a real directory");
  }
  const root = realpathSync(unresolvedRoot);
  if (root !== unresolvedRoot) reject("release destination contains a symbolic link");

  let buffer = Buffer.alloc(0);
  let current = null;
  let fileCount = 0;
  let expandedBytes = 0;
  let streamedBytes = 0;
  let zeroBlocks = 0;
  const openFiles = new Set();
  let archiveFd;
  try {
    archiveFd = openSync(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
    const archiveStat = fstatSync(archiveFd);
    if (
      !archiveStat.isFile() ||
      archiveStat.nlink !== 1 ||
      archiveStat.size < 1 ||
      archiveStat.size > MAX_ARCHIVE_BYTES
    ) {
      reject("release archive is outside the audited regular-file boundary");
    }
    const stream = createReadStream(archive, { fd: archiveFd, autoClose: false }).pipe(
      createGunzip(),
    );
    for await (const chunk of stream) {
      streamedBytes += chunk.length;
      if (streamedBytes > MAX_STREAM_BYTES) {
        reject("tar stream exceeds the audited decompression boundary");
      }
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      while (true) {
        if (current) {
          if (current.remaining > 0) {
            if (buffer.length === 0) break;
            const count = Math.min(current.remaining, buffer.length);
            writeAll(current.fd, buffer.subarray(0, count));
            buffer = buffer.subarray(count);
            current.remaining -= count;
            if (current.remaining > 0) break;
          }
          if (buffer.length < current.padding) break;
          buffer = buffer.subarray(current.padding);
          fsyncSync(current.fd);
          closeSync(current.fd);
          openFiles.delete(current.fd);
          current = null;
          continue;
        }

        if (buffer.length < BLOCK_BYTES) break;
        const header = buffer.subarray(0, BLOCK_BYTES);
        buffer = buffer.subarray(BLOCK_BYTES);
        if (header.every((byte) => byte === 0)) {
          zeroBlocks += 1;
          continue;
        }
        if (zeroBlocks > 0) reject("tar contains data after its first end marker");
        checksum(header);
        if (
          text(header.subarray(257, 263), "magic") !== "ustar" ||
          text(header.subarray(263, 265), "version") !== "00"
        ) {
          reject("tar must use the audited ustar format");
        }
        const type = String.fromCharCode(header[156] || 48);
        const size = octal(header.subarray(124, 136), "size");
        const member = releasePath(root, header);
        fileCount += 1;
        expandedBytes += size;
        if (fileCount > MAX_FILES || expandedBytes > MAX_EXPANDED_BYTES) {
          reject("tar exceeds the release expansion boundary");
        }

        if (type === "5") {
          if (size !== 0) reject("tar directory has a non-zero body");
          if (member.relativePath !== "")
            mkdirSync(member.path, { recursive: true, mode: 0o700 });
          continue;
        }
        if (type !== "0") {
          reject("tar links, extended headers and special members are forbidden");
        }
        const parent = resolve(member.path, "..");
        if (!inside(root, parent)) reject("tar file parent escaped the release root");
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        const fd = openSync(
          member.path,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        openFiles.add(fd);
        current = {
          fd,
          remaining: size,
          padding: (BLOCK_BYTES - (size % BLOCK_BYTES)) % BLOCK_BYTES,
        };
      }
    }
    if (current || buffer.length !== 0 || zeroBlocks < 2) {
      reject("tar ended before a complete audited end marker");
    }
    const finalArchiveStat = fstatSync(archiveFd);
    if (
      finalArchiveStat.dev !== archiveStat.dev ||
      finalArchiveStat.ino !== archiveStat.ino ||
      finalArchiveStat.nlink !== archiveStat.nlink ||
      finalArchiveStat.mode !== archiveStat.mode ||
      finalArchiveStat.uid !== archiveStat.uid ||
      finalArchiveStat.gid !== archiveStat.gid ||
      finalArchiveStat.size !== archiveStat.size ||
      finalArchiveStat.mtimeMs !== archiveStat.mtimeMs ||
      finalArchiveStat.ctimeMs !== archiveStat.ctimeMs
    ) {
      reject("release archive changed while it was extracted");
    }
  } finally {
    for (const fd of openFiles) {
      try {
        closeSync(fd);
      } catch {}
    }
    if (archiveFd !== undefined) {
      try {
        closeSync(archiveFd);
      } catch {}
    }
  }
}

async function main(argv) {
  if (argv.length !== 2) reject("usage: extract-release.mjs ARCHIVE DESTINATION");
  await extract(argv[0], argv[1]);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `Hub release extraction rejected: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}
