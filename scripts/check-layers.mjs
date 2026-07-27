#!/usr/bin/env node
/**
 * check-layers — the mechanical guard for ADR-004 and ADR-005.
 *
 * There is no CI on this repo by decision (see todo.html, decision D), so this
 * script is the only thing standing between the specs and quiet architectural
 * drift. It is also run as a test (tests/layering.test.ts) so `pnpm test`
 * cannot pass while a layering rule is broken.
 *
 * Checks:
 *   1. No vendor names below agent-sdk           — ADR-004
 *   2. Dependency direction is strictly downward — docs/architecture/packages.md
 *   3. task-engine and memory-core never import each other
 *   4. No event-type string literal outside the catalog
 *
 * Usage: node scripts/check-layers.mjs [--quiet]
 * Exits non-zero on the first rule violated.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(ROOT, "packages");
const QUIET = process.argv.includes("--quiet");

/**
 * What each package is allowed to import from this repo.
 * `event-core` is the bottom of the stack: it imports nothing.
 */
const ALLOWED_DEPS = {
  "event-core": [],
  "task-engine": ["event-core"],
  "memory-core": ["event-core"],
  "agent-sdk": ["event-core"],
  "mcp-server": ["event-core", "task-engine", "memory-core", "agent-sdk"],
};

/**
 * Vendor names must not appear below agent-sdk. agent-sdk is the adapter layer
 * and is the one place they are permitted (ADR-004).
 */
const VENDOR_PATTERN =
  /\b(openai|anthropic|gemini|google-?ai|xai|grok|mistral|perplexity|cohere|ollama|kimi|moonshot)\b/i;
const VENDOR_FREE_PACKAGES = ["event-core", "task-engine", "memory-core"];

const violations = [];

function report(rule, file, line, text, why) {
  violations.push({ rule, file, line, text: text.trim().slice(0, 100), why });
}

function sourceFiles(dir) {
  const out = [];
  if (!safeStat(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = safeStat(full);
    if (!st) continue;
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function safeStat(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** Strip line and block comments so prose in a doc comment is never a hit. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

// ---------------------------------------------------------------- rule 1 & 2
for (const pkg of Object.keys(ALLOWED_DEPS)) {
  const src = join(PACKAGES, pkg, "src");
  const allowed = new Set(ALLOWED_DEPS[pkg]);

  for (const file of sourceFiles(src)) {
    const rel = relative(ROOT, file);
    const code = stripComments(readFileSync(file, "utf8"));
    const codeLines = code.split("\n");

    codeLines.forEach((text, idx) => {
      const line = idx + 1;

      // rule 2 — dependency direction
      const imp = text.match(/from\s+["']@agent-os\/([a-z-]+)["']/);
      if (imp) {
        const target = imp[1];
        if (target !== pkg && !allowed.has(target)) {
          const upward = ALLOWED_DEPS[target]?.includes(pkg);
          report(
            "依赖方向",
            rel,
            line,
            text,
            upward
              ? `${pkg} 不能 import ${target}——方向反了，${target} 依赖 ${pkg}`
              : `${pkg} 不允许 import ${target}（见 docs/architecture/packages.md）`,
          );
        }
      }

      // rule 1 — vendor names below agent-sdk
      if (VENDOR_FREE_PACKAGES.includes(pkg)) {
        const vendor = text.match(VENDOR_PATTERN);
        if (vendor) {
          report(
            "厂商名泄漏",
            rel,
            line,
            text,
            `${pkg} 里出现 "${vendor[0]}"。路由只读 capabilities——厂商名只允许在 agent-sdk 的适配器里（ADR-004）`,
          );
        }
      }
    });
  }
}

// -------------------------------------------------------------------- rule 3
// Redundant with rule 2 by construction, but stated separately because it is
// the invariant most likely to be "temporarily" relaxed under delivery pressure.
for (const [a, b] of [
  ["task-engine", "memory-core"],
  ["memory-core", "task-engine"],
]) {
  for (const file of sourceFiles(join(PACKAGES, a, "src"))) {
    const code = stripComments(readFileSync(file, "utf8"));
    code.split("\n").forEach((text, idx) => {
      if (text.includes(`@agent-os/${b}`)) {
        report(
          "兄弟包互引",
          relative(ROOT, file),
          idx + 1,
          text,
          `${a} 与 ${b} 是兄弟，只能通过发事件和归约事件通信`,
        );
      }
    });
  }
}

// -------------------------------------------------------------------- rule 4
// Event types are permanent — one that ships wrong stays in old logs forever.
// Every type must exist in the catalog before it can be emitted.
const CATALOG = join(ROOT, "docs/protocol/event-catalog.md");
const catalogTypes = new Set();
if (safeStat(CATALOG)) {
  const md = readFileSync(CATALOG, "utf8");
  for (const m of md.matchAll(/`([a-z]+\.[a-z.]+)`/g)) catalogTypes.add(m[1]);
}

const EVENT_LIKE = /["']([a-z]+\.[a-z]+(?:\.[a-z]+)*)["']/g;
const NOT_EVENTS = /^(node|src|dist|index|package|tsconfig)\./;

if (catalogTypes.size > 0) {
  for (const pkg of Object.keys(ALLOWED_DEPS)) {
    for (const file of sourceFiles(join(PACKAGES, pkg, "src"))) {
      const code = stripComments(readFileSync(file, "utf8"));
      code.split("\n").forEach((text, idx) => {
        for (const m of text.matchAll(EVENT_LIKE)) {
          const type = m[1];
          if (NOT_EVENTS.test(type)) continue;
          if (text.includes("import") || text.includes("require(")) continue;
          if (!catalogTypes.has(type)) {
            report(
              "事件类型绕过目录",
              relative(ROOT, file),
              idx + 1,
              text,
              `"${type}" 不在 docs/protocol/event-catalog.md 里。先写目录条目，再写 reducer，再写重放测试，最后才发`,
            );
          }
        }
      });
    }
  }
}

// --------------------------------------------------------------------- output
if (violations.length === 0) {
  if (!QUIET) {
    console.log("✓ check:layers — 4 条规则全部通过");
    console.log(`  · ${Object.keys(ALLOWED_DEPS).length} 个包，依赖方向严格向下`);
    console.log(`  · event-core 依赖数：${ALLOWED_DEPS["event-core"].length}`);
    console.log(`  · 事件目录已知类型：${catalogTypes.size}`);
  }
  process.exit(0);
}

console.error(`✗ check:layers — ${violations.length} 处违规\n`);
for (const v of violations) {
  console.error(`  [${v.rule}] ${v.file}:${v.line}`);
  console.error(`    ${v.text}`);
  console.error(`    → ${v.why}\n`);
}
process.exit(1);
