import { useMemo, useState } from "react";
import styles from "./ApprovalCenter.module.css";
import type { Locale } from "./i18n.js";
import { t } from "./i18n.js";

export type ApprovalSurfaceIntent =
  | Readonly<{ surface: "app"; action: "grant"; approval: string; note?: string }>
  | Readonly<{
      surface: "app";
      action: "reject";
      approval: string;
      reason: string;
    }>;

export interface ApprovalSurfaceClient {
  decide(intent: ApprovalSurfaceIntent): void | Promise<void>;
}

type ApprovalDecision =
  | Readonly<{ status: "granted"; by: string; note?: string; at: string }>
  | Readonly<{ status: "rejected"; by: string; reason: string; at: string }>
  | Readonly<{ status: "expired"; after: string; at: string }>;

export type ApprovalCenterItemViewModel = Readonly<{
  approval: string;
  project: string;
  status: "pending" | "granted" | "rejected" | "expired";
  action: string;
  detail: string;
  risk: "low" | "medium" | "high" | "critical";
  reversible: boolean;
  requestedBy: string;
  task?: string;
  requestedAt: string;
  decision?: ApprovalDecision;
  menuAction: "quick-decision" | "review-in-app" | "none";
  sourceEvents: readonly string[];
}>;

export type ApprovalCenterViewModel = Readonly<{
  project: string;
  icon: "normal" | "attention" | "waiting";
  pendingCount: number;
  blockerCount: number;
  approvals: readonly ApprovalCenterItemViewModel[];
}>;

type RejectEditor = Readonly<{ approval: string; reason: string }>;

function statusLabel(locale: Locale, status: ApprovalCenterItemViewModel["status"]) {
  return t(locale, `approval.status.${status}`);
}

function riskLabel(locale: Locale, risk: ApprovalCenterItemViewModel["risk"]) {
  return t(locale, `approval.risk.${risk}`);
}

