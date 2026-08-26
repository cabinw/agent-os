#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const STATE = join(ROOT, ".agent-os", "local");
const NATIVE = process.argv.includes("--native");
const children = new Set();
let stopping = false;

mkdirSync(join(STATE, "workspaces"), { recursive: true, mode: 0o700 });

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`Agent OS child exited (${signal ?? code ?? "unknown"})`);
      stop(code ?? 1);
    }
  });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250).unref();
}

async function ready(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));

start(process.execPath, [join(ROOT, "apps/chat-spike/src/server.mjs")], {
  env: {
    LOG_PATH: join(STATE, "events.jsonl"),
    SESSION_PATH: join(STATE, "sessions.json"),
    AGENT_CWD: join(STATE, "workspaces"),
    AGENT_OS_SUPPRESS_GENERATED_TOKEN: "1",
  },
});

if (NATIVE) {
  start(
    process.execPath,
    [join(ROOT, "apps/macos/node_modules/@tauri-apps/cli/tauri.js"), "dev"],
    { cwd: join(ROOT, "apps/macos") },
  );
} else {
  start(process.execPath, [join(ROOT, "apps/macos/node_modules/vite/bin/vite.js")], {
    cwd: join(ROOT, "apps/macos"),
  });
}

try {
  await Promise.all([
    ready("http://127.0.0.1:4173/health/live"),
    ready("http://localhost:5173/"),
  ]);
  console.log("\nAgent OS is ready: http://localhost:5173/\n");
} catch (error) {
  console.error(error.message);
  stop(1);
}

setInterval(() => {}, 2_147_483_647);
