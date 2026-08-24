import { useMemo, useState } from "react";
import styles from "./Memory.module.css";
import type { Locale } from "./i18n.js";
import { t } from "./i18n.js";

type KnowledgeType =
  | "decision"
  | "research"
  | "technical-note"
  | "task-summary"
  | "milestone"
  | "discussion";

export type MemoryItemViewModel = Readonly<{
  id: string;
  project: string;
  type: KnowledgeType;
  title: string;
  summary: string;
  rationale?: string;
  alternatives?: readonly string[];
  sourceEvents: readonly string[];
  relatedTasks?: readonly string[];
  author: Readonly<{ kind: string; id: string }>;
  at: string;
  createdEvent: string;
  createdSeq: number;
  supersedes?: string;
  supersededBy?: string;
}>;

export type MemoryRelationViewModel = Readonly<{
  kind: "linked" | "related-task" | "superseded-by" | "supersedes";
  from: string;
  to: string;
  relation: string;
  event?: string;
}>;

export type MemoryQueryResultViewModel = Readonly<{
  item: MemoryItemViewModel;
  relations: readonly MemoryRelationViewModel[];
}>;

export type ProjectMemoryViewModel = Readonly<{
  project: string;
  results: readonly MemoryQueryResultViewModel[];
}>;

export type KnowledgeGraphNode = Readonly<{
  id: string;
  kind: "knowledge" | "task" | "entity";
  label: string;
  knowledgeType?: KnowledgeType;
  status: "active" | "superseded" | "context";
  x: number;
  y: number;
  sourceEvents: readonly string[];
}>;

export type KnowledgeGraphEdge = Readonly<{
  id: string;
  from: string;
  to: string;
  relation: string;
  event?: string;
  sourceEvents: readonly string[];
}>;

export type KnowledgeGraphLayout = Readonly<{
  nodes: readonly KnowledgeGraphNode[];
  edges: readonly KnowledgeGraphEdge[];
}>;

function freeze<Value>(value: Value): Readonly<Value> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value;
}

function normalizedRelation(relation: MemoryRelationViewModel) {
  return relation.kind === "superseded-by"
    ? { from: relation.to, to: relation.from, relation: "supersedes" }
    : { from: relation.from, to: relation.to, relation: relation.relation };
}

export function buildKnowledgeGraphLayout(
  results: readonly MemoryQueryResultViewModel[],
): KnowledgeGraphLayout {
  const items = new Map(results.map((result) => [result.item.id, result.item]));
  const nodes = new Map<string, KnowledgeGraphNode>();
  const rowCounts = new Map<KnowledgeType, number>();
  const rows: Readonly<Record<KnowledgeType, number>> = {
    decision: 70,
    research: 190,
    "technical-note": 310,
    "task-summary": 430,
    milestone: 550,
    discussion: 670,
  };
  for (const { item } of results) {
    const index = rowCounts.get(item.type) ?? 0;
    rowCounts.set(item.type, index + 1);
    nodes.set(item.id, {
      id: item.id,
      kind: "knowledge",
      label: item.title,
      knowledgeType: item.type,
      status: item.supersededBy === undefined ? "active" : "superseded",
      x: 50 + index * 230,
      y: rows[item.type],
      sourceEvents: [item.createdEvent, ...item.sourceEvents],
    });
  }

  const edges = new Map<string, KnowledgeGraphEdge>();
  const contextIds = new Set<string>();
  for (const result of results) {
    for (const descriptor of result.relations) {
      const relation = normalizedRelation(descriptor);
      const id =
        descriptor.event ?? `${relation.relation}:${relation.from}:${relation.to}`;
      if (edges.has(id)) continue;
      const sourceEvents =
        descriptor.event === undefined
          ? [
              items.get(relation.from)?.createdEvent,
              items.get(relation.to)?.createdEvent,
            ].filter((event): event is string => event !== undefined)
          : [descriptor.event];
      edges.set(id, {
        id,
        ...relation,
        ...(descriptor.event === undefined ? {} : { event: descriptor.event }),
        sourceEvents,
      });
      if (!items.has(relation.from)) contextIds.add(relation.from);
      if (!items.has(relation.to)) contextIds.add(relation.to);
    }
  }
  [...contextIds].sort().forEach((id, index) => {
    nodes.set(id, {
      id,
      kind: /^TASK-[0-9]{3,}$/u.test(id) ? "task" : "entity",
      label: id,
      status: "context",
      x: 50 + index * 200,
      y: 800,
      sourceEvents: [],
    });
  });
  return freeze({ nodes: [...nodes.values()], edges: [...edges.values()] });
}