export function ApprovalCenter({
  view,
  locale,
  client,
  preferredApproval,
  onClose,
  onInspectEvent,
}: Readonly<{
  view: ApprovalCenterViewModel | null;
  locale: Locale;
  client?: ApprovalSurfaceClient;
  preferredApproval?: string;
  onClose: () => void;
  onInspectEvent?: (eventId: string) => void;
}>) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rejectEditor, setRejectEditor] = useState<RejectEditor | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useMemo(
    () => view?.approvals.filter((approval) => approval.status === "pending") ?? [],
    [view],
  );
  const selected =
    pending.find((approval) => approval.approval === (selectedId ?? preferredApproval)) ??
    pending[0];

  const decide = async (intent: ApprovalSurfaceIntent) => {
    if (client === undefined) return;
    setSubmitting(intent.approval);
    setError(null);
    try {
      await client.decide(intent);
      setRejectEditor(null);
    } catch {
      setError(t(locale, "approval.error.decisionFailed"));
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className={styles.backdrop} role="presentation">
      <dialog
        open
        className={styles.center}
        aria-modal="true"
        aria-labelledby="approval-center-title"
      >
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>{t(locale, "approval.milestone")}</span>
            <h2 id="approval-center-title">{t(locale, "approval.title")}</h2>
            <p>{t(locale, "approval.subtitle")}</p>
          </div>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label={t(locale, "approval.close")}
          >
            ×
          </button>
        </header>

        {view === null ? (
          <div className={styles.emptyState}>
            <strong>{t(locale, "approval.pendingProjection.title")}</strong>
            <p>{t(locale, "approval.pendingProjection.detail")}</p>
          </div>
        ) : pending.length === 0 ? (
          <div className={styles.emptyState}>
            <strong>{t(locale, "approval.empty.title")}</strong>
            <p>{t(locale, "approval.empty.detail")}</p>
          </div>
        ) : (
          <div className={styles.layout}>
            <aside
              className={styles.list}
              aria-label={t(locale, "approval.list.ariaLabel")}
            >
              <div className={styles.listHeading}>
                <span>{t(locale, "approval.pending.label")}</span>
                <strong>{view.pendingCount}</strong>
              </div>
              {pending.map((approval) => (
                <button
                  type="button"
                  key={approval.approval}
                  className={styles.listItem}
                  aria-current={
                    approval.approval === selected?.approval ? "true" : undefined
                  }
                  onClick={() => {
                    setSelectedId(approval.approval);
                    setRejectEditor(null);
                    setError(null);
                  }}
                >
                  <strong>{approval.action}</strong>
                  <span>{approval.requestedBy}</span>
                  <small data-risk={approval.risk}>
                    {riskLabel(locale, approval.risk)}
                  </small>
                </button>
              ))}
            </aside>

            {selected ? (
              <article className={styles.detail}>
                <div className={styles.detailHeading}>
                  <div>
                    <span className={styles.statusChip} data-status={selected.status}>
                      {statusLabel(locale, selected.status)}
                    </span>
                    <h3>{selected.action}</h3>
                  </div>
                  <span className={styles.approvalId}>{selected.approval}</span>
                </div>

                <dl className={styles.disclosure}>
                  <div className={styles.fullRow}>
                    <dt>{t(locale, "approval.field.detail")}</dt>
                    <dd>{selected.detail}</dd>
                  </div>
                  <div>
                    <dt>{t(locale, "approval.field.risk")}</dt>
                    <dd>{riskLabel(locale, selected.risk)}</dd>
                  </div>
                  <div>
                    <dt>{t(locale, "approval.field.reversible")}</dt>
                    <dd>
                      {selected.reversible
                        ? t(locale, "approval.value.yes")
                        : t(locale, "approval.value.no")}
                    </dd>
                  </div>
                  <div>
                    <dt>{t(locale, "approval.field.requestedBy")}</dt>
                    <dd>{selected.requestedBy}</dd>
                  </div>
                  <div>
                    <dt>{t(locale, "approval.field.task")}</dt>
                    <dd>{selected.task ?? t(locale, "approval.value.projectScoped")}</dd>
                  </div>
                  <div>
                    <dt>{t(locale, "approval.field.requestedAt")}</dt>
                    <dd>{selected.requestedAt}</dd>
                  </div>
                  <div>
                    <dt>{t(locale, "approval.field.menuPolicy")}</dt>
                    <dd>
                      {selected.menuAction === "quick-decision"
                        ? t(locale, "approval.menu.quickAllowed")
                        : t(locale, "approval.menu.appRequired")}
                    </dd>
                  </div>
                </dl>

                <section
                  className={styles.evidence}
                  aria-labelledby="approval-evidence-title"
                >
                  <h4 id="approval-evidence-title">
                    {t(locale, "approval.evidence.title")}
                  </h4>
                  <div>
                    {selected.sourceEvents.map((eventId) => (
                      <button
                        type="button"
                        key={eventId}
                        onClick={() => onInspectEvent?.(eventId)}
                      >
                        {eventId}
                      </button>
                    ))}
                  </div>
                </section>

                {client === undefined ? (
                  <p className={styles.clientPending}>
                    {t(locale, "approval.client.pending")}
                  </p>
                ) : rejectEditor?.approval === selected.approval ? (
                  <form
                    className={styles.rejectEditor}
                    onSubmit={(event) => {
                      event.preventDefault();
                      const reason = rejectEditor.reason.trim();
                      if (reason.length === 0) return;
                      void decide({
                        surface: "app",
                        action: "reject",
                        approval: selected.approval,
                        reason,
                      });
                    }}
                  >
                    <label htmlFor="approval-rejection-reason">
                      {t(locale, "approval.reject.reasonLabel")}
                    </label>
                    <textarea
                      id="approval-rejection-reason"
                      value={rejectEditor.reason}
                      onChange={(event) =>
                        setRejectEditor({
                          approval: selected.approval,
                          reason: event.currentTarget.value,
                        })
                      }
                      placeholder={t(locale, "approval.reject.reasonPlaceholder")}
                    />
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => setRejectEditor(null)}
                      >
                        {t(locale, "approval.action.cancel")}
                      </button>
                      <button
                        type="submit"
                        className={styles.rejectButton}
                        disabled={
                          rejectEditor.reason.trim().length === 0 || submitting !== null
                        }
                      >
                        {t(locale, "approval.action.confirmReject")}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.rejectButton}
                      onClick={() =>
                        setRejectEditor({ approval: selected.approval, reason: "" })
                      }
                      disabled={submitting !== null}
                    >
                      {t(locale, "approval.action.reject")}
                    </button>
                    <button
                      type="button"
                      className={styles.grantButton}
                      onClick={() =>
                        void decide({
                          surface: "app",
                          action: "grant",
                          approval: selected.approval,
                        })
                      }
                      disabled={submitting !== null}
                    >
                      {t(locale, "approval.action.grant")}
                    </button>
                  </div>
                )}
                {error ? <p className={styles.error}>{error}</p> : null}
              </article>
            ) : null}
          </div>
        )}
      </dialog>
    </div>
  );
}
