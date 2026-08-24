import { useState } from "react";
import {
  type ConversationProjectViewModel,
  type HumanPostingClient,
  type HumanPostingPolicyViewModel,
  ThreadsReader,
} from "./Threads.js";
import styles from "./Workforce.module.css";
import type { Locale } from "./i18n.js";
import { t } from "./i18n.js";

type Source = Readonly<{ sourceEvents: readonly string[] }>;
type TaskStatus =
  | "created"
  | "assigned"
  | "running"
  | "blocked"
  | "review"
  | "completed"
  | "failed"
  | "cancelled";
type Assignment =
  | Readonly<{ kind: "assigned"; executor: string }>
  | Readonly<{ kind: "waiting-dependency"; tasks: readonly string[] }>
  | Readonly<{ kind: "awaiting-assignment"; candidate: { agent: string; host: string } }>
  | Readonly<{
      kind: "no-capability" | "unreachable" | "unavailable" | "saturated";
      requiredCapabilities: readonly string[];
    }>
  | Readonly<{ kind: "not-applicable" }>;

export type ProjectWorkforceViewModel = Readonly<{
  project: string;
  observedAt: string;
  taskCounts: Readonly<Record<TaskStatus | "all", number>>;
  agentCounts: Readonly<{
    logical: number;
    connected: number;
    available: number;
    activeDispatches: number;
  }>;
  tasks: readonly (Source &
    Readonly<{
      task: string;
      title: string;
      goal: string;
      status: TaskStatus;
      progress: number;
      priority: "low" | "medium" | "high" | "critical";
      owner: string;
      executor?: string;
      requires: readonly string[];
      assignment: Assignment;
      awaitingHumanReview: boolean;
      blocker?: { reason: string; severity: string; needs: string };
    }>)[];
  agents: readonly (Source &
    Readonly<{
      agent: string;
      name: string;
      provider: string;
      role: string;
      concurrency: number;
      availability: "available" | "offline" | "unavailable" | "saturated";
      active: number;
      completed: number;
      failed: number;
      capabilities: readonly string[];
      currentTasks: readonly string[];
      placements: readonly (Source &
        Readonly<{
          host: string;
          capabilities: readonly string[];
          connected: boolean;
          accepting: boolean;
          active: number;
          integration: Readonly<{
            participates: boolean;
            streaming: boolean;
            reasoning: boolean;
            session: boolean;
            usage: boolean;
          }>;
        }>)[];
    }>)[];
  coverage: readonly (Source &
    Readonly<{
      capability: string;
      covered: boolean;
      agents: readonly string[];
      placements: number;
    }>)[];
  threads: Readonly<{ available: false }>;
}>;

const TASK_FILTERS = [
  "all",
  "created",
  "assigned",
  "running",
  "blocked",
  "review",
  "completed",
  "failed",
  "cancelled",
] as const;

function assignmentText(locale: Locale, assignment: Assignment): string {
  if (assignment.kind === "assigned")
    return `${t(locale, "workforce.assignment.assigned")} · ${assignment.executor}`;
  if (assignment.kind === "waiting-dependency")
    return `${t(locale, "workforce.assignment.waiting-dependency")} · ${assignment.tasks.join(", ")}`;
  if (assignment.kind === "awaiting-assignment")
    return `${t(locale, "workforce.assignment.awaiting-assignment")} · ${assignment.candidate.agent}@${assignment.candidate.host}`;
  if (assignment.kind === "not-applicable")
    return t(locale, "workforce.assignment.not-applicable");
  const requirements = assignment.requiredCapabilities.join(" · ");
  return `${t(locale, `workforce.assignment.${assignment.kind}`)}${requirements ? ` · ${requirements}` : ""}`;
}

function SurfaceHeader({
  locale,
  titleKey,
}: Readonly<{ locale: Locale; titleKey: "tasks" | "agents" }>) {
  return (
    <header className={styles.surfaceHeader}>
      <div>
        <span>{t(locale, "workforce.milestone")}</span>
        <h2>{t(locale, `workforce.${titleKey}.title`)}</h2>
        <p>{t(locale, `workforce.${titleKey}.subtitle`)}</p>
      </div>
    </header>
  );
}

function Pending({ locale }: Readonly<{ locale: Locale }>) {
  return (
    <section className={styles.pending}>
      <span aria-hidden="true">◇</span>
      <div>
        <h3>{t(locale, "workforce.pending.title")}</h3>
        <p>{t(locale, "workforce.pending.detail")}</p>
      </div>
    </section>
  );
}

