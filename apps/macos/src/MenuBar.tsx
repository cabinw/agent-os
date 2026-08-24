import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import styles from "./MenuBar.module.css";
import type { Locale } from "./i18n.js";
import { t } from "./i18n.js";
import type { MenuBarIntent, MenuBarPresentation } from "./menu-bar.js";

const EMPTY: MenuBarPresentation = Object.freeze({
  icon: "normal",
  project: null,
  activeAgents: 0,
  activeTasks: 0,
  blockerCount: 0,
  pendingCount: 0,
  decisionsEnabled: false,
  approvals: [],
});

async function submit(intent: MenuBarIntent): Promise<void> {
  if (!isTauri()) return;
  await invoke("submit_menu_intent", { intent });
}

export function MenuBarPanel({
  initialView = EMPTY,
  locale = "zh-CN",
}: Readonly<{ initialView?: MenuBarPresentation; locale?: Locale }>) {
  const [view, setView] = useState(initialView);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void listen<MenuBarPresentation>("agent-os://menu-view", (event) => {
      setView(event.payload);
      setRejecting(null);
      setReason("");
    })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(() => {});
    void invoke<MenuBarPresentation>("get_menu_bar")
      .then(setView)
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  return (
    <main className={styles.panel}>
      <header className={styles.header}>
        <div>
          <span className={styles.mark}>A</span>
          <strong>{t(locale, "app.name")}</strong>
        </div>
        <span data-icon={view.icon}>{t(locale, `menu.status.${view.icon}`)}</span>
      </header>
      {view.project ? (
        <section className={styles.project}>
          <small>{t(locale, "menu.project")}</small>
          <strong>{view.project}</strong>
        </section>
      ) : null}
      <section
        className={styles.metrics}
        aria-label={t(locale, "menu.metrics.ariaLabel")}
      >
        <div>
          <strong>{view.activeAgents}</strong>
          <span>{t(locale, "menu.metric.agents")}</span>
        </div>
        <div>
          <strong>{view.activeTasks}</strong>
          <span>{t(locale, "menu.metric.tasks")}</span>
        </div>
        <div>
          <strong>{view.blockerCount}</strong>
          <span>{t(locale, "menu.metric.blockers")}</span>
        </div>
      </section>
      {view.approvals.length > 0 ? (
        <section className={styles.approvals} aria-labelledby="menu-approvals-title">
          <div className={styles.sectionHeading}>
            <h2 id="menu-approvals-title">{t(locale, "menu.approvals")}</h2>
            <strong>{view.pendingCount}</strong>
          </div>
          {view.approvals.map((approval) => (
            <article key={approval.approval}>
              <div className={styles.approvalCopy}>
                <strong>{approval.action}</strong>
                <span>
                  {approval.requestedBy} · {t(locale, `approval.risk.${approval.risk}`)}
                </span>
              </div>
              {approval.menuAction === "review-in-app" ? (
                <button
                  type="button"
                  onClick={() =>
                    void submit({ action: "review-in-app", approval: approval.approval })
                  }
                >
                  {t(locale, "menu.reviewInApp")}
                </button>
              ) : rejecting === approval.approval ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const admitted = reason.trim();
                    if (admitted.length === 0) return;
                    void submit({
                      action: "reject",
                      approval: approval.approval,
                      reason: admitted,
                    });
                  }}
                >
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.currentTarget.value)}
                    aria-label={t(locale, "approval.reject.reasonLabel")}
                    placeholder={t(locale, "approval.reject.reasonPlaceholder")}
                  />
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        setRejecting(null);
                        setReason("");
                      }}
                    >
                      {t(locale, "approval.action.cancel")}
                    </button>
                    <button type="submit" disabled={reason.trim().length === 0}>
                      {t(locale, "approval.action.confirmReject")}
                    </button>
                  </div>
                </form>
              ) : (
                <div className={styles.quickActions}>
                  <button
                    type="button"
                    disabled={!view.decisionsEnabled}
                    onClick={() => {
                      setRejecting(approval.approval);
                      setReason("");
                    }}
                  >
                    {t(locale, "approval.action.reject")}
                  </button>
                  <button
                    type="button"
                    disabled={!view.decisionsEnabled}
                    onClick={() =>
                      void submit({ action: "grant", approval: approval.approval })
                    }
                  >
                    {t(locale, "approval.action.grant")}
                  </button>
                </div>
              )}
            </article>
          ))}
        </section>
      ) : null}
      <footer className={styles.footer}>
        <button type="button" onClick={() => void submit({ action: "open-pulse" })}>
          {t(locale, "menu.openPulse")}
        </button>
        <button type="button" onClick={() => void submit({ action: "open-app" })}>
          {t(locale, "menu.openApp")}
        </button>
      </footer>
    </main>
  );
}
