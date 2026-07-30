import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/check-layers.mjs");

/** Run check-layers, returning its exit code and combined output. */
function run(cwd = ROOT): { code: number; out: string } {
  try {
    const out = execFileSync("node", [SCRIPT, "--quiet"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/**
 * The repo itself must pass. This is the assertion that makes `pnpm test`
 * refuse to go green while a layering rule is broken — the substitute for the
 * CI gate we chose not to build.
 */
describe("check:layers", () => {
  it("当前仓库通过全部分层规则", () => {
    const { code, out } = run();
    expect(out).toBe("");
    expect(code).toBe(0);
  });
});

/**
 * A guard that never fails is indistinguishable from no guard. These plant a
 * real violation in a scratch copy and assert the script actually catches it.
 */
describe("check:layers 能真的抓到违规", () => {
  const planted: string[] = [];

  afterEach(() => {
    for (const f of planted.splice(0)) rmSync(f, { force: true });
  });

  function plant(pkg: string, contents: string): void {
    const file = join(ROOT, "packages", pkg, "src", "__layering_probe.ts");
    writeFileSync(file, contents, "utf8");
    planted.push(file);
  }

  it("抓到内核里的厂商名（ADR-004）", () => {
    plant("event-core", 'export const client = "openai";\n');
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("厂商名泄漏");
  });

  it("抓到反向依赖（event-core 不得 import task-engine）", () => {
    plant(
      "event-core",
      'import type { TaskId } from "@agent-os/task-engine";\nexport type X = TaskId;\n',
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("依赖方向");
  });

  it("抓到兄弟包互引（task-engine ↔ memory-core）", () => {
    plant(
      "task-engine",
      'import type { KnowledgeId } from "@agent-os/memory-core";\nexport type X = KnowledgeId;\n',
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("兄弟包互引");
  });

  it("抓到不在目录里的事件类型", () => {
    plant("task-engine", 'export const t = "task.definitely.invented";\n');
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("事件类型绕过目录");
  });

  /**
   * The catalog is read from a Markdown table, and a loose reader is worse than
   * an obvious one: it silently accepts types the catalog never defined. These
   * two both appear in the document — one as a field path in prose, one as a
   * name the catalog mentions only to say it was retired.
   */
  it("目录只认表格行，不认正文里出现的点分名字", () => {
    plant("task-engine", 'export const t = "actor.kind";\n');
    expect(run().out).toContain("事件类型绕过目录");
  });

  it("已废弃的旧类型名不算目录条目", () => {
    plant("task-engine", 'export const t = "news.generated";\n');
    expect(run().out).toContain("事件类型绕过目录");
  });
});

/**
 * A separate scratch directory: with no packages/ at all the script must still
 * exit cleanly rather than crash, so a fresh clone or a partial checkout does
 * not produce a confusing failure.
 */
describe("check:layers 在空仓库下不崩", () => {
  it("没有 packages/ 时正常退出", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentos-layers-"));
    try {
      const { code } = run(dir);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
