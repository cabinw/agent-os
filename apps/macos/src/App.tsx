import { useState } from "react";
import styles from "./App.module.css";
import { Icon } from "./Icon.js";
import { type Locale, copy } from "./i18n.js";
import {
  NAVIGATION,
  type RouteId,
  descriptionFor,
  labelFor,
  landingRoute,
} from "./navigation.js";

type Density = "comfortable" | "compact";

export function App() {
  const [locale, setLocale] = useState<Locale>("zh-CN");
  const [density, setDensity] = useState<Density>("comfortable");
  const [route, setRoute] = useState<RouteId>(() => landingRoute(false));
  const text = copy[locale];

  const toggleLocale = () =>
    setLocale((current) => (current === "zh-CN" ? "en" : "zh-CN"));
  const toggleDensity = () =>
    setDensity((current) => (current === "comfortable" ? "compact" : "comfortable"));

  return (
    <div className={styles.app} data-density={density}>
      <aside
        className={styles.sidebar}
        aria-label={locale === "zh-CN" ? "主导航" : "Main navigation"}
      >
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            A
          </span>
          <strong>{text.appName}</strong>
        </div>

        <section
          className={styles.projectContext}
          aria-labelledby="project-context-title"
        >
          <span id="project-context-title" className={styles.eyebrow}>
            {text.projectContext}
          </span>
          <strong>{text.noProject}</strong>
          <p>{text.noProjectDetail}</p>
        </section>

        <nav className={styles.navigation}>
          {NAVIGATION.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.navItem}
              aria-current={route === item.id ? "page" : undefined}
              onClick={() => setRoute(item.id)}
            >
              <Icon name={item.icon} />
              <span>{labelFor(item.id, locale)}</span>
            </button>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <span className={styles.connectionDot} aria-hidden="true" />
          <span>{text.livePending}</span>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar}>
          <div>
            <span className={styles.eyebrow}>Agent OS · RM-3.1</span>
            <h1>{labelFor(route, locale)}</h1>
          </div>
          <div className={styles.controls}>
            <button type="button" onClick={toggleDensity} aria-label={text.switchDensity}>
              {density === "comfortable" ? text.comfortable : text.compact}
            </button>
            <button type="button" onClick={toggleLocale} aria-label={text.switchLanguage}>
              {locale === "zh-CN" ? "EN" : "中文"}
            </button>
          </div>
        </header>

        <div className={styles.content}>
          <section className={styles.hero}>
            <div className={styles.heroCopy}>
              <span className={styles.readyChip}>{text.statusReady}</span>
              <h2>{text.shellReady}</h2>
              <p>{text.shellReadyDetail}</p>
            </div>
            <div className={styles.routeSummary}>
              <span className={styles.eyebrow}>{labelFor(route, locale)}</span>
              <strong>{descriptionFor(route, locale)}</strong>
            </div>
          </section>

          <section aria-labelledby="foundation-title">
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>RM-3.1</span>
                <h2 id="foundation-title">{text.currentFoundation}</h2>
              </div>
              <span className={styles.pendingChip}>{text.statusPending}</span>
            </div>
            <div className={styles.foundationGrid}>
              {[text.nativeWindow, text.canonicalNavigation, text.designTokens].map(
                (title, index) => (
                  <article className={styles.foundationCard} key={title}>
                    <span className={styles.cardNumber}>
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <h3>{title}</h3>
                    <span className={styles.readyState}>{text.statusReady}</span>
                  </article>
                ),
              )}
            </div>
          </section>

          <section className={styles.pendingSurface} aria-labelledby="pending-title">
            <div className={styles.pendingGlyph} aria-hidden="true">
              ◇
            </div>
            <div>
              <h2 id="pending-title">{text.livePending}</h2>
              <p>{text.livePendingDetail}</p>
              <small>{text.foundationNote}</small>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