export function TasksView({
  workforce,
  locale,
  conversation = null,
  initialSelectedTask = null,
  postingPolicy = null,
  postingClient,
}: Readonly<{
  workforce: ProjectWorkforceViewModel | null;
  locale: Locale;
  conversation?: ConversationProjectViewModel | null;
  initialSelectedTask?: string | null;
  postingPolicy?: HumanPostingPolicyViewModel | null;
  postingClient?: HumanPostingClient;
}>) {
  const [filter, setFilter] = useState<(typeof TASK_FILTERS)[number]>("all");
  const [selectedTask, setSelectedTask] = useState<string | null>(initialSelectedTask);
  if (workforce === null)
    return (
      <div className={styles.surface}>
        <SurfaceHeader locale={locale} titleKey="tasks" />
        <Pending locale={locale} />
      </div>
    );
  const tasks =
    filter === "all"
      ? workforce.tasks
      : workforce.tasks.filter((task) => task.status === filter);
  return (
    <div className={styles.surface}>
      <SurfaceHeader locale={locale} titleKey="tasks" />
      <nav
        className={styles.filters}
        aria-label={t(locale, "workforce.tasks.filters.ariaLabel")}
      >
        {TASK_FILTERS.map((status) => (
          <button
            type="button"
            key={status}
            aria-current={filter === status ? "page" : undefined}
            onClick={() => setFilter(status)}
          >
            {t(locale, `workforce.task.status.${status}`)}{" "}
            <b>{workforce.taskCounts[status]}</b>
          </button>
        ))}
      </nav>
      <section
        className={styles.taskList}
        aria-label={t(locale, "workforce.tasks.list.ariaLabel")}
      >
        {tasks.length === 0 ? (
          <p className={styles.empty}>{t(locale, "workforce.tasks.empty")}</p>
        ) : (
          tasks.map((task) => (
            <article
              className={styles.taskCard}
              key={task.task}
              data-status={task.status}
            >
              <div className={styles.taskTop}>
                <span className={styles.status}>
                  {t(locale, `workforce.task.status.${task.status}`)}
                </span>
                <small>
                  {task.task} · {t(locale, `workforce.priority.${task.priority}`)}
                </small>
              </div>
              <h3>{task.title}</h3>
              <p>{task.goal}</p>
              <div className={styles.progressLine}>
                <strong>{task.progress}%</strong>
                <div aria-label={`${task.progress}%`}>
                  <span style={{ width: `${task.progress}%` }} />
                </div>
              </div>
              {task.awaitingHumanReview ? (
                <div className={styles.reviewNotice}>
                  <strong>{t(locale, "workforce.review.title")}</strong>
                  <span>{t(locale, "workforce.review.detail")}</span>
                </div>
              ) : null}
              {task.blocker ? (
                <div className={styles.blocker}>
                  <strong>{t(locale, "workforce.blocker")}</strong>
                  <span>{task.blocker.reason}</span>
                </div>
              ) : null}
              <footer>
                <span>{assignmentText(locale, task.assignment)}</span>
                <div>
                  <small>
                    {t(locale, "workforce.evidence")} · {task.sourceEvents.length}
                  </small>
                  <button type="button" onClick={() => setSelectedTask(task.task)}>
                    {t(locale, "workforce.task.openDetail")}
                  </button>
                </div>
              </footer>
            </article>
          ))
        )}
      </section>
      {selectedTask !== null ? (
        <aside className={styles.taskDetail} aria-labelledby="task-detail-title">
          <header>
            <div>
              <span>{selectedTask}</span>
              <h2 id="task-detail-title">
                {workforce.tasks.find((task) => task.task === selectedTask)?.title}
              </h2>
            </div>
            <button
              type="button"
              onClick={() => setSelectedTask(null)}
              aria-label={t(locale, "workforce.task.closeDetail")}
            >
              ×
            </button>
          </header>
          <ThreadsReader
            conversation={conversation}
            locale={locale}
            task={selectedTask}
            embedded
            postingPolicy={postingPolicy}
            {...(postingClient === undefined ? {} : { postingClient })}
          />
        </aside>
      ) : null}
    </div>
  );
}