type MemoryViewName = "list" | "graph";
type MemoryStatus = "all" | "active" | "superseded";
type MemoryTypeFilter = "all" | KnowledgeType;

export function filterMemoryResults(
  results: readonly MemoryQueryResultViewModel[],
  query: string,
  type: MemoryTypeFilter,
  status: MemoryStatus,
) {
  const needle = query.trim().toLowerCase();
  return results.filter(({ item }) => {
    const active = item.supersededBy === undefined;
    return (
      (needle.length === 0 ||
        [
          item.title,
          item.summary,
          item.rationale ?? "",
          ...(item.alternatives ?? []),
        ].some((value) => value.toLowerCase().includes(needle))) &&
      (type === "all" || item.type === type) &&
      (status === "all" || (status === "active" ? active : !active))
    );
  });
}

function Sources({ events }: Readonly<{ events: readonly string[] }>) {
  if (events.length === 0) return <span>—</span>;
  return (
    <ul>
      {events.map((event) => (
        <li key={event}>{event}</li>
      ))}
    </ul>
  );
}

export function MemoryView({
  memory,
  locale,
  initialView = "list",
}: Readonly<{
  memory: ProjectMemoryViewModel | null;
  locale: Locale;
  initialView?: MemoryViewName;
}>) {
  const [view, setView] = useState<MemoryViewName>(initialView);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<MemoryTypeFilter>("all");
  const [status, setStatus] = useState<MemoryStatus>("all");
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const visible = useMemo(
    () => filterMemoryResults(memory?.results ?? [], query, type, status),
    [memory, query, status, type],
  );
  const graph = useMemo(() => buildKnowledgeGraphLayout(visible), [visible]);
  const node = graph.nodes.find((candidate) => candidate.id === selectedNode) ?? null;
  const edge = graph.edges.find((candidate) => candidate.id === selectedEdge) ?? null;
  const positions = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));

  const changeView = (candidate: MemoryViewName) => {
    setView(candidate);
    setSelectedNode(null);
    setSelectedEdge(null);
  };

  return (
    <section
      className={styles.memory}
      data-view={view}
      aria-label={t(locale, "memory.ariaLabel")}
    >
      <header className={styles.header}>
        <div
          className={styles.viewToggle}
          aria-label={t(locale, "memory.view.ariaLabel")}
        >
          {(["list", "graph"] as const).map((candidate) => (
            <button
              type="button"
              key={candidate}
              aria-pressed={view === candidate}
              onClick={() => changeView(candidate)}
            >
              {t(locale, `memory.view.${candidate}`)}
            </button>
          ))}
        </div>
        <div className={styles.filters}>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t(locale, "memory.search.placeholder")}
            aria-label={t(locale, "memory.search.ariaLabel")}
          />
          <select
            value={type}
            onChange={(event) => setType(event.target.value as MemoryTypeFilter)}
            aria-label={t(locale, "memory.type.ariaLabel")}
          >
            <option value="all">{t(locale, "memory.type.all")}</option>
            <option value="decision">{t(locale, "memory.type.decision")}</option>
            <option value="research">{t(locale, "memory.type.research")}</option>
            <option value="technical-note">
              {t(locale, "memory.type.technical-note")}
            </option>
            <option value="task-summary">{t(locale, "memory.type.task-summary")}</option>
            <option value="milestone">{t(locale, "memory.type.milestone")}</option>
            <option value="discussion">{t(locale, "memory.type.discussion")}</option>
          </select>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as MemoryStatus)}
            aria-label={t(locale, "memory.status.ariaLabel")}
          >
            <option value="all">{t(locale, "memory.status.all")}</option>
            <option value="active">{t(locale, "memory.status.active")}</option>
            <option value="superseded">{t(locale, "memory.status.superseded")}</option>
          </select>
        </div>
        <span className={styles.count}>
          {visible.length} {t(locale, "memory.count")}
        </span>
      </header>

      {memory === null || memory.results.length === 0 ? (
        <div className={styles.empty}>
          <span aria-hidden="true">◇</span>
          <h2>{t(locale, "memory.empty.title")}</h2>
          <p>{t(locale, "memory.empty.detail")}</p>
        </div>
      ) : visible.length === 0 ? (
        <div className={styles.empty}>
          <h2>{t(locale, "memory.filter.empty")}</h2>
        </div>
      ) : view === "list" ? (
        <div className={styles.list}>
          {visible.map(({ item, relations }) => (
            <article
              key={item.id}
              data-status={item.supersededBy === undefined ? "active" : "superseded"}
            >
              <div className={styles.cardTop}>
                <span>{t(locale, `memory.type.${item.type}`)}</span>
                <code>{item.id}</code>
              </div>
              <h2>{item.title}</h2>
              <p>{item.summary}</p>
              {item.rationale ? <blockquote>{item.rationale}</blockquote> : null}
              <div className={styles.cardMeta}>
                <span>{item.at}</span>
                <span>
                  {relations.length} {t(locale, "memory.relations")}
                </span>
                <span>
                  {item.supersededBy
                    ? t(locale, "memory.status.superseded")
                    : t(locale, "memory.status.active")}
                </span>
              </div>
              <details>
                <summary>{t(locale, "memory.sources")}</summary>
                <Sources events={[item.createdEvent, ...item.sourceEvents]} />
              </details>
            </article>
          ))}
        </div>
      ) : (
        <div className={styles.graphGrid}>
          <div className={styles.graphViewport}>
            <div className={styles.graph}>
              <svg viewBox="0 0 1240 930" aria-label={t(locale, "memory.graph.edges")}>
                <title>{t(locale, "memory.graph.edges")}</title>
                {graph.edges.map((candidate) => {
                  const from = positions.get(candidate.from);
                  const to = positions.get(candidate.to);
                  if (from === undefined || to === undefined) return null;
                  return (
                    <g key={candidate.id}>
                      <line
                        x1={from.x + 85}
                        y1={from.y + 36}
                        x2={to.x + 85}
                        y2={to.y + 36}
                        data-relation={candidate.relation}
                      />
                      <text x={(from.x + to.x) / 2 + 85} y={(from.y + to.y) / 2 + 28}>
                        {candidate.relation}
                      </text>
                    </g>
                  );
                })}
              </svg>
              {graph.nodes.map((candidate) => (
                <button
                  type="button"
                  key={candidate.id}
                  style={{ left: candidate.x, top: candidate.y }}
                  data-kind={candidate.kind}
                  data-status={candidate.status}
                  aria-pressed={selectedNode === candidate.id}
                  onClick={() => {
                    setSelectedNode(candidate.id);
                    setSelectedEdge(null);
                  }}
                >
                  <span>
                    {candidate.kind === "knowledge" && candidate.knowledgeType
                      ? t(locale, `memory.type.${candidate.knowledgeType}`)
                      : candidate.kind}
                  </span>
                  <strong>{candidate.label}</strong>
                  <small>{candidate.id}</small>
                </button>
              ))}
              {graph.edges.map((candidate) => {
                const from = positions.get(candidate.from);
                const to = positions.get(candidate.to);
                if (from === undefined || to === undefined) return null;
                return (
                  <button
                    type="button"
                    key={`inspect:${candidate.id}`}
                    className={styles.edgeHit}
                    style={{
                      left: (from.x + to.x) / 2 + 65,
                      top: (from.y + to.y) / 2 + 12,
                    }}
                    aria-label={`${t(locale, "memory.edge.inspect")} ${candidate.relation}`}
                    onClick={() => {
                      setSelectedEdge(candidate.id);
                      setSelectedNode(null);
                    }}
                  />
                );
              })}
            </div>
          </div>
          <aside className={styles.inspector}>
            {node ? (
              <>
                <span>{node.kind}</span>
                <h2>{node.label}</h2>
                <code>{node.id}</code>
                <h3>{t(locale, "memory.sources")}</h3>
                <Sources events={node.sourceEvents} />
              </>
            ) : edge ? (
              <>
                <span>{t(locale, "memory.relation")}</span>
                <h2>{edge.relation}</h2>
                <p>
                  {edge.from} → {edge.to}
                </p>
                <h3>{t(locale, "memory.sources")}</h3>
                <Sources events={edge.sourceEvents} />
              </>
            ) : (
              <p>{t(locale, "memory.inspect.empty")}</p>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
