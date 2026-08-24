#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCoreDemo } from "../apps/core-demo/dist/index.js";

const root = mkdtempSync(join(tmpdir(), "agent-os-core-demo-"));
try {
  const evidence = await runCoreDemo({ databasePath: join(root, "events.sqlite") });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
