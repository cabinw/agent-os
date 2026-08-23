#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function reject(message) {
  throw new Error(message);
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return (
    path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

function walk(root, directory) {
  let fileCount = 0;
  let totalBytes = 0;
  function visit(current) {
    for (const name of readdirSync(current)) {
      const path = resolve(current, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        reject("release contains a symbolic link");
      }
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        reject("release contains a special object or multiply-linked file");
      }
      fileCount += 1;
      totalBytes += stat.size;
      if (
        fileCount > 50_000 ||
        stat.size > 128 * 1024 * 1024 ||
        totalBytes > 512 * 1024 * 1024
      ) {
        reject("release exceeds the audited file-count or byte boundary");
      }
    }
  }
  visit(directory);
}

function regular(root, relativePath) {
  const path = resolve(root, relativePath);
  if (!inside(root, path)) reject("release requirement escaped its root");
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    reject(`release is missing required file ${relativePath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    reject(`release requirement ${relativePath} must be a regular file`);
  }
  return path;
}

function absent(root, relativePath) {
  const path = resolve(root, relativePath);
  if (!inside(root, path)) reject("release absence check escaped its root");
  try {
    lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    reject(`release path ${relativePath} could not be inspected`);
  }
  reject(`release contains forbidden dependency metadata ${relativePath}`);
}

function packageName(path, expected) {
  let value;
  try {
    if (lstatSync(path).size > 1024 * 1024) {
      reject("release package manifest exceeds 1 MiB");
    }
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    reject("release contains an unreadable package manifest");
  }
  if (value?.name !== expected) reject("release package identity is invalid");
}

function main(argv) {
  if (argv.length !== 1) reject("usage: verify-release.mjs RELEASE_ROOT");
  const unresolvedRoot = resolve(argv[0]);
  const rootStat = lstatSync(unresolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    reject("release root must be a real directory");
  }
  const root = realpathSync(unresolvedRoot);
  if (root !== unresolvedRoot) reject("release root contains a symbolic link");
  const allowedTopLevel = new Set([
    "apps",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".artifact.sha256",
  ]);
  if (readdirSync(root).some((name) => !allowedTopLevel.has(name))) {
    reject("release contains a top-level path outside the application allowlist");
  }
  walk(root, root);
  packageName(regular(root, "package.json"), "agent-os");
  packageName(regular(root, "apps/chat-spike/package.json"), "@agent-os/chat-spike");
  regular(root, "apps/chat-spike/src/server.mjs");
  regular(root, "apps/chat-spike/public/index.html");
  regular(root, "apps/chat-spike/node_modules/@modelcontextprotocol/sdk/package.json");
  regular(
    root,
    "apps/chat-spike/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js",
  );
  regular(root, "apps/chat-spike/node_modules/zod/package.json");
  for (const metadata of [
    ".bin",
    ".pnpm",
    ".modules.yaml",
    ".package-map.json",
    ".pnpm-workspace-state-v1.json",
  ]) {
    absent(root, `apps/chat-spike/node_modules/${metadata}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `Hub release rejected: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}
