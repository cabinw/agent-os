import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGES = [
  "event-core",
  "event-store-sqlite",
  "task-engine",
  "memory-core",
  "agent-sdk",
  "mcp-server",
] as const;

/**
 * tsconfig files are JSONC — TypeScript accepts comments, JSON.parse does not.
 * String-aware so a `//` inside a URL (the `$schema` value) survives.
 */
function stripJsonComments(src: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    const n = src[i + 1];

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(stripJsonComments(readFileSync(join(ROOT, path), "utf8")));
}

describe("workspace 骨架", () => {
  it("六个包都存在且命名一致", () => {
    for (const p of PACKAGES) {
      const pkg = readJson(`packages/${p}/package.json`);
      expect(pkg.name).toBe(`@agent-os/${p}`);
      expect(pkg.type).toBe("module");
    }
  });

  it("event-core 没有任何内部 workspace 依赖", () => {
    const pkg = readJson("packages/event-core/package.json");
    const dependencies = pkg.dependencies as Record<string, string> | undefined;
    expect(
      Object.keys(dependencies ?? {}).filter((name) => name.startsWith("@agent-os/")),
    ).toEqual([]);

    const tsconfig = readJson("packages/event-core/tsconfig.json");
    expect(tsconfig.references).toEqual([]);
  });

  it("task-engine 与 memory-core 互不依赖", () => {
    for (const [a, b] of [
      ["task-engine", "memory-core"],
      ["memory-core", "task-engine"],
    ]) {
      const deps = readJson(`packages/${a}/package.json`).dependencies as
        | Record<string, string>
        | undefined;
      expect(Object.keys(deps ?? {})).not.toContain(`@agent-os/${b}`);
    }
  });

  it("package.json 的依赖与 tsconfig 的 references 一致", () => {
    for (const p of PACKAGES) {
      const deps = Object.keys(
        (readJson(`packages/${p}/package.json`).dependencies as
          | Record<string, string>
          | undefined) ?? {},
      )
        .filter((d) => d.startsWith("@agent-os/"))
        .map((d) => d.replace("@agent-os/", ""))
        .sort();

      const refs = (
        (readJson(`packages/${p}/tsconfig.json`).references as
          | { path: string }[]
          | undefined) ?? []
      )
        .map((r) => r.path.replace("../", ""))
        .sort();

      expect(refs, `${p}: references 与 dependencies 不一致`).toEqual(deps);
    }
  });

  it("packages/ 不引入 DOM lib —— 内核不得假设 UI 存在", () => {
    const base = readJson("tsconfig.base.json").compilerOptions as {
      lib: string[];
    };
    expect(base.lib).not.toContain("DOM");
  });
});
