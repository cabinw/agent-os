import { useMemo, useState } from "react";
import styles from "./Canvas.module.css";
import type { Locale } from "./i18n.js";
import { t } from "./i18n.js";

type Source = Readonly<{ sourceEvents: readonly string[] }>;
export type CanvasNodeKind =
  | "project"
  | "goal"
  | "task"
  | "agent"
  | "resource"
  | "knowledge";
export type CanvasNodeViewModel = Source &
  Readonly<{
    id: string;
    project: string;
    kind: CanvasNodeKind;
    label: string;
    status?: string;
    progress?: number;
    executor?: string;
    dependsOn?: readonly string[];
    completed: boolean;
  }>;
export type CanvasEdgeViewModel = Source &
  Readonly<{
    from: string;
    to: string;
    relation: "causedBy";
    event: string;
    eventType: string;
  }>;
export type CanvasProjectViewModel = Source &
  Readonly<{
    project: string;
    name: string;
    progress: number;
    health: "healthy" | "attention" | "blocked";
    nodes: readonly CanvasNodeViewModel[];
    edges: readonly CanvasEdgeViewModel[];
  }>;
export type ProjectCanvasViewModel = Readonly<{
  projects: readonly CanvasProjectViewModel[];
}>;
export type CanvasLevel = "universe" | "mission" | "workspace";

export type CanvasLayer = Readonly<{
  level: CanvasLevel;
  project: CanvasProjectViewModel | null;
  nodes: readonly CanvasNodeViewModel[];
  edges: readonly CanvasEdgeViewModel[];
  agent: string | null;
}>;

export function selectCanvasLayer(
  canvas: ProjectCanvasViewModel | null,
  level: CanvasLevel,
  projectId?: string,
  agentId?: string,
): CanvasLayer {
  const project =
    canvas?.projects.find((candidate) => candidate.project === projectId) ??
    canvas?.projects[0] ??
    null;
  if (project === null || level === "universe") {
    return { level, project, nodes: [], edges: [], agent: null };
  }
  if (level === "mission") {
    return {
      level,
      project,
      nodes: project.nodes,
      edges: project.edges,
      agent: null,
    };
  }
  const agents = project.nodes.filter((node) => node.kind === "agent");
  const agent = agents.find((node) => node.id === agentId) ?? agents[0] ?? null;
  if (agent === null) {
    return { level, project, nodes: [], edges: [], agent: null };
  }
  const included = new Set<string>([agent.id]);
  for (const node of project.nodes) {
    if (node.kind === "task" && node.executor === agent.id.slice("agent:".length)) {
      included.add(node.id);
    }
  }
  for (let depth = 0; depth < 2; depth += 1) {
    for (const edge of project.edges) {
      if (included.has(edge.from) || included.has(edge.to)) {
        included.add(edge.from);
        included.add(edge.to);
      }
    }
  }
  const nodes = project.nodes.filter((node) => included.has(node.id));
  return {
    level,
    project,
    nodes,
    edges: project.edges.filter(
      (edge) => included.has(edge.from) && included.has(edge.to),
    ),
    agent: agent.id,
  };
}

type Position = Readonly<{ x: number; y: number }>;
const KIND_X: Readonly<Record<CanvasNodeKind, number>> = {
  project: 40,
  goal: 230,
  task: 450,
  agent: 680,
  knowledge: 890,
  resource: 1090,
};

function layout(nodes: readonly CanvasNodeViewModel[]): ReadonlyMap<string, Position> {
  const counts = new Map<CanvasNodeKind, number>();
  const positions = new Map<string, Position>();
  for (const node of nodes) {
    const index = counts.get(node.kind) ?? 0;
    counts.set(node.kind, index + 1);
    positions.set(node.id, { x: KIND_X[node.kind], y: 60 + index * 112 });
  }
  return positions;
}

function percent(value: number): string {
  return `${Math.max(0, Math.min(100, value))}%`;
}

function EmptyCanvas({ locale }: Readonly<{ locale: Locale }>) {
  return (
    <section className={styles.empty}>
      <span aria-hidden="true">◇</span>
      <h2>{t(locale, "canvas.empty.title")}</h2>
      <p>{t(locale, "canvas.empty.detail")}</p>
    </section>
  );
}

