import { useMemo, useState } from "react";
import styles from "./ProjectLibrary.module.css";
import type { Locale } from "./i18n.js";
import { t } from "./i18n.js";

type Source = Readonly<{ sourceEvents: readonly string[] }>;
type ProjectState = "active" | "paused" | "archived" | "completed";
type DetailTab = "overview" | "timeline" | "memory" | "files" | "settings";

type RevivalTaskViewModel = Source &
  Readonly<{
    task: string;
    title: string;
    status: string;
    priority: "low" | "medium" | "high" | "critical";
  }>;

export type ProjectLibraryItemViewModel = Readonly<{
  project: string;
  name: string;
  state: ProjectState;
  stack: readonly string[];
  progress: number;
  currentWork:
    | (Source &
        Readonly<{
          task: string;
          title: string;
          status: string;
          priority: "low" | "medium" | "high" | "critical";
        }>)
    | null;
  health: Source & Readonly<{ status: "healthy" | "attention" | "blocked" }>;
  summary: (Source & Readonly<{ text: string }>) | null;
  agents: readonly (Source &
    Readonly<{
      id: string;
      name: string;
      status: "idle" | "working" | "waiting" | "blocked";
    }>)[];
  lastActivity: Source & Readonly<{ at: string; actor: string; type: string }>;
  dormantDays: number;
  revival?: Readonly<{
    built: readonly RevivalTaskViewModel[];
    current: Source &
      Readonly<{
        state: ProjectState;
        progress: number;
        health: "healthy" | "attention" | "blocked";
      }>;
    decisions: readonly ProjectLibraryItemViewModel["knowledge"][number][];
    unfinished: readonly RevivalTaskViewModel[];
    issues: readonly (Source &
      Readonly<{
        task: string;
        title: string;
        kind: "blocked" | "failed";
        reason: string;
      }>)[];
    plan: readonly ProjectLibraryItemViewModel["nextSteps"][number][];
  }> | null;
  snapshots: readonly (Source & Readonly<{ label: string; image: string; at: string }>)[];
  nextSteps: readonly (Source &
    Readonly<{ title: string; estimateMinutes: number; detail: string }>)[];
  timeline: readonly (Source &
    Readonly<{
      event: string;
      type: string;
      actor: string;
      subject: string;
      at: string;
    }>)[];
  knowledge: readonly (Source &
    Readonly<{
      knowledge: string;
      type: string;
      title: string;
      summary: string;
      rationale?: string;
      at: string;
    }>)[];
  files: readonly (Source &
    Readonly<{ path: string; kind: string; task?: string; at: string }>)[];
}>;

export type RevivalStepActivationIntent = Readonly<{
  project: string;
  ordinal: number;
  executor: string;
  title: string;
  estimateMinutes: number;
  detail: string;
}>;

export interface RevivalStepClient {
  createAndAssignStep(intent: RevivalStepActivationIntent): Promise<void>;
}

export function createRevivalStepActivationIntent(
  project: ProjectLibraryItemViewModel,
  ordinal: number,
): RevivalStepActivationIntent {
  const step = project.revival?.plan[ordinal];
  const executor = project.agents[0]?.id;
  if (step === undefined || executor === undefined) {
    throw new TypeError("revival step and connected executor are required");
  }
  return Object.freeze({
    project: project.project,
    ordinal: ordinal + 1,
    executor,
    title: step.title,
    estimateMinutes: step.estimateMinutes,
    detail: step.detail,
  });
}

export type ProjectLibraryViewModel = Readonly<{
  now: string;
  counts: Readonly<Record<"all" | ProjectState, number>>;
  projects: readonly ProjectLibraryItemViewModel[];
  insights: null;
}>;

const FILTERS = ["all", "active", "paused", "archived", "completed"] as const;
const TABS = ["overview", "timeline", "memory", "files", "settings"] as const;

