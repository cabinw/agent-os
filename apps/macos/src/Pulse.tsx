import { useState } from "react";
import styles from "./Pulse.module.css";
import type { Locale } from "./i18n.js";
import { t } from "./i18n.js";

type Sourced = Readonly<{ sourceEvents: readonly string[] }>;
type Metric = Sourced & Readonly<{ value: number }>;
type KnowledgeKind =
  | "decision"
  | "research"
  | "technical-note"
  | "task-summary"
  | "milestone"
  | "discussion";

export type ProjectPulseViewModel = Readonly<{
  project: string;
  window: Readonly<{ startInclusive: string; endExclusive: string }>;
  kpis: Readonly<{
    activeAgents: Metric;
    activeTasks: Metric;
    doneToday: Metric;
    blockers: Metric;
  }>;
  topConsequence:
    | (Sourced &
        Readonly<{
          kind: "overdue-blocker" | "milestone" | "architecture-decision" | "progress";
          title: string;
          detail: string;
          actionable: boolean;
        }>)
    | null;
  story: (Sourced & Readonly<{ headline: string; body: string; at: string }>) | null;
  progress: readonly (Sourced &
    Readonly<{ task: string; title: string; progress: number; delta: number }>)[];
  activity: readonly (Sourced &
    Readonly<{
      event: string;
      type: string;
      actor: string;
      subject: string;
      at: string;
    }>)[];
  risks: readonly (Sourced &
    Readonly<{
      task: string;
      title: string;
      reason: string;
      severity: "low" | "medium" | "high" | "critical";
      needs: "human" | "agent" | "resource";
      since: string;
      overdue: boolean;
    }>)[];
  knowledge: readonly (Sourced &
    Readonly<{
      knowledge: string;
      title: string;
      summary: string;
      type: KnowledgeKind;
      at: string;
    }>)[];
  research: readonly (Sourced &
    Readonly<{
      knowledge: string;
      title: string;
      summary: string;
      type: KnowledgeKind;
      at: string;
    }>)[];
  moments: readonly (Sourced &
    Readonly<{
      metric: string;
      value: number;
      unit: string;
      source: string;
      at: string;
    }>)[];
}>;

type EvidenceSelection = Readonly<{ title: string; events: readonly string[] }>;

function EvidenceButton({
  locale,
  title,
  events,
  onSelect,
}: Readonly<{
  locale: Locale;
  title: string;
  events: readonly string[];
  onSelect: (selection: EvidenceSelection) => void;
}>) {
  if (events.length === 0) return null;
  return (
    <button
      type="button"
      className={styles.evidenceButton}
      onClick={() => onSelect({ title, events })}
    >
      {t(locale, "pulse.evidence.view")} · {events.length}
    </button>
  );
}

function EmptyCard({ locale }: Readonly<{ locale: Locale }>) {
  return <p className={styles.emptyCard}>{t(locale, "pulse.card.empty")}</p>;
}