export function CanvasView({
  canvas,
  locale,
  initialLevel = "universe",
}: Readonly<{
  canvas: ProjectCanvasViewModel | null;
  locale: Locale;
  initialLevel?: CanvasLevel;
}>) {
  const [level, setLevel] = useState<CanvasLevel>(initialLevel);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [agentId, setAgentId] = useState<string | undefined>();
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const layer = selectCanvasLayer(canvas, level, projectId, agentId);
  const positions = useMemo(() => layout(layer.nodes), [layer.nodes]);
  const selected = layer.nodes.find((node) => node.id === selectedNode) ?? null;

  if (canvas === null || canvas.projects.length === 0)
    return <EmptyCanvas locale={locale} />;

  const setSemanticLevel = (next: CanvasLevel) => {
    setLevel(next);
    setSelectedNode(null);
    setPan({ x: 0, y: 0 });
    setScale(1);
  };

  return (
    <section
      className={styles.canvas}
      data-level={level}
      aria-label={t(locale, "canvas.ariaLabel")}
    >
      <header className={styles.toolbar}>
        <div
          className={styles.semanticControls}
          aria-label={t(locale, "canvas.level.ariaLabel")}
        >
          {(["universe", "mission", "workspace"] as const).map((candidate) => (
            <button
              type="button"
              key={candidate}
              aria-pressed={level === candidate}
              onClick={() => setSemanticLevel(candidate)}
            >
              {t(locale, `canvas.level.${candidate}`)}
            </button>
          ))}
        </div>
        <div
          className={styles.viewportControls}
          aria-label={t(locale, "canvas.viewport.ariaLabel")}
        >
          <button
            type="button"
            onClick={() => setPan((value) => ({ ...value, x: value.x - 60 }))}
            aria-label={t(locale, "canvas.pan.left")}
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => setPan((value) => ({ ...value, y: value.y - 60 }))}
            aria-label={t(locale, "canvas.pan.up")}
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => setPan((value) => ({ ...value, y: value.y + 60 }))}
            aria-label={t(locale, "canvas.pan.down")}
          >
            ↓
          </button>
          <button
            type="button"
            onClick={() => setPan((value) => ({ ...value, x: value.x + 60 }))}
            aria-label={t(locale, "canvas.pan.right")}
          >
            →
          </button>
          <button
            type="button"
            onClick={() => setScale((value) => Math.max(0.7, value - 0.1))}
            aria-label={t(locale, "canvas.zoom.out")}
          >
            −
          </button>
          <span>{Math.round(scale * 100)}%</span>
          <button
            type="button"
            onClick={() => setScale((value) => Math.min(1.4, value + 0.1))}
            aria-label={t(locale, "canvas.zoom.in")}
          >
            ＋
          </button>
          <button
            type="button"
            onClick={() => {
              setPan({ x: 0, y: 0 });
              setScale(1);
            }}
          >
            {t(locale, "canvas.reset")}
          </button>
        </div>
      </header>

      {level === "universe" ? (
        <div className={styles.universe}>
          {canvas.projects.map((project) => (
            <button
              type="button"
              key={project.project}
              className={styles.projectCard}
              data-health={project.health}
              onClick={() => {
                setProjectId(project.project);
                setSemanticLevel("mission");
              }}
            >
              <span className={styles.kind}>{t(locale, "canvas.node.project")}</span>
              <strong>{project.name}</strong>
              <small>{project.project}</small>
              <span className={styles.health}>
                {t(locale, `canvas.health.${project.health}`)}
              </span>
              <span className={styles.progress}>
                <i style={{ width: percent(project.progress) }} />
              </span>
              <b>{project.progress}%</b>
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.stageGrid}>
          <div className={styles.graphViewport}>
            <div
              className={styles.graph}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
            >
              <svg
                className={styles.edges}
                viewBox="0 0 1320 680"
                aria-label={t(locale, "canvas.edges.ariaLabel")}
              >
                <title>{t(locale, "canvas.edges.title")}</title>
                {layer.edges.map((edge) => {
                  const from = positions.get(edge.from);
                  const to = positions.get(edge.to);
                  if (from === undefined || to === undefined) return null;
                  return (
                    <line
                      key={edge.event}
                      x1={from.x + 82}
                      y1={from.y + 35}
                      x2={to.x + 82}
                      y2={to.y + 35}
                      data-relation="causedBy"
                      data-event={edge.event}
                    />
                  );
                })}
              </svg>
              {layer.nodes.map((node) => {
                const position = positions.get(node.id);
                if (position === undefined) return null;
                return (
                  <button
                    type="button"
                    key={node.id}
                    className={styles.node}
                    style={{ left: position.x, top: position.y }}
                    data-kind={node.kind}
                    data-completed={node.completed}
                    aria-pressed={selectedNode === node.id}
                    onClick={() => setSelectedNode(node.id)}
                  >
                    <span className={styles.kind}>
                      {t(locale, `canvas.node.${node.kind}`)}
                    </span>
                    <strong>{node.label}</strong>
                    {node.status ? <small>{node.status}</small> : null}
                    {node.progress === undefined ? null : <b>{node.progress}%</b>}
                  </button>
                );
              })}
            </div>
          </div>
          <aside className={styles.inspector}>
            {level === "workspace" ? (
              <label>
                {t(locale, "canvas.agent.label")}
                <select
                  value={layer.agent ?? ""}
                  onChange={(event) => setAgentId(event.target.value)}
                >
                  {layer.project?.nodes
                    .filter((node) => node.kind === "agent")
                    .map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.label}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            {selected === null ? (
              <p>{t(locale, "canvas.inspect.empty")}</p>
            ) : (
              <>
                <span className={styles.kind}>
                  {t(locale, `canvas.node.${selected.kind}`)}
                </span>
                <h2>{selected.label}</h2>
                <dl>
                  <div>
                    <dt>ID</dt>
                    <dd>{selected.id}</dd>
                  </div>
                  <div>
                    <dt>{t(locale, "canvas.inspect.status")}</dt>
                    <dd>{selected.status ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>{t(locale, "canvas.inspect.executor")}</dt>
                    <dd>{selected.executor ?? "—"}</dd>
                  </div>
                </dl>
                <h3>{t(locale, "canvas.inspect.sources")}</h3>
                <ul>
                  {selected.sourceEvents.map((event) => (
                    <li key={event}>{event}</li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