export function AgentsView({
  workforce,
  locale,
  conversation = null,
  postingPolicy = null,
  postingClient,
}: Readonly<{
  workforce: ProjectWorkforceViewModel | null;
  locale: Locale;
  conversation?: ConversationProjectViewModel | null;
  postingPolicy?: HumanPostingPolicyViewModel | null;
  postingClient?: HumanPostingClient;
}>) {
  const [mode, setMode] = useState<"roster" | "threads">("roster");
  if (workforce === null)
    return (
      <div className={styles.surface}>
        <SurfaceHeader locale={locale} titleKey="agents" />
        <Pending locale={locale} />
      </div>
    );
  return (
    <div className={styles.surface}>
      <SurfaceHeader locale={locale} titleKey="agents" />
      <nav
        className={styles.modeSwitch}
        aria-label={t(locale, "workforce.agents.mode.ariaLabel")}
      >
        <button
          type="button"
          aria-current={mode === "roster" ? "page" : undefined}
          onClick={() => setMode("roster")}
        >
          {t(locale, "workforce.agents.roster")}
        </button>
        <button
          type="button"
          aria-current={mode === "threads" ? "page" : undefined}
          onClick={() => setMode("threads")}
        >
          {t(locale, "workforce.agents.threads")}
        </button>
      </nav>
      {mode === "threads" ? (
        <ThreadsReader
          conversation={conversation}
          locale={locale}
          postingPolicy={postingPolicy}
          {...(postingClient === undefined ? {} : { postingClient })}
        />
      ) : (
        <>
          <section
            className={styles.metrics}
            aria-label={t(locale, "workforce.agents.metrics.ariaLabel")}
          >
            {(["logical", "connected", "available", "activeDispatches"] as const).map(
              (metric) => (
                <article key={metric}>
                  <strong>{workforce.agentCounts[metric]}</strong>
                  <span>{t(locale, `workforce.metric.${metric}`)}</span>
                </article>
              ),
            )}
          </section>
          <div className={styles.agentLayout}>
            <section
              className={styles.agentList}
              aria-label={t(locale, "workforce.agents.list.ariaLabel")}
            >
              {workforce.agents.length === 0 ? (
                <p className={styles.empty}>{t(locale, "workforce.agents.empty")}</p>
              ) : (
                workforce.agents.map((agent) => (
                  <article className={styles.agentCard} key={agent.agent}>
                    <header>
                      <span className={styles.avatar}>{agent.name.slice(0, 1)}</span>
                      <div>
                        <h3>{agent.name}</h3>
                        <small>
                          {agent.role} · {agent.provider}
                        </small>
                      </div>
                      <span
                        className={styles.availability}
                        data-state={agent.availability}
                      >
                        {t(locale, `workforce.availability.${agent.availability}`)}
                      </span>
                    </header>
                    <div className={styles.chips}>
                      {agent.capabilities.map((capability) => (
                        <span key={capability}>{capability}</span>
                      ))}
                    </div>
                    <dl>
                      <div>
                        <dt>{t(locale, "workforce.agent.active")}</dt>
                        <dd>
                          {agent.active}/{agent.concurrency}
                        </dd>
                      </div>
                      <div>
                        <dt>{t(locale, "workforce.agent.completed")}</dt>
                        <dd>{agent.completed}</dd>
                      </div>
                      <div>
                        <dt>{t(locale, "workforce.agent.failed")}</dt>
                        <dd>{agent.failed}</dd>
                      </div>
                    </dl>
                    <div className={styles.placements}>
                      {agent.placements.map((placement) => (
                        <div key={placement.host}>
                          <span
                            className={
                              placement.connected ? styles.online : styles.offline
                            }
                          />{" "}
                          <strong>{placement.host}</strong>
                          <small>
                            {placement.connected
                              ? t(locale, "workforce.placement.connected")
                              : t(locale, "workforce.placement.offline")}{" "}
                            ·{" "}
                            {placement.accepting
                              ? t(locale, "workforce.placement.accepting")
                              : t(locale, "workforce.placement.notAccepting")}
                          </small>
                        </div>
                      ))}
                    </div>
                  </article>
                ))
              )}
            </section>
            <aside className={styles.coverage}>
              <h3>{t(locale, "workforce.coverage.title")}</h3>
              <p>{t(locale, "workforce.coverage.detail")}</p>
              {workforce.coverage.map((item) => (
                <div key={item.capability}>
                  <span className={item.covered ? styles.covered : styles.gap}>
                    {item.covered ? "✓" : "!"}
                  </span>
                  <strong>{item.capability}</strong>
                  <small>
                    {item.covered
                      ? `${item.agents.length} ${t(locale, "workforce.coverage.agents")} · ${item.placements} ${t(locale, "workforce.coverage.placements")}`
                      : t(locale, "workforce.coverage.missing")}
                  </small>
                </div>
              ))}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
