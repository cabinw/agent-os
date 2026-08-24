import { useMemo, useState } from "react";
import styles from "./Threads.module.css";
import type { Locale } from "./i18n.js";
import { t } from "./i18n.js";

type MessageEvent = Readonly<{
  id: string;
  seq: number;
  at: string;
  actor: Readonly<{ kind: string; id: string }>;
  type: "message.sent";
  payload: Readonly<{
    from: string;
    to: string;
    type:
      | "instruction"
      | "question"
      | "answer"
      | "report"
      | "review"
      | "warning"
      | "progress";
    content: string;
    replyTo?: string;
  }>;
}>;
type DividerEvent = Readonly<{
  id: string;
  seq: number;
  at: string;
  type:
    | "task.started"
    | "task.blocked"
    | "task.unblocked"
    | "task.review.requested"
    | "task.completed"
    | "task.failed"
    | "task.cancelled"
    | "approval.requested"
    | "approval.granted"
    | "approval.rejected"
    | "approval.expired"
    | "knowledge.created";
  payload: Readonly<Record<string, unknown>>;
}>;
type ThreadItem =
  | Readonly<{ kind: "message"; event: MessageEvent }>
  | Readonly<{ kind: "progress-run"; events: readonly MessageEvent[] }>
  | Readonly<{ kind: "divider"; event: DividerEvent }>;
type Thread = Readonly<{
  task?: string;
  title?: string;
  status?: string;
  progress?: number;
  executor?: string;
  items: readonly ThreadItem[];
}>;
export type ConversationProjectViewModel = Readonly<{
  threads: Readonly<Record<string, Thread>>;
}>;

export type ThreadsReaderProps = Readonly<{
  conversation: ConversationProjectViewModel | null;
  locale: Locale;
  task?: string;
  embedded?: boolean;
  initialQuery?: string;
  initialParticipant?: string;
}>;

function itemEvents(item: ThreadItem): readonly (MessageEvent | DividerEvent)[] {
  return item.kind === "progress-run" ? item.events : [item.event];
}
function lastEvent(thread: Thread) {
  const item = thread.items.at(-1);
  return item === undefined ? undefined : itemEvents(item).at(-1);
}
function participants(thread: Thread): readonly string[] {
  return [
    ...new Set(
      thread.items
        .flatMap(itemEvents)
        .filter((event): event is MessageEvent => event.type === "message.sent")
        .flatMap((event) => [event.payload.from, event.payload.to]),
    ),
  ];
}
function dividerDetail(event: DividerEvent): string {
  if (event.type === "task.blocked" && typeof event.payload.reason === "string")
    return event.payload.reason;
  if (event.type === "task.unblocked" && typeof event.payload.resolution === "string")
    return event.payload.resolution;
  if (event.type === "knowledge.created" && typeof event.payload.title === "string")
    return event.payload.title;
  return "";
}

