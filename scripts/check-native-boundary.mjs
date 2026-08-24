#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "agent-os-native-boundary-"));

function deploy(filter, destination) {
  execFileSync(
    "corepack",
    ["pnpm", "--filter", filter, "deploy", "--prod", "--legacy", destination],
    { cwd: ROOT, encoding: "utf8", stdio: "pipe" },
  );
}

function collectPackageNames(root) {
  const names = new Set();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || entry.name !== "package.json") continue;
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (typeof value.name === "string") names.add(value.name);
    }
  };
  visit(root);
  return names;
}

function requirePackages(label, names, required, forbidden) {
  for (const name of required) {
    if (!names.has(name)) throw new Error(`${label} deploy is missing ${name}`);
  }
  for (const name of forbidden) {
    if (names.has(name)) throw new Error(`${label} deploy unexpectedly contains ${name}`);
  }
}

try {
  const runner = join(scratch, "runner");
  const sqlite = join(scratch, "sqlite");
  deploy("@agent-os/chat-spike", runner);
  deploy("@agent-os/event-store-sqlite", sqlite);

  requirePackages(
    "Runner",
    collectPackageNames(runner),
    ["@agent-os/chat-spike"],
    ["@agent-os/event-store-sqlite", "better-sqlite3"],
  );
  requirePackages(
    "SQLite adapter",
    collectPackageNames(sqlite),
    ["@agent-os/event-store-sqlite", "@agent-os/event-core", "better-sqlite3"],
    [],
  );
  console.log("✓ check:native-boundary — Runner excludes SQLite native addon");
  console.log("  · SQLite adapter deploy contains exact Hub-only driver closure");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
