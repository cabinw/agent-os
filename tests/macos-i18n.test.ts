import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOGS,
  CATALOG_KEYS,
  type CatalogKey,
  DEFAULT_LOCALE,
  I18nCatalogError,
  resolveLocale,
  t,
  translatorFor,
  validateCatalog,
} from "../apps/macos/src/i18n.js";

const ROOT = resolve(import.meta.dirname, "..");
const APP_SOURCE = join(ROOT, "apps", "macos", "src");

function cloneDefault(): Record<string, unknown> {
  return { ...CATALOGS[DEFAULT_LOCALE] };
}

function expectCatalogError(action: () => unknown, code: I18nCatalogError["code"]): void {
  expect(action).toThrowError(I18nCatalogError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("RM-3.2 typed JSON i18n", () => {
  it("admits two frozen catalogs with one exact key set", () => {
    expect(CATALOG_KEYS).toHaveLength(323);
    expect(Object.keys(CATALOGS["zh-CN"]).sort()).toEqual([...CATALOG_KEYS]);
    expect(Object.keys(CATALOGS.en).sort()).toEqual([...CATALOG_KEYS]);
    expect(Object.isFrozen(CATALOGS)).toBe(true);
    expect(Object.isFrozen(CATALOGS["zh-CN"])).toBe(true);
    expect(Object.isFrozen(CATALOGS.en)).toBe(true);
  });

  it("returns complete copy only through typed t() and bound translators", () => {
    expect(t("zh-CN", "nav.project-library.label")).toBe("项目库");
    expect(t("en", "nav.project-library.label")).toBe("Project Library");
    const en = translatorFor("en");
    expect(en("shell.status.ready")).toBe("Ready");
  });

  it.each([
    ["zh-CN", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh_TW", "zh-CN"],
    ["en", "en"],
    ["en-US", "en"],
    [" EN_gb ", "en"],
    ["fr-FR", "zh-CN"],
    ["", "zh-CN"],
    [null, "zh-CN"],
    [{ locale: "en" }, "zh-CN"],
  ] as const)("resolves locale %j to %s", (input, expected) => {
    expect(resolveLocale(input)).toBe(expected);
  });

  it("rejects non-object catalogs", () => {
    expectCatalogError(() => validateCatalog("probe", null), "catalog-invalid");
    expectCatalogError(() => validateCatalog("probe", []), "catalog-invalid");
    expectCatalogError(() => validateCatalog("probe", "copy"), "catalog-invalid");
  });

  it("rejects a missing key with an exact diagnostic", () => {
    const catalog = Object.fromEntries(
      Object.entries(cloneDefault()).filter(([key]) => key !== "shell.status.ready"),
    );
    expectCatalogError(() => validateCatalog("probe", catalog), "catalog-keys");
    expect(() => validateCatalog("probe", catalog)).toThrow(
      /missing: shell\.status\.ready/,
    );
  });

  it("rejects an extra key instead of silently widening CatalogKey", () => {
    const catalog = { ...cloneDefault(), "invented.copy": "not canonical" };
    expectCatalogError(() => validateCatalog("probe", catalog), "catalog-keys");
    expect(() => validateCatalog("probe", catalog)).toThrow(/extra: invented\.copy/);
  });

  it.each(["", "   ", 42, false, null])("rejects invalid catalog value %j", (value) => {
    const catalog = cloneDefault();
    catalog["shell.status.ready"] = value;
    expectCatalogError(() => validateCatalog("probe", catalog), "catalog-value");
  });

  it("rejects unknown runtime keys rather than returning undefined", () => {
    expectCatalogError(() => t("en", "missing.runtime.key" as CatalogKey), "unknown-key");
  });

  it("keeps semantic view copy behind t()", () => {
    const app = readFileSync(join(APP_SOURCE, "App.tsx"), "utf8");
    const navigation = readFileSync(join(APP_SOURCE, "navigation.ts"), "utf8");
    expect(`${app}\n${navigation}`).not.toMatch(/\bcopy\s*\[/);
    expect(app).not.toMatch(/[\u4e00-\u9fff]/u);
    expect(app).not.toContain("Project Library");
    expect(app).not.toContain("Surface foundation ready");
  });
});
