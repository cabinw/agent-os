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
import ts from "typescript";

const ROOT = resolve(
  process.env.AGENT_OS_LAYER_ROOT ?? dirname(fileURLToPath(import.meta.url)),
  process.env.AGENT_OS_LAYER_ROOT ? "." : "..",
);
const PACKAGES = join(ROOT, "packages");
const QUIET = process.argv.includes("--quiet");

/**
 * What each package is allowed to import from this repo.
 * `event-core` is the bottom of the stack: it imports no workspace package.
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

function parseSource(file) {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

function visit(source, predicate) {
  const matches = [];
  function walk(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, walk);
  }
  walk(source);
  return matches;
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function lineText(source, line) {
  return source.text.split("\n")[line - 1] ?? "";
}

/**
 * Return actual module-specifier nodes, rather than treating every string on a
 * line containing the word `import` as a module path. This covers static
 * imports/exports, dynamic import(), require(), import-equals and import types.
 */
function moduleSpecifiers(source) {
  const found = [];
  const seen = new Set();

  function add(node) {
    if (!node || !ts.isStringLiteralLike(node) || seen.has(node.pos)) return;
    seen.add(node.pos);
    found.push({ node, specifier: node.text });
  }

  function walk(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument)) add(argument.literal);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) add(node.arguments[0]);
    }
    ts.forEachChild(node, walk);
  }

  walk(source);
  return found;
}

function internalPackage(specifier) {
  return specifier.match(/^@agent-os\/([a-z-]+)(?:\/|$)/)?.[1] ?? null;
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
    const source = parseSource(file);
    const code = stripComments(source.text);
    const codeLines = code.split("\n");

    codeLines.forEach((text, idx) => {
      const line = idx + 1;

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

    // rule 2 — dependency direction. AST module nodes cover static and dynamic
    // imports without allowing unrelated text on the same line to hide a hit.
    for (const { node, specifier } of moduleSpecifiers(source)) {
      const target = internalPackage(specifier);
      if (!target || target === pkg || allowed.has(target)) continue;
      const line = lineOf(source, node);
      const upward = ALLOWED_DEPS[target]?.includes(pkg);
      report(
        "依赖方向",
        rel,
        line,
        lineText(source, line),
        upward
          ? `${pkg} 不能 import ${target}——方向反了，${target} 依赖 ${pkg}`
          : `${pkg} 不允许 import ${target}（见 docs/architecture/packages.md）`,
      );
    }
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
    const source = parseSource(file);
    for (const { node, specifier } of moduleSpecifiers(source)) {
      if (internalPackage(specifier) !== b) continue;
      const line = lineOf(source, node);
      report(
        "兄弟包互引",
        relative(ROOT, file),
        line,
        lineText(source, line),
        `${a} 与 ${b} 是兄弟，只能通过发事件和归约事件通信`,
      );
    }
  }
}

// -------------------------------------------------------------------- rule 4
// Event types are permanent — one that ships wrong stays in old logs forever.
// Every type must exist in the catalog before it can be emitted.
const CATALOG = join(ROOT, "docs/protocol/event-catalog.md");
const catalogTypes = new Set();
if (safeStat(CATALOG)) {
  const md = readFileSync(CATALOG, "utf8");
  // Only the first cell of a table row counts as a catalog entry. Scanning the
  // whole document was too permissive: it also accepted field paths mentioned in
  // prose (`actor.kind`) and retired names the catalog names only to say they
  // are retired (`news.generated`), so the guard would have waved through an
  // event type the catalog explicitly does not define.
  for (const m of md.matchAll(/^\| `([a-z]+(?:\.[a-z]+)+)`/gm)) catalogTypes.add(m[1]);
}

const EVENT_LIKE = /^([a-z]+(?:\.[a-z]+)+)$/;
/** Module specifiers and filenames look like event types; they are not. */
const NOT_EVENTS =
  /^(node|src|dist|index|package|tsconfig)\.|\.(mjs|cjs|js|ts|tsx|json|md|html|css|toml|yaml|yml|lock|jsonl|txt|sock)$/;

// Applies to apps/ too — the chat spike emits real events, so it must not be
// able to invent a type the catalog has never heard of.
const EVENT_ROOTS = [
  ...Object.keys(ALLOWED_DEPS).map((p) => join(PACKAGES, p, "src")),
  join(ROOT, "apps"),
];

if (catalogTypes.size === 0) {
  report(
    "事件目录为空",
    relative(ROOT, CATALOG),
    1,
    safeStat(CATALOG) ? "未找到有效的事件表格行" : "文件不存在",
    "事件目录缺失或为空时不能验证事件类型，拒绝以成功状态退出",
  );
} else {
  for (const file of EVENT_ROOTS.flatMap((r) => sourceFiles(r))) {
    const source = parseSource(file);
    const modules = new Set(moduleSpecifiers(source).map(({ node }) => node.pos));
    const literals = visit(
      source,
      (node) => ts.isStringLiteralLike(node) && !modules.has(node.pos),
    );

    for (const literal of literals) {
      const line = lineOf(source, literal);
      const match = literal.text.match(EVENT_LIKE);
      if (!match) continue;
      const type = match[1];
      if (NOT_EVENTS.test(type)) continue;
      if (!catalogTypes.has(type)) {
        report(
          "事件类型绕过目录",
          relative(ROOT, file),
          line,
          lineText(source, line),
          `"${type}" 不在 docs/protocol/event-catalog.md 里。先写目录条目，再写 reducer，再写重放测试，最后才发`,
        );
      }
    }
  }
}

// --------------------------------------------------------------------- output
if (violations.length === 0) {
  if (!QUIET) {
    console.log("✓ check:layers — 4 条规则全部通过");
    console.log(`  · ${Object.keys(ALLOWED_DEPS).length} 个包，依赖方向严格向下`);
    console.log(
      `  · event-core 内部 workspace 依赖数：${ALLOWED_DEPS["event-core"].length}`,
    );
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
