import enSource from "./locales/en.json";
import zhCNSource from "./locales/zh-CN.json";

export const LOCALES = ["zh-CN", "en"] as const;
export const DEFAULT_LOCALE = "zh-CN" as const;

export type Locale = (typeof LOCALES)[number];
export type CatalogKey = keyof typeof zhCNSource;
export type Catalog = Readonly<Record<CatalogKey, string>>;
export type Translate = (key: CatalogKey) => string;
export type I18nErrorCode =
  | "catalog-invalid"
  | "catalog-keys"
  | "catalog-value"
  | "unknown-key";

export class I18nCatalogError extends Error {
  readonly code: I18nErrorCode;
  readonly locale: string;

  constructor(code: I18nErrorCode, locale: string, detail: string) {
    super(`i18n ${locale}: ${detail}`);
    this.name = "I18nCatalogError";
    this.code = code;
    this.locale = locale;
  }
}

export const CATALOG_KEYS = Object.freeze(Object.keys(zhCNSource).sort() as CatalogKey[]);

function recordFrom(source: unknown, locale: string): Record<string, unknown> {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new I18nCatalogError("catalog-invalid", locale, "catalog must be an object");
  }
  return source as Record<string, unknown>;
}

export function validateCatalog(locale: string, source: unknown): Catalog {
  const record = recordFrom(source, locale);
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...CATALOG_KEYS];
  const missing = expectedKeys.filter((key) => !Object.hasOwn(record, key));
  const extra = actualKeys.filter((key) => !Object.hasOwn(zhCNSource, key));

  if (missing.length > 0 || extra.length > 0) {
    throw new I18nCatalogError(
      "catalog-keys",
      locale,
      `key mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }

  const entries = expectedKeys.map((key) => {
    const value = record[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new I18nCatalogError(
        "catalog-value",
        locale,
        `${key} must be a non-empty string`,
      );
    }
    return [key, value] as const;
  });

  return Object.freeze(Object.fromEntries(entries)) as Catalog;
}

export const CATALOGS: Readonly<Record<Locale, Catalog>> = Object.freeze({
  "zh-CN": validateCatalog("zh-CN", zhCNSource),
  en: validateCatalog("en", enSource),
});

export function resolveLocale(input: unknown): Locale {
  if (typeof input !== "string") return DEFAULT_LOCALE;
  const normalized = input.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  return DEFAULT_LOCALE;
}

export function t(locale: Locale, key: CatalogKey): string {
  const value = (CATALOGS[locale] as Readonly<Record<string, unknown>>)[key];
  if (typeof value !== "string") {
    throw new I18nCatalogError("unknown-key", locale, `unknown key ${String(key)}`);
  }
  return value;
}

export function translatorFor(locale: Locale): Translate {
  return (key) => t(locale, key);
}
