# ADR-026: UI Copy Comes Only From Typed JSON Catalogs

Status: accepted

## Context

The product is bilingual from day one. RM-3.1 externalized shell copy into a
TypeScript object, but the canonical implementation stack requires typed JSON
catalogs and `t()`. Direct object access lets views bypass one translation
boundary and does not prove that locale catalogs have identical keys.

Seven product surfaces do not justify a framework dependency. Locale selection
is local view state, not event-derived project state.

## Decision

`apps/macos/src/locales/zh-CN.json` is the compile-time key authority. Catalogs
are flat string maps; `CatalogKey` is `keyof` that imported JSON object. The
English catalog must contain exactly the same keys. Catalog admission rejects
missing keys, extra keys, non-string values and empty strings before any copy is
read.

All view and navigation copy passes through:

```
t(locale, key) -> string
```

The key is typed for application callers. The runtime boundary still rejects an
unknown key so JavaScript and deserialized callers cannot observe `undefined`.
Validated catalogs are copied and frozen; imported JSON objects are never
exposed for mutation.

Supported locales are exactly `zh-CN` and `en`. Locale resolution maps `zh` and
`zh-*` to `zh-CN`, maps `en` and `en-*` to `en`, and falls back to `zh-CN` for
missing, malformed or unsupported input. It does not perform per-key cross-
locale fallback: catalog admission makes a missing translation a build failure,
not a mixed-language runtime state.

The shell may hold the selected locale in React local state. Locale changes do
not write domain events and do not introduce Redux, Zustand or an i18n service.
Semantic copy, accessible names and short language-switch labels all use `t()`.
Brand glyphs, numeric ordinals and decorative symbols are not catalog copy.

## Alternatives

**Keep a typed TypeScript object.** Rejected: it contradicts the chosen stack
and makes catalogs executable source rather than portable translation assets.

**Use i18next.** Rejected: two static locales and a small typed API do not need
plugin loading, interpolation or network backends.

**Fall back per missing key.** Rejected: it hides incomplete catalogs and makes
one screen silently bilingual. Invalid catalogs fail closed instead.

**Derive locale from project events.** Rejected: locale is a local presentation
preference and not project truth.

## Consequences

- Every later surface receives compile-time key completion and runtime catalog
  parity from its first copy change.
- Translation files remain portable JSON and contain no functions or state.
- Unsupported system locales render deterministic Chinese copy until the user
  switches language.
- Adding a locale requires a complete catalog and explicit `Locale` expansion.