export function ProjectPulseView({
  pulse,
  locale,
  onInspectEvent,
}: Readonly<{
  pulse: ProjectPulseViewModel | null;
  locale: Locale;
  onInspectEvent?: (eventId: string) => void;
}>) {
  const [evidence, setEvidence] = useState<EvidenceSelection | null>(null);

  if (pulse === null) {
    return (
      <section className={styles.unavailable} aria-labelledby="pulse-pending-title">
        <span className={styles.unavailableGlyph} aria-hidden="true">
          ◇
        </span>
        <div>
          <span className={styles.eyebrow}>{t(locale, "pulse.milestone")}</span>
          <h2 id="pulse-pending-title">{t(locale, "pulse.pending.title")}</h2>
          <p>{t(locale, "pulse.pending.detail")}</p>
        </div>
      </section>
    );
  }

  const kpis = [
    [t(locale, "pulse.kpi.activeAgents"), pulse.kpis.activeAgents],
    [t(locale, "pulse.kpi.activeTasks"), pulse.kpis.activeTasks],
    [t(locale, "pulse.kpi.doneToday"), pulse.kpis.doneToday],
    [t(locale, "pulse.kpi.blockers"), pulse.kpis.blockers],
  ] as const;
  const cardTitles = {
    progress: t(locale, "pulse.card.progress"),
    activity: t(locale, "pulse.card.activity"),
    risks: t(locale, "pulse.card.risks"),
    knowledge: t(locale, "pulse.card.knowledge"),
    research: t(locale, "pulse.card.research"),
    moments: t(locale, "pulse.card.moments"),
  };

  return (
    <div className={styles.pulse}>
      <section className={styles.pulseHeader} aria-labelledby="pulse-heading">
        <div>
          <span className={styles.eyebrow}>{t(locale, "pulse.milestone")}</span>
          <h2 id="pulse-heading">{t(locale, "pulse.title")}</h2>
          <p>
            {t(locale, "pulse.window.label")} · {pulse.window.startInclusive} —{" "}
            {pulse.window.endExclusive}
          </p>
        </div>
        <span className={styles.projectId}>{pulse.project}</span>
      </section>

      <section className={styles.kpiGrid} aria-label={t(locale, "pulse.kpi.ariaLabel")}>
        {kpis.map(([label, metric]) => {
          return (
            <article className={styles.kpiCard} key={label}>
              <span>{label}</span>
              <strong>{metric.value}</strong>
              <EvidenceButton
                locale={locale}
                title={label}
                events={metric.sourceEvents}
                onSelect={setEvidence}
              />
            </article>
          );
        })}
      </section>

      <section className={styles.storyGrid}>
        <article className={styles.story}>
          <span className={styles.eyebrow}>{t(locale, "pulse.story.label")}</span>
          {pulse.story ? (
            <>
              <h3>{pulse.story.headline}</h3>
              <p>{pulse.story.body}</p>
              <EvidenceButton
                locale={locale}
                title={pulse.story.headline}
                events={pulse.story.sourceEvents}
                onSelect={setEvidence}
              />
            </>
          ) : (
            <EmptyCard locale={locale} />
          )}
        </article>
        <article className={styles.attention}>
          <span className={styles.eyebrow}>{t(locale, "pulse.attention.label")}</span>
          {pulse.topConsequence ? (
            <>
              <h3>{pulse.topConsequence.title}</h3>
              <p>{pulse.topConsequence.detail}</p>
              <EvidenceButton
                locale={locale}
                title={pulse.topConsequence.title}
                events={pulse.topConsequence.sourceEvents}
                onSelect={setEvidence}
              />
            </>
          ) : (
            <EmptyCard locale={locale} />
          )}
        </article>
      </section>

      <section
        className={styles.cardGrid}
        aria-label={t(locale, "pulse.cards.ariaLabel")}
      >
        <article className={styles.detailCard}>
          <h3>{cardTitles.progress}</h3>
          {pulse.progress.length === 0 ? (
            <EmptyCard locale={locale} />
          ) : (
            pulse.progress.map((item) => (
              <div className={styles.item} key={`${item.task}-${item.progress}`}>
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {item.progress}% · +{item.delta}
                  </span>
                </div>
                <EvidenceButton
                  locale={locale}
                  title={item.title}
                  events={item.sourceEvents}
                  onSelect={setEvidence}
                />
              </div>
            ))
          )}
        </article>

        <article className={styles.detailCard}>
          <h3>{cardTitles.activity}</h3>
          {pulse.activity.length === 0 ? (
            <EmptyCard locale={locale} />
          ) : (
            pulse.activity.map((item) => (
              <div className={styles.item} key={item.event}>
                <div>
                  <strong>{item.type}</strong>
                  <span>
                    {item.actor} → {item.subject}
                  </span>
                </div>
                <EvidenceButton
                  locale={locale}
                  title={item.type}
                  events={item.sourceEvents}
                  onSelect={setEvidence}
                />
              </div>
            ))
          )}
        </article>

        <article className={styles.detailCard}>
          <h3>{cardTitles.risks}</h3>
          {pulse.risks.length === 0 ? (
            <EmptyCard locale={locale} />
          ) : (
            pulse.risks.map((item) => (
              <div className={styles.item} key={item.task}>
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {item.severity} · {item.needs} · {item.reason}
                  </span>
                </div>
                <EvidenceButton
                  locale={locale}
                  title={item.title}
                  events={item.sourceEvents}
                  onSelect={setEvidence}
                />
              </div>
            ))
          )}
        </article>

        <article className={styles.detailCard}>
          <h3>{cardTitles.knowledge}</h3>
          {pulse.knowledge.length === 0 ? (
            <EmptyCard locale={locale} />
          ) : (
            pulse.knowledge.map((item) => (
              <div className={styles.item} key={item.knowledge}>
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.summary}</span>
                </div>
                <EvidenceButton
                  locale={locale}
                  title={item.title}
                  events={item.sourceEvents}
                  onSelect={setEvidence}
                />
              </div>
            ))
          )}
        </article>

        <article className={styles.detailCard}>
          <h3>{cardTitles.research}</h3>
          {pulse.research.length === 0 ? (
            <EmptyCard locale={locale} />
          ) : (
            pulse.research.map((item) => (
              <div className={styles.item} key={item.knowledge}>
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.summary}</span>
                </div>
                <EvidenceButton
                  locale={locale}
                  title={item.title}
                  events={item.sourceEvents}
                  onSelect={setEvidence}
                />
              </div>
            ))
          )}
        </article>

        <article className={styles.detailCard}>
          <h3>{cardTitles.moments}</h3>
          {pulse.moments.length === 0 ? (
            <EmptyCard locale={locale} />
          ) : (
            pulse.moments.map((item) => (
              <div className={styles.item} key={`${item.metric}-${item.at}`}>
                <div>
                  <strong>{item.metric}</strong>
                  <span>
                    {item.value} {item.unit} · {item.source}
                  </span>
                </div>
                <EvidenceButton
                  locale={locale}
                  title={item.metric}
                  events={item.sourceEvents}
                  onSelect={setEvidence}
                />
              </div>
            ))
          )}
        </article>
      </section>

      {evidence ? (
        <aside className={styles.evidencePanel} aria-labelledby="evidence-title">
          <div className={styles.evidenceHeading}>
            <div>
              <span className={styles.eyebrow}>{t(locale, "pulse.evidence.label")}</span>
              <h3 id="evidence-title">{evidence.title}</h3>
            </div>
            <button
              type="button"
              onClick={() => setEvidence(null)}
              aria-label={t(locale, "pulse.evidence.close")}
            >
              ×
            </button>
          </div>
          <ol>
            {evidence.events.map((eventId) => (
              <li key={eventId}>
                <button type="button" onClick={() => onInspectEvent?.(eventId)}>
                  {eventId}
                </button>
              </li>
            ))}
          </ol>
        </aside>
      ) : null}
    </div>
  );
}
