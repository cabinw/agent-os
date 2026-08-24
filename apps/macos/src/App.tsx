import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./App.module.css";
import {
  ApprovalCenter,
  type ApprovalCenterViewModel,
  type ApprovalSurfaceClient,
} from "./ApprovalCenter.js";
import { Icon } from "./Icon.js";
import { ProjectLibraryView, type ProjectLibraryViewModel } from "./ProjectLibrary.js";
import { ProjectPulseView, type ProjectPulseViewModel } from "./Pulse.js";
import type { ConversationProjectViewModel } from "./Threads.js";
import { AgentsView, type ProjectWorkforceViewModel, TasksView } from "./Workforce.js";
import { type Locale, t } from "./i18n.js";
import {
  listenForMenuBarIntents,
  syncNativeMenuBar,
  toMenuBarPresentation,
} from "./menu-bar.js";
import {
  NAVIGATION,
  type RouteId,
  descriptionFor,
  labelFor,
  landingRoute,
} from "./navigation.js";

type Density = "comfortable" | "compact";

export function App({
  pulse = null,
  library = null,
  approvals = null,
  workforce = null,
  conversation = null,
  approvalClient,
}: Readonly<{
  pulse?: ProjectPulseViewModel | null;
  library?: ProjectLibraryViewModel | null;
  approvals?: ApprovalCenterViewModel | null;
  workforce?: ProjectWorkforceViewModel | null;
  conversation?: ConversationProjectViewModel | null;
  approvalClient?: ApprovalSurfaceClient;
}>) {
  const [locale, setLocale] = useState<Locale>("zh-CN");
  const [density, setDensity] = useState<Density>("comfortable");
  const [route, setRoute] = useState<RouteId>(() => landingRoute(false));
  const [approvalCenterOpen, setApprovalCenterOpen] = useState(false);
  const [approvalFocus, setApprovalFocus] = useState<string | null>(null);
  const menuView = useMemo(
    () => toMenuBarPresentation(approvals, pulse, approvalClient !== undefined),
    [approvals, pulse, approvalClient],
  );
  const menuViewRef = useRef(menuView);
  menuViewRef.current = menuView;

  useEffect(() => {
    void syncNativeMenuBar(menuView).catch(() => {});
  }, [menuView]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void listenForMenuBarIntents(
      () => menuViewRef.current,
      approvalClient,
      (approval) => {
        setApprovalFocus(approval);
        setApprovalCenterOpen(true);
      },
      (destination) => {
        if (destination === "pulse") setRoute("project-pulse");
      },
    )
      .then((unlisten) => {
        dispose = unlisten;
      })
      .catch(() => {});
    return () => dispose?.();
  }, [approvalClient]);
  const toggleLocale = () =>
    setLocale((current) => (current === "zh-CN" ? "en" : "zh-CN"));
  const toggleDensity = () =>
    setDensity((current) => (current === "comfortable" ? "compact" : "comfortable"));

  return (
    <div className={styles.app} data-density={density}>
      <aside className={styles.sidebar} aria-label={t(locale, "navigation.ariaLabel")}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            A
          </span>
          <strong>{t(locale, "app.name")}</strong>
        </div>

        <section
          className={styles.projectContext}
          aria-labelledby="project-context-title"
        >
          <span id="project-context-title" className={styles.eyebrow}>
            {t(locale, "project.context.label")}
          </span>
          <strong>{t(locale, "project.context.empty.title")}</strong>
          <p>{t(locale, "project.context.empty.detail")}</p>
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
          <span>{t(locale, "shell.livePending.title")}</span>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar}>
          <div>
            <span className={styles.eyebrow}>{t(locale, "shell.milestone")}</span>
            <h1>{labelFor(route, locale)}</h1>
          </div>
          <div className={styles.controls}>
            {approvals && approvals.pendingCount > 0 ? (
              <button
                type="button"
                className={styles.approvalTrigger}
                onClick={() => setApprovalCenterOpen(true)}
                aria-label={t(locale, "approval.open.ariaLabel")}
              >
                <span aria-hidden="true">●</span>
                {t(locale, "approval.pending.shortLabel")} · {approvals.pendingCount}
              </button>
            ) : null}
            <button
              type="button"
              onClick={toggleDensity}
              aria-label={t(locale, "density.switch.ariaLabel")}
            >
              {density === "comfortable"
                ? t(locale, "density.comfortable")
                : t(locale, "density.compact")}
            </button>
            <button
              type="button"
              onClick={toggleLocale}
              aria-label={t(locale, "language.switch.ariaLabel")}
            >
              {t(locale, "language.switch.shortLabel")}
            </button>
          </div>
        </header>

        {route === "project-pulse" ? (
          <ProjectPulseView pulse={pulse} locale={locale} />
        ) : route === "project-library" ? (
          <ProjectLibraryView library={library} locale={locale} />
        ) : route === "tasks" ? (
          <TasksView workforce={workforce} locale={locale} />
        ) : route === "agents" ? (
          <AgentsView workforce={workforce} conversation={conversation} locale={locale} />
        ) : (
          <div className={styles.content}>
            <section className={styles.hero}>
              <div className={styles.heroCopy}>
                <span className={styles.readyChip}>
                  {t(locale, "shell.status.ready")}
                </span>
                <h2>{t(locale, "shell.ready.title")}</h2>
                <p>{t(locale, "shell.ready.detail")}</p>
              </div>
              <div className={styles.routeSummary}>
                <span className={styles.eyebrow}>{labelFor(route, locale)}</span>
                <strong>{descriptionFor(route, locale)}</strong>
              </div>
            </section>

            <section aria-labelledby="foundation-title">
              <div className={styles.sectionHeading}>
                <div>
                  <span className={styles.eyebrow}>
                    {t(locale, "shell.foundation.milestone")}
                  </span>
                  <h2 id="foundation-title">{t(locale, "shell.foundation.title")}</h2>
                </div>
                <span className={styles.pendingChip}>
                  {t(locale, "shell.status.pending")}
                </span>
              </div>
              <div className={styles.foundationGrid}>
                {[
                  t(locale, "shell.foundation.nativeWindow"),
                  t(locale, "shell.foundation.navigation"),
                  t(locale, "shell.foundation.tokens"),
                ].map((title, index) => (
                  <article className={styles.foundationCard} key={title}>
                    <span className={styles.cardNumber}>
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <h3>{title}</h3>
                    <span className={styles.readyState}>
                      {t(locale, "shell.status.ready")}
                    </span>
                  </article>
                ))}
              </div>
            </section>

            <section className={styles.pendingSurface} aria-labelledby="pending-title">
              <div className={styles.pendingGlyph} aria-hidden="true">
                ◇
              </div>
              <div>
                <h2 id="pending-title">{t(locale, "shell.livePending.title")}</h2>
                <p>{t(locale, "shell.livePending.detail")}</p>
                <small>{t(locale, "shell.foundation.note")}</small>
              </div>
            </section>
          </div>
        )}
      </main>
      {approvalCenterOpen ? (
        <ApprovalCenter
          view={approvals}
          locale={locale}
          {...(approvalClient === undefined ? {} : { client: approvalClient })}
          {...(approvalFocus === null ? {} : { preferredApproval: approvalFocus })}
          onClose={() => {
            setApprovalCenterOpen(false);
            setApprovalFocus(null);
          }}
        />
      ) : null}
    </div>
  );
}