function Message({
  event,
  messages,
  locale,
}: Readonly<{
  event: MessageEvent;
  messages: ReadonlyMap<string, MessageEvent>;
  locale: Locale;
}>) {
  const reply =
    event.payload.replyTo === undefined ? undefined : messages.get(event.payload.replyTo);
  return (
    <article
      className={styles.message}
      data-type={event.payload.type}
      data-human={event.actor.kind === "human"}
    >
      <span className={styles.avatar}>
        {event.actor.kind === "human"
          ? t(locale, "threads.human.short")
          : event.payload.from.slice(0, 1).toUpperCase()}
      </span>
      <div>
        <header>
          <strong>
            {event.actor.kind === "human"
              ? t(locale, "threads.human.you")
              : event.payload.from}
          </strong>
          <span>{t(locale, `threads.message.${event.payload.type}`)}</span>
          <time>
            {new Date(event.at).toLocaleTimeString(locale, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </header>
        {reply ? (
          <button type="button" className={styles.reply}>
            ↳ {reply.payload.from}: {reply.payload.content}
          </button>
        ) : null}
        <p>{event.payload.content}</p>
        <small>
          {t(locale, "threads.evidence")} · {event.id}
        </small>
      </div>
    </article>
  );
}

function itemMatchesQuery(item: ThreadItem, query: string): boolean {
  if (query === "") return true;
  return itemEvents(item).some(
    (event) =>
      (event.type === "message.sent" &&
        event.payload.content.toLocaleLowerCase().includes(query)) ||
      event.type.toLocaleLowerCase().includes(query) ||
      dividerDetail(event as DividerEvent)
        .toLocaleLowerCase()
        .includes(query),
  );
}

export function ThreadsReader({
  conversation,
  locale,
  task,
  embedded = false,
  initialQuery = "",
  initialParticipant = "",
}: ThreadsReaderProps) {
  const allEntries = useMemo(
    () =>
      conversation === null
        ? []
        : Object.entries(conversation.threads).sort(
            ([leftKey, left], [rightKey, right]) =>
              Number(leftKey === "$project") - Number(rightKey === "$project") ||
              (lastEvent(right)?.seq ?? 0) - (lastEvent(left)?.seq ?? 0),
          ),
    [conversation],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [participant, setParticipant] = useState(initialParticipant);
  const [hideProgress, setHideProgress] = useState(true);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const allParticipants = useMemo(
    () => [...new Set(allEntries.flatMap(([, thread]) => participants(thread)))].sort(),
    [allEntries],
  );
  const scopedEntries = allEntries.filter(
    ([key, candidate]) =>
      (task === undefined || key === task) &&
      (participant === "" || participants(candidate).includes(participant)) &&
      (normalizedQuery === "" ||
        candidate.items.some((item) => itemMatchesQuery(item, normalizedQuery))),
  );
  const activeKey =
    selected !== null && scopedEntries.some(([key]) => key === selected)
      ? selected
      : scopedEntries[0]?.[0];
  const thread = activeKey === undefined ? undefined : conversation?.threads[activeKey];
  const messages = useMemo(
    () =>
      new Map(
        allEntries.flatMap(([, candidate]) =>
          candidate.items
            .flatMap(itemEvents)
            .filter((event): event is MessageEvent => event.type === "message.sent")
            .map((event) => [event.id, event] as const),
        ),
      ),
    [allEntries],
  );
  if (conversation === null)
    return (
      <section className={styles.pending}>
        <span>◇</span>
        <div>
          <h3>{t(locale, "threads.pending.title")}</h3>
          <p>{t(locale, "threads.pending.detail")}</p>
        </div>
      </section>
    );
  if (allEntries.length === 0)
    return (
      <section className={styles.pending}>
        <span>◇</span>
        <div>
          <h3>{t(locale, "threads.empty.title")}</h3>
          <p>{t(locale, "threads.empty.detail")}</p>
        </div>
      </section>
    );
  const visible =
    thread?.items.filter((item) => {
      if (hideProgress && item.kind === "progress-run") return false;
      return itemMatchesQuery(item, normalizedQuery);
    }) ?? [];
  return (
    <section
      className={styles.reader}
      data-embedded={embedded || task !== undefined}
      aria-label={t(locale, "threads.reader.ariaLabel")}
    >
      {task === undefined ? (
        <aside className={styles.list}>
          <label>
            <span>⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t(locale, "threads.search.placeholder")}
            />
          </label>
          <div className={styles.listHead}>
            <strong>{t(locale, "threads.list.title")}</strong>
            <span>{scopedEntries.length}</span>
          </div>
          {scopedEntries.map(([key, candidate]) => {
            const last = lastEvent(candidate);
            const preview =
              last?.type === "message.sent"
                ? `${last.payload.from}: ${last.payload.content}`
                : (last?.type ?? t(locale, "threads.preview.empty"));
            return (
              <button
                type="button"
                key={key}
                aria-current={activeKey === key ? "page" : undefined}
                onClick={() => setSelected(key)}
              >
                <strong>
                  {key === "$project"
                    ? t(locale, "threads.project")
                    : (candidate.title ?? key)}
                </strong>
                <p>{preview}</p>
                <small>
                  {participants(candidate).slice(0, 3).join(" · ")}
                  <time>
                    {last === undefined
                      ? ""
                      : new Date(last.at).toLocaleDateString(locale)}
                  </time>
                </small>
              </button>
            );
          })}
          {scopedEntries.length === 0 ? (
            <p className={styles.listEmpty}>{t(locale, "threads.search.empty")}</p>
          ) : null}
        </aside>
      ) : null}
      <div className={styles.pane}>
        <header className={styles.threadHeader}>
          <div>
            <span>
              {activeKey === "$project" ? t(locale, "threads.project") : thread?.task}
            </span>
            <h3>
              {activeKey === "$project"
                ? t(locale, "threads.project.title")
                : thread?.title}
            </h3>
            <p>{thread === undefined ? "" : participants(thread).join(" · ")}</p>
          </div>
          {thread?.status ? (
            <div>
              <strong>{thread.progress}%</strong>
              <span>{thread.status}</span>
            </div>
          ) : null}
        </header>
        <div className={styles.tools}>
          <div>
            <button
              type="button"
              aria-pressed={hideProgress}
              onClick={() => setHideProgress((value) => !value)}
            >
              {hideProgress
                ? t(locale, "threads.progress.show")
                : t(locale, "threads.progress.hide")}
            </button>
            {task === undefined ? (
              <label>
                {t(locale, "threads.participant.label")}
                <select
                  value={participant}
                  onChange={(event) => setParticipant(event.target.value)}
                >
                  <option value="">{t(locale, "threads.participant.all")}</option>
                  {allParticipants.map((value) => (
                    <option value={value} key={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <span>{t(locale, "threads.readOnly")}</span>
        </div>
        <div className={styles.stream}>
          {visible.length === 0 ? (
            <p className={styles.noMatch}>{t(locale, "threads.filter.empty")}</p>
          ) : (
            visible.map((item) =>
              item.kind === "message" ? (
                <Message
                  key={item.event.id}
                  event={item.event}
                  messages={messages}
                  locale={locale}
                />
              ) : item.kind === "progress-run" ? (
                <details className={styles.progressRun} key={item.events[0]?.id}>
                  <summary>
                    {item.events.length} {t(locale, "threads.progress.updates")}
                  </summary>
                  {item.events.map((event) => (
                    <Message
                      key={event.id}
                      event={event}
                      messages={messages}
                      locale={locale}
                    />
                  ))}
                </details>
              ) : (
                <div
                  className={styles.divider}
                  data-type={item.event.type}
                  key={item.event.id}
                >
                  <span />
                  <strong>
                    {item.event.type}
                    {dividerDetail(item.event) ? ` · ${dividerDetail(item.event)}` : ""}
                  </strong>
                  <time>
                    {new Date(item.event.at).toLocaleTimeString(locale, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <span />
                </div>
              ),
            )
          )}
        </div>
      </div>
    </section>
  );
}