function relativeTime(locale: Locale, now: string, at: string): string {
  const milliseconds = Math.max(0, Date.parse(now) - Date.parse(at));
  const hours = Math.floor(milliseconds / 3_600_000);
  if (hours === 0) return t(locale, "library.time.justNow");
  if (hours < 24) return `${hours} ${t(locale, "library.time.hoursAgo")}`;
  return `${Math.floor(hours / 24)} ${t(locale, "library.time.daysAgo")}`;
}

function Evidence({
  events,
  locale,
  onInspect,
}: Readonly<{
  events: readonly string[];
  locale: Locale;
  onInspect: ((event: string) => void) | undefined;
}>) {
  if (events.length === 0) return null;
  return (
    <button
      type="button"
      className={styles.evidence}
      onClick={() => onInspect?.(events[0] as string)}
    >
      {t(locale, "library.evidence")} · {events.length}
    </button>
  );
}

function Empty({ children }: Readonly<{ children: string }>) {
  return <p className={styles.empty}>{children}</p>;
}

export function ProjectDetailPanel({
  project,
  now,
  locale,
  onClose,
  onInspectEvent,
  onOpenProject,
  revivalStepClient,
}: Readonly<{
  project: ProjectLibraryItemViewModel;
  now: string;
  locale: Locale;
  onClose: () => void;
  onInspectEvent?: (event: string) => void;
  onOpenProject?: (project: string) => void;
  revivalStepClient?: RevivalStepClient;
}>) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [activatingStep, setActivatingStep] = useState<number | null>(null);
  const [activationFailed, setActivationFailed] = useState(false);
  const decisions = project.knowledge.filter((item) => item.type === "decision");

  return (
    <aside className={styles.drawer} aria-labelledby="project-detail-title">
      <header className={styles.drawerHeader}>
        <div>
          <span data-state={project.state} className={styles.stateBadge}>
            {t(locale, `library.state.${project.state}`)}
          </span>
          <h2 id="project-detail-title">{project.name}</h2>
          <small>{project.project}</small>
        </div>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label={t(locale, "library.detail.close")}
        >
          ×
        </button>
      </header>
      <nav
        className={styles.tabs}
        aria-label={t(locale, "library.detail.tabs.ariaLabel")}
      >
        {TABS.map((item) => (
          <button
            type="button"
            key={item}
            aria-current={tab === item ? "page" : undefined}
            onClick={() => setTab(item)}
          >
            {t(locale, `library.detail.tab.${item}`)}
          </button>
        ))}
      </nav>
      <div className={styles.drawerBody}>
        {tab === "overview" ? (
          <div className={styles.overview}>
            <section className={styles.snapshotCard}>
              <div className={styles.sectionTitle}>
                <h3>{t(locale, "library.overview.snapshot")}</h3>
                <span data-health={project.health.status}>
                  {t(locale, `library.health.${project.health.status}`)}
                </span>
              </div>
              <strong>{project.progress}%</strong>
              <div className={styles.progress} aria-label={`${project.progress}%`}>
                <span style={{ width: `${project.progress}%` }} />
              </div>
              <dl className={styles.snapshotFacts}>
                <div>
                  <dt>{t(locale, "library.field.lastActivity")}</dt>
                  <dd>{relativeTime(locale, now, project.lastActivity.at)}</dd>
                </div>
                <div>
                  <dt>{t(locale, "library.field.agents")}</dt>
                  <dd>{project.agents.length}</dd>
                </div>
              </dl>
            </section>
            <section>
              <h3>{t(locale, "library.overview.brief")}</h3>
              {project.summary ? (
                <>
                  <p>{project.summary.text}</p>
                  <Evidence
                    events={project.summary.sourceEvents}
                    locale={locale}
                    onInspect={onInspectEvent}
                  />
                </>
              ) : (
                <Empty>{t(locale, "library.overview.brief.empty")}</Empty>
              )}
            </section>
            {project.revival ? (
              <section className={styles.revival}>
                <header>
                  <span>✦</span>
                  <div>
                    <h3>{t(locale, "library.overview.revival")}</h3>
                    <p>
                      {project.dormantDays} {t(locale, "library.time.daysDormant")}
                    </p>
                  </div>
                </header>
                <div className={styles.revivalStats}>
                  <span>
                    {t(locale, "library.revival.built")}{" "}
                    <strong>{project.revival.built.length}</strong>
                  </span>
                  <span>
                    {t(locale, "library.revival.unfinished")}{" "}
                    <strong>{project.revival.unfinished.length}</strong>
                  </span>
                  <span>
                    {t(locale, "library.revival.issues")}{" "}
                    <strong>{project.revival.issues.length}</strong>
                  </span>
                  <span>
                    {t(locale, "library.revival.decisions")}{" "}
                    <strong>{project.revival.decisions.length}</strong>
                  </span>
                </div>
                <p className={styles.revivalCurrent}>
                  {t(locale, "library.revival.current")} ·{" "}
                  {project.revival.current.progress}% ·{" "}
                  {t(locale, `library.health.${project.revival.current.health}`)}
                </p>
                {project.revival.issues.map((issue) => (
                  <p className={styles.revivalIssue} key={`${issue.task}-${issue.kind}`}>
                    <strong>{issue.title}</strong> · {issue.reason}
                  </p>
                ))}
                <h4>{t(locale, "library.revival.plan")}</h4>
                {project.revival.plan.length === 0 ? (
                  <Empty>{t(locale, "library.overview.nextSteps.empty")}</Empty>
                ) : (
                  <ol className={styles.revivalPlan}>
                    {project.revival.plan.map((step, index) => (
                      <li key={`${index}-${step.title}`}>
                        <div>
                          <strong>{step.title}</strong>
                          <span>
                            {step.estimateMinutes} {t(locale, "library.time.minutes")}
                          </span>
                          <p>{step.detail}</p>
                        </div>
                        <button
                          type="button"
                          disabled={
                            revivalStepClient === undefined ||
                            project.agents.length === 0 ||
                            activatingStep !== null
                          }
                          aria-label={`${t(locale, "library.revival.activate")} ${step.title}`}
                          onClick={async () => {
                            setActivatingStep(index);
                            setActivationFailed(false);
                            try {
                              await revivalStepClient?.createAndAssignStep(
                                createRevivalStepActivationIntent(project, index),
                              );
                            } catch {
                              setActivationFailed(true);
                            } finally {
                              setActivatingStep(null);
                            }
                          }}
                        >
                          ▶
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
                {activationFailed ? (
                  <p className={styles.revivalIssue}>
                    {t(locale, "library.revival.activateError")}
                  </p>
                ) : null}
              </section>
            ) : null}
            <section>
              <h3>{t(locale, "library.field.stack")}</h3>
              <div className={styles.chips}>
                {project.stack.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            </section>
            <section>
              <h3>{t(locale, "library.overview.nextSteps")}</h3>
              {project.nextSteps.length === 0 ? (
                <Empty>{t(locale, "library.overview.nextSteps.empty")}</Empty>
              ) : (
                <ol className={styles.nextSteps}>
                  {project.nextSteps.slice(0, 3).map((step) => (
                    <li key={step.title}>
                      <strong>{step.title}</strong>
                      <span>
                        {step.estimateMinutes} {t(locale, "library.time.minutes")}
                      </span>
                      <p>{step.detail}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <section>
              <h3>{t(locale, "library.overview.filmstrip")}</h3>
              {project.snapshots.length === 0 ? (
                <Empty>{t(locale, "library.overview.snapshots.empty")}</Empty>
              ) : (
                <div className={styles.filmstrip}>
                  {project.snapshots.map((snapshot) => (
                    <article key={snapshot.sourceEvents[0]}>
                      <div>{snapshot.label}</div>
                      <small>{snapshot.at}</small>
                    </article>
                  ))}
                </div>
              )}
            </section>
            <section>
              <h3>{t(locale, "library.overview.decisions")}</h3>
              {decisions.length === 0 ? (
                <Empty>{t(locale, "library.memory.empty")}</Empty>
              ) : (
                decisions.map((item) => (
                  <article className={styles.detailItem} key={item.knowledge}>
                    <strong>{item.title}</strong>
                    <p>{item.rationale ?? item.summary}</p>
                  </article>
                ))
              )}
            </section>
          </div>
        ) : tab === "timeline" ? (
          project.timeline.length === 0 ? (
            <Empty>{t(locale, "library.timeline.empty")}</Empty>
          ) : (
            <div className={styles.detailList}>
              {project.timeline.map((item) => (
                <article className={styles.detailItem} key={item.event}>
                  <strong>{item.type}</strong>
                  <span>
                    {item.actor} · {item.at}
                  </span>
                  <Evidence
                    events={item.sourceEvents}
                    locale={locale}
                    onInspect={onInspectEvent}
                  />
                </article>
              ))}
            </div>
          )
        ) : tab === "memory" ? (
          project.knowledge.length === 0 ? (
            <Empty>{t(locale, "library.memory.empty")}</Empty>
          ) : (
            <div className={styles.detailList}>
              {project.knowledge.map((item) => (
                <article className={styles.detailItem} key={item.knowledge}>
                  <strong>{item.title}</strong>
                  <span>
                    {item.type} · {item.at}
                  </span>
                  <p>{item.summary}</p>
                  <Evidence
                    events={item.sourceEvents}
                    locale={locale}
                    onInspect={onInspectEvent}
                  />
                </article>
              ))}
            </div>
          )
        ) : tab === "files" ? (
          project.files.length === 0 ? (
            <Empty>{t(locale, "library.files.empty")}</Empty>
          ) : (
            <div className={styles.detailList}>
              {project.files.map((item) => (
                <article className={styles.detailItem} key={`${item.path}-${item.at}`}>
                  <strong>{item.path}</strong>
                  <span>
                    {item.kind}
                    {item.task ? ` · ${item.task}` : ""}
                  </span>
                  <Evidence
                    events={item.sourceEvents}
                    locale={locale}
                    onInspect={onInspectEvent}
                  />
                </article>
              ))}
            </div>
          )
        ) : (
          <dl className={styles.settings}>
            <div>
              <dt>{t(locale, "library.settings.state")}</dt>
              <dd>{t(locale, `library.state.${project.state}`)}</dd>
            </div>
            <div>
              <dt>{t(locale, "library.settings.stack")}</dt>
              <dd>{project.stack.join(" · ")}</dd>
            </div>
          </dl>
        )}
      </div>
      <footer className={styles.drawerFooter}>
        <button
          type="button"
          disabled={onOpenProject === undefined}
          onClick={() => onOpenProject?.(project.project)}
        >
          {project.state === "paused"
            ? t(locale, "library.action.resume")
            : t(locale, "library.action.open")}
        </button>
        {onOpenProject === undefined ? (
          <small>{t(locale, "library.action.unavailable")}</small>
        ) : null}
      </footer>
    </aside>
  );
}

export function ProjectLibraryView({
  library,
  locale,
  onInspectEvent,
  onOpenProject,
  revivalStepClient,
}: Readonly<{
  library: ProjectLibraryViewModel | null;
  locale: Locale;
  onInspectEvent?: (event: string) => void;
  onOpenProject?: (project: string) => void;
  revivalStepClient?: RevivalStepClient;
}>) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const projects = useMemo(
    () =>
      library?.projects.filter((item) => filter === "all" || item.state === filter) ?? [],
    [filter, library],
  );
  const selectedProject = library?.projects.find((item) => item.project === selected);

  if (library === null) {
    return (
      <section className={styles.pending}>
        <span>◇</span>
        <div>
          <h2>{t(locale, "library.pending.title")}</h2>
          <p>{t(locale, "library.pending.detail")}</p>
        </div>
      </section>
    );
  }

  return (
    <div className={styles.shell} data-drawer-open={selectedProject !== undefined}>
      <div className={styles.library}>
        <header className={styles.libraryHeader}>
          <div>
            <span>{t(locale, "library.milestone")}</span>
            <h2>{t(locale, "library.title")}</h2>
            <p>{t(locale, "library.subtitle")}</p>
          </div>
        </header>
        <nav
          className={styles.filters}
          aria-label={t(locale, "library.filters.ariaLabel")}
        >
          {FILTERS.map((item) => (
            <button
              type="button"
              key={item}
              aria-current={filter === item ? "page" : undefined}
              onClick={() => setFilter(item)}
            >
              {t(locale, `library.filter.${item}`)}{" "}
              <strong>{library.counts[item]}</strong>
            </button>
          ))}
        </nav>
        <section
          className={styles.stats}
          aria-label={t(locale, "library.stats.ariaLabel")}
        >
          {FILTERS.map((item) => (
            <article key={item}>
              <span>{t(locale, `library.filter.${item}`)}</span>
              <strong>{library.counts[item]}</strong>
            </article>
          ))}
        </section>
        {projects.length === 0 ? (
          <Empty>{t(locale, "library.filtered.empty")}</Empty>
        ) : (
          <section
            className={styles.rows}
            aria-label={t(locale, "library.rows.ariaLabel")}
          >
            {projects.map((project) => (
              <button
                type="button"
                className={styles.row}
                key={project.project}
                onClick={() => setSelected(project.project)}
              >
                <div className={styles.cover}>
                  {project.snapshots[0] ? (
                    <>
                      <span>{project.snapshots[0].label}</span>
                      <small>{project.snapshots[0].at}</small>
                    </>
                  ) : (
                    <span>◇</span>
                  )}
                </div>
                <div className={styles.identity}>
                  <div>
                    <strong>{project.name}</strong>
                    <span className={styles.stateBadge} data-state={project.state}>
                      {t(locale, `library.state.${project.state}`)}
                    </span>
                  </div>
                  <p>{project.summary?.text ?? t(locale, "library.summary.empty")}</p>
                  <small>
                    {project.agents.map((agent) => agent.name).join(" · ") ||
                      t(locale, "library.agents.empty")}
                  </small>
                </div>
                <div className={styles.rowProgress}>
                  <strong>{project.progress}%</strong>
                  <div className={styles.progress}>
                    <span style={{ width: `${project.progress}%` }} />
                  </div>
                  <small>
                    {project.currentWork?.title ?? t(locale, "library.currentWork.empty")}
                  </small>
                </div>
                <div className={styles.chips}>
                  {project.stack.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
                <div className={styles.activity}>
                  <strong>
                    {relativeTime(locale, library.now, project.lastActivity.at)}
                  </strong>
                  <span>{project.lastActivity.actor}</span>
                  <small>{project.lastActivity.type}</small>
                </div>
              </button>
            ))}
          </section>
        )}
        <section className={styles.insights}>
          <div>
            <span>◇</span>
            <div>
              <h3>{t(locale, "library.insights.title")}</h3>
              <p>{t(locale, "library.insights.unavailable")}</p>
            </div>
          </div>
        </section>
      </div>
      {selectedProject ? (
        <ProjectDetailPanel
          key={selectedProject.project}
          project={selectedProject}
          now={library.now}
          locale={locale}
          onClose={() => setSelected(null)}
          {...(onInspectEvent ? { onInspectEvent } : {})}
          {...(onOpenProject ? { onOpenProject } : {})}
          {...(revivalStepClient ? { revivalStepClient } : {})}
        />
      ) : null}
    </div>
  );
}
