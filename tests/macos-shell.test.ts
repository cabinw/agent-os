import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCALES, copy } from "../apps/macos/src/i18n.js";
import { NAVIGATION, ROUTE_IDS, landingRoute } from "../apps/macos/src/navigation.js";

const ROOT = resolve(import.meta.dirname, "..");
const MACOS = join(ROOT, "apps", "macos");
const SOURCE = join(MACOS, "src");

function read(relativePath: string): string {
  return readFileSync(join(MACOS, relativePath), "utf8");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".css", ".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  });
}

function token(name: string): string {
  const match = read("src/styles/tokens.css").match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match?.[1]) throw new Error(`missing token --${name}`);
  return match[1].trim();
}

describe("RM-3.1 canonical macOS shell", () => {
  it("exports the exact seven stable destinations in canonical order", () => {
    expect(ROUTE_IDS).toEqual([
      "project-library",
      "project-pulse",
      "canvas",
      "tasks",
      "agents",
      "memory",
      "settings",
    ]);
    expect(NAVIGATION.map(({ id }) => id)).toEqual(ROUTE_IDS);
    expect(NAVIGATION).toHaveLength(7);
  });

  it("lands on Library without a project and Pulse with one", () => {
    expect(landingRoute(false)).toBe("project-library");
    expect(landingRoute(true)).toBe("project-pulse");
  });

  it("externalizes every route label and description for both locales", () => {
    expect(LOCALES).toEqual(["zh-CN", "en"]);
    for (const locale of LOCALES) {
      expect(Object.keys(copy[locale].nav)).toEqual([...ROUTE_IDS]);
      expect(Object.keys(copy[locale].routeDescription)).toEqual([...ROUTE_IDS]);
      for (const id of ROUTE_IDS) {
        expect(copy[locale].nav[id].trim()).not.toBe("");
        expect(copy[locale].routeDescription[id].trim()).not.toBe("");
      }
    }
  });

  it("matches canonical light tokens and fixed sidebar width", () => {
    expect({
      bg: token("bg"),
      surface: token("surface"),
      border: token("border"),
      text: token("text"),
      muted: token("text-muted"),
      accent: token("accent"),
      accentEnd: token("accent-end"),
      ok: token("ok"),
      warn: token("warn"),
      risk: token("risk"),
      info: token("info"),
      sidebar: token("sidebar-width"),
    }).toEqual({
      bg: "#f7f8fa",
      surface: "#ffffff",
      border: "#e8eaed",
      text: "#111827",
      muted: "#6b7280",
      accent: "#6366f1",
      accentEnd: "#8b5cf6",
      ok: "#10b981",
      warn: "#f59e0b",
      risk: "#ef4444",
      info: "#3b82f6",
      sidebar: "220px",
    });
  });

  it("keeps literal colors and shadows inside tokens.css only", () => {
    const tokenPath = join(SOURCE, "styles", "tokens.css");
    for (const path of sourceFiles(SOURCE)) {
      if (path === tokenPath) continue;
      const contents = readFileSync(path, "utf8");
      expect(contents, path).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
      for (const match of contents.matchAll(/box-shadow:\s*([^;]+);/g)) {
        expect(match[1]?.trim(), path).toMatch(/^var\(/);
      }
    }
  });

  it("does not expose rejected top-level destination ids", () => {
    const ids = new Set<string>(ROUTE_IDS);
    expect(ids.has("runtime")).toBe(false);
    expect(ids.has("project-info")).toBe(false);
    expect(ids.has("knowledge-graph")).toBe(false);
  });

  it("uses a decorated minimum-size native window and strict capability", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(config.app.windows).toEqual([
      expect.objectContaining({
        label: "main",
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 720,
        resizable: true,
        decorations: true,
        transparent: false,
        titleBarStyle: "Visible",
      }),
    ]);
    expect(config.app.security.csp).not.toContain("*");
    expect(config.build.beforeBuildCommand).toBe(
      "node_modules/.bin/tsc --build && node_modules/.bin/vite build",
    );
    expect(config.build.beforeBuildCommand).not.toContain("pnpm");
    const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
    expect(capability.permissions).toEqual(["core:default"]);
  });

  it("keeps Rust as a minimal Tauri boundary with no domain or SQLite code", () => {
    const rust = [read("src-tauri/src/lib.rs"), read("src-tauri/src/main.rs")].join("\n");
    const cargo = read("src-tauri/Cargo.toml");
    const packageJson = read("package.json");
    expect(rust).toContain("tauri::Builder::default()");
    expect(`${rust}\n${cargo}\n${packageJson}`).not.toMatch(
      /better-sqlite3|event-store-sqlite|rusqlite|sqlx/i,
    );
    expect(JSON.parse(packageJson).dependencies).toEqual({
      react: "19.2.8",
      "react-dom": "19.2.8",
    });
  });

  it("keeps Tauri build output outside source formatting and version control", () => {
    const biome = JSON.parse(readFileSync(join(ROOT, "biome.json"), "utf8"));
    const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    expect(biome.files.ignore).toContain("target/**");
    expect(biome.files.ignore).toContain("apps/macos/src-tauri/gen/**");
    expect(gitignore).toContain("target/");
    expect(gitignore).toContain("apps/macos/src-tauri/gen/");
  });
});
