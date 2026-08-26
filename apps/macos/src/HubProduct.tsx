import { useEffect, useMemo, useState } from "react";
import { App } from "./App.js";
import type { TaskCreationClient } from "./App.js";
import styles from "./HubProduct.module.css";
import type { ProjectLibraryViewModel } from "./ProjectLibrary.js";
import type { ProjectPulseViewModel } from "./Pulse.js";
import type { ConversationProjectViewModel, HumanPostingClient } from "./Threads.js";
import type { HumanTaskReviewClient, ProjectWorkforceViewModel } from "./Workforce.js";
import { type Locale, t } from "./i18n.js";

const HUB_BASE = "/hub";
const PROJECT = "proj_hub";

type HubTask = Readonly<{
  id: string;
  title: string;
  status: string;
  requires: readonly string[];
  executor: string | null;
}>;
type HubAgent = Readonly<{
  id: string;
  label: string;
  role: string;
  capabilities: readonly string[];
  busy: boolean;
  hasSession: boolean;
  integration: Readonly<{
    participates: boolean;
    streaming: boolean;
    reasoning: boolean;
    session: boolean;
    usage: boolean;
  }>;
}>;
type ThreadItem = Readonly<{
  kind: "message" | "lifecycle" | "divider";
  id: string;
  at: string;
  seq: number;
  task?: string | null;
  status?: string;
  actorKind?: string;
  from?: string;
  to?: string;
  messageType?: string;
  text?: string;
  causedBy?: string | null;
}>;
type HubThread = Readonly<{
  items: readonly ThreadItem[];
  tasks: Readonly<Record<string, HubTask>>;
}>;
type Snapshot = Readonly<{
  thread: HubThread;
  agents: readonly HubAgent[];
}>;

const taskStatuses = [
  "created",
  "assigned",
  "running",
  "blocked",
  "review",
  "completed",
  "failed",
  "cancelled",
] as const;
type TaskStatus = (typeof taskStatuses)[number];

function statusOf(value: string): TaskStatus {
  return taskStatuses.includes(value as TaskStatus) ? (value as TaskStatus) : "created";
}

function progressOf(status: TaskStatus): number {
  return {
    created: 0,
    assigned: 15,
    running: 50,
    blocked: 50,
    review: 100,
    completed: 100,
    failed: 100,
    cancelled: 100,
  }[status];
}

function sourceEventsFor(snapshot: Snapshot, task?: string): readonly string[] {
  return snapshot.thread.items
    .filter((item) => (task === undefined ? true : item.task === task))
    .map((item) => item.id);
}

export function workforceFromHub(snapshot: Snapshot): ProjectWorkforceViewModel {
  const tasks = Object.values(snapshot.thread.tasks).map((task) => {
    const status = statusOf(task.status);
    const candidates = snapshot.agents.filter((agent) =>
      task.requires.every((capability) => agent.capabilities.includes(capability)),
    );
    const assignment = task.executor
      ? ({ kind: "assigned", executor: task.executor } as const)
      : candidates.length > 0
        ? ({
            kind: "awaiting-assignment",
            candidate: { agent: candidates[0]?.id ?? "", host: "hub" },
          } as const)
        : ({ kind: "no-capability", requiredCapabilities: task.requires } as const);
    return {
      task: task.id,
      title: task.title,
      goal: task.title,
      status,
      progress: progressOf(status),
      priority: "medium" as const,
      owner: "you",
      ...(task.executor === null ? {} : { executor: task.executor }),
      requires: task.requires,
      assignment,
      awaitingHumanReview: status === "review",
      sourceEvents: sourceEventsFor(snapshot, task.id),
    };
  });
  const taskCounts = Object.fromEntries([
    ["all", tasks.length],
    ...taskStatuses.map((status) => [
      status,
      tasks.filter((task) => task.status === status).length,
    ]),
  ]) as ProjectWorkforceViewModel["taskCounts"];
  const agents = snapshot.agents.map((agent) => {
    const currentTasks = tasks
      .filter(
        (task) =>
          task.executor === agent.id &&
          !new Set<TaskStatus>(["completed", "failed", "cancelled"]).has(task.status),
      )
      .map((task) => task.task);
    return {
      agent: agent.id,
      name: agent.label,
      provider: agent.id,
      role: agent.role,
      concurrency: 1,
      availability: agent.busy ? ("saturated" as const) : ("available" as const),
      active: agent.busy ? 1 : 0,
      completed: tasks.filter(
        (task) => task.executor === agent.id && task.status === "completed",
      ).length,
      failed: tasks.filter(
        (task) => task.executor === agent.id && task.status === "failed",
      ).length,
      capabilities: agent.capabilities,
      currentTasks,
      placements: [
        {
          host: "hub",
          capabilities: agent.capabilities,
          connected: true,
          accepting: !agent.busy,
          active: agent.busy ? 1 : 0,
          integration: agent.integration,
          sourceEvents: sourceEventsFor(snapshot),
        },
      ],
      sourceEvents: sourceEventsFor(snapshot),
    };
  });
  const capabilities = [
    ...new Set(snapshot.agents.flatMap((agent) => agent.capabilities)),
  ].sort();
  return {
    project: PROJECT,
    observedAt: new Date().toISOString(),
    taskCounts,
    agentCounts: {
      logical: agents.length,
      connected: agents.length,
      available: agents.filter((agent) => agent.availability === "available").length,
      activeDispatches: agents.reduce((sum, agent) => sum + agent.active, 0),
    },
    tasks,
    agents,
    coverage: capabilities.map((capability) => ({
      capability,
      covered: true,
      agents: agents
        .filter((agent) => agent.capabilities.includes(capability))
        .map((agent) => agent.agent),
      placements: agents.filter((agent) => agent.capabilities.includes(capability))
        .length,
      sourceEvents: sourceEventsFor(snapshot),
    })),
    threads: { available: false },
  };
}

const dividerType = {
  running: "task.started",
  blocked: "task.blocked",
  review: "task.review.requested",
  completed: "task.completed",
  failed: "task.failed",
  cancelled: "task.cancelled",
} as const;

export function conversationFromHub(snapshot: Snapshot): ConversationProjectViewModel {
  type ConversationThread = ConversationProjectViewModel["threads"][string];
  type ConversationItem = ConversationThread["items"][number];
  const threads: Record<
    string,
    {
      task?: string;
      title?: string;
      status?: string;
      progress?: number;
      executor?: string;
      items: ConversationItem[];
    }
  > = {
    $project: { items: [] },
  };
  for (const task of Object.values(snapshot.thread.tasks)) {
    const status = statusOf(task.status);
    threads[task.id] = {
      task: task.id,
      title: task.title,
      status,
      progress: progressOf(status),
      ...(task.executor === null ? {} : { executor: task.executor }),
      items: [],
    };
  }
  for (const item of snapshot.thread.items) {
    const key = item.task ?? "$project";
    if (threads[key] === undefined) threads[key] = { task: key, title: key, items: [] };
    const thread = threads[key];
    if (item.kind === "message" && item.from && item.to && item.text) {
      const allowed = new Set([
        "instruction",
        "question",
        "answer",
        "report",
        "review",
        "warning",
        "progress",
      ]);
      thread.items.push({
        kind: "message",
        event: {
          id: item.id,
          seq: item.seq,
          at: item.at,
          actor: { kind: item.actorKind ?? "agent", id: item.from },
          type: "message.sent",
          payload: {
            from: item.from,
            to: item.to,
            type: allowed.has(item.messageType ?? "") ? item.messageType : "report",
            content: item.text,
            ...(item.causedBy ? { replyTo: item.causedBy } : {}),
          },
        },
      } as ConversationItem);
    } else if (item.kind === "lifecycle" && item.status && item.status in dividerType) {
      thread.items.push({
        kind: "divider",
        event: {
          id: item.id,
          seq: item.seq,
          at: item.at,
          type: dividerType[item.status as keyof typeof dividerType],
          payload: { task: key },
        },
      } as ConversationItem);
    }
  }
  return { threads };
}

function libraryFromHub(
  snapshot: Snapshot,
  workforce: ProjectWorkforceViewModel,
): ProjectLibraryViewModel {
  const latest = snapshot.thread.items.at(-1);
  const active = workforce.tasks.find((task) =>
    new Set<TaskStatus>(["assigned", "running", "blocked", "review"]).has(task.status),
  );
  const sourceEvents = sourceEventsFor(snapshot);
  const progress = workforce.tasks.length
    ? Math.round(
        workforce.tasks.reduce((sum, task) => sum + task.progress, 0) /
          workforce.tasks.length,
      )
    : 0;
  return {
    now: new Date().toISOString(),
    counts: { all: 1, active: 1, paused: 0, archived: 0, completed: 0 },
    projects: [
      {
        project: PROJECT,
        name: "Agent OS Workspace",
        state: "active",
        stack: ["Hub", "MCP", "Event Log"],
        progress,
        currentWork: active
          ? {
              task: active.task,
              title: active.title,
              status: active.status,
              priority: active.priority,
              sourceEvents: active.sourceEvents,
            }
          : null,
        health: {
          status: workforce.taskCounts.blocked > 0 ? "blocked" : "healthy",
          sourceEvents,
        },
        summary: {
          text: `${workforce.taskCounts.all} tasks · ${workforce.agentCounts.connected} agents connected`,
          sourceEvents,
        },
        agents: workforce.agents.map((agent) => ({
          id: agent.agent,
          name: agent.name,
          status: agent.active > 0 ? "working" : "idle",
          sourceEvents: agent.sourceEvents,
        })),
        lastActivity: {
          at: latest?.at ?? new Date().toISOString(),
          actor: latest?.from ?? latest?.actorKind ?? "runtime",
          type: latest?.kind ?? "agent.registered",
          sourceEvents: latest ? [latest.id] : [],
        },
        dormantDays: 0,
        revival: null,
        snapshots: [],
        nextSteps: [],
        timeline: [],
        knowledge: [],
        files: [],
      },
    ],
    insights: null,
  };
}

function pulseFromHub(
  snapshot: Snapshot,
  workforce: ProjectWorkforceViewModel,
): ProjectPulseViewModel {
  const now = new Date();
  const sourceEvents = sourceEventsFor(snapshot);
  const activeTasks = workforce.tasks.filter((task) =>
    new Set<TaskStatus>(["assigned", "running", "blocked", "review"]).has(task.status),
  );
  const blocked = workforce.tasks.filter((task) => task.status === "blocked");
  return {
    project: PROJECT,
    window: {
      startInclusive: new Date(now.getTime() - 86_400_000).toISOString(),
      endExclusive: now.toISOString(),
    },
    kpis: {
      activeAgents: { value: workforce.agentCounts.activeDispatches, sourceEvents },
      activeTasks: { value: activeTasks.length, sourceEvents },
      doneToday: { value: workforce.taskCounts.completed, sourceEvents },
      blockers: { value: blocked.length, sourceEvents },
    },
    topConsequence: blocked[0]
      ? {
          kind: "overdue-blocker",
          title: blocked[0].title,
          detail: "Task is blocked and needs attention.",
          actionable: true,
          sourceEvents: blocked[0].sourceEvents,
        }
      : null,
    story: null,
    progress: workforce.tasks.map((task) => ({
      task: task.task,
      title: task.title,
      progress: task.progress,
      delta: 0,
      sourceEvents: task.sourceEvents,
    })),
    activity: [],
    risks: [],
    knowledge: [],
    research: [],
    moments: [],
  };
}

async function hubFetch(path: string, init: RequestInit = {}) {
  return fetch(`${HUB_BASE}${path}`, { ...init, credentials: "same-origin" });
}

async function readEventStream(
  response: Response,
  receive: (value: Record<string, unknown>) => void,
) {
  if (!response.body) throw new Error("Hub returned no event stream");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) receive(JSON.parse(data));
    }
  }
}

export function HubProduct() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<"connecting" | "login" | "connected" | "retrying">(
    "connecting",
  );
  const [loginError, setLoginError] = useState("");
  const [generation, setGeneration] = useState(0);
  const [entryLocale, setEntryLocale] = useState<Locale>("zh-CN");

  useEffect(() => {
    // A successful interactive login increments this key to create a fresh SSE lifecycle.
    void generation;
    const controller = new AbortController();
    let stopped = false;
    const delay = () => new Promise((resolve) => setTimeout(resolve, 1000));
    const run = async () => {
      while (!stopped) {
        try {
          const response = await hubFetch("/events", { signal: controller.signal });
          if (response.status === 401) {
            const local = await hubFetch("/auth/local", { method: "POST" });
            if (local.ok) continue;
            setStatus("login");
            return;
          }
          if (!response.ok) throw new Error(`Hub HTTP ${response.status}`);
          setStatus("connected");
          await readEventStream(response, (message) => {
            if (message.type === "hello") {
              setSnapshot({
                thread: message.thread as HubThread,
                agents: message.agents as readonly HubAgent[],
              });
            } else if (message.type === "event" && message.thread) {
              setSnapshot((current) =>
                current === null
                  ? null
                  : { ...current, thread: message.thread as HubThread },
              );
            } else if (message.type === "tasks") {
              setSnapshot((current) =>
                current === null
                  ? null
                  : {
                      ...current,
                      thread: {
                        ...current.thread,
                        tasks: message.tasks as Readonly<Record<string, HubTask>>,
                      },
                    },
              );
            } else if (message.type === "roster") {
              setSnapshot((current) =>
                current === null
                  ? null
                  : { ...current, agents: message.agents as readonly HubAgent[] },
              );
            }
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          setStatus("retrying");
        }
        await delay();
      }
    };
    void run();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [generation]);

  const models = useMemo(() => {
    if (snapshot === null) return null;
    const workforce = workforceFromHub(snapshot);
    return {
      workforce,
      conversation: conversationFromHub(snapshot),
      library: libraryFromHub(snapshot, workforce),
      pulse: pulseFromHub(snapshot, workforce),
    };
  }, [snapshot]);

  const postingClient = useMemo<HumanPostingClient>(
    () => ({
      async sendMessage(intent) {
        const response = await hubFetch("/say", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: intent.content,
            to: intent.to,
            ...(intent.task ? { task: intent.task } : {}),
          }),
        });
        if (!response.ok) throw new Error("Hub rejected the message");
      },
    }),
    [],
  );
  const taskCreationClient = useMemo<TaskCreationClient>(
    () => ({
      async createTask(input) {
        const response = await hubFetch("/task", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: input.title, requires: input.requires }),
        });
        if (!response.ok) throw new Error("Hub rejected the task");
      },
    }),
    [],
  );
  const taskReviewClient = useMemo<HumanTaskReviewClient>(
    () => ({
      async reviewTask(input) {
        const response = await hubFetch("/accept", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: input.task, ok: input.accepted }),
        });
        if (!response.ok) throw new Error("Hub rejected the review decision");
      },
    }),
    [],
  );

  if (status === "login") {
    return (
      <main className={styles.entry}>
        <form
          className={styles.loginCard}
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const token = String(form.get("token") ?? "").trim();
            event.currentTarget.reset();
            if (!token) return;
            setLoginError("");
            const response = await hubFetch("/auth/session", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ token }),
            });
            if (!response.ok) {
              setLoginError(t(entryLocale, "entry.invalid"));
              return;
            }
            setStatus("connecting");
            setGeneration((current) => current + 1);
          }}
        >
          <span className={styles.mark}>A</span>
          <span className={styles.eyebrow}>{t(entryLocale, "entry.eyebrow")}</span>
          <h1>{t(entryLocale, "entry.title")}</h1>
          <p>{t(entryLocale, "entry.detail")}</p>
          <label htmlFor="hub-token">{t(entryLocale, "entry.token")}</label>
          <input
            id="hub-token"
            name="token"
            type="password"
            autoComplete="off"
            required
          />
          <button type="submit">{t(entryLocale, "entry.action")}</button>
          <button
            type="button"
            className={styles.languageAction}
            onClick={() =>
              setEntryLocale((current) => (current === "zh-CN" ? "en" : "zh-CN"))
            }
          >
            {t(entryLocale, "entry.language")}
          </button>
          <span className={styles.error} role="alert">
            {loginError}
          </span>
        </form>
      </main>
    );
  }

  if (models === null || snapshot === null) {
    return (
      <main className={styles.entry}>
        <section className={styles.loadingCard}>
          <span className={styles.mark}>A</span>
          <h1>
            {status === "retrying"
              ? t(entryLocale, "entry.reconnecting")
              : t(entryLocale, "entry.connecting")}
          </h1>
          <p>{t(entryLocale, "entry.loadingDetail")}</p>
        </section>
      </main>
    );
  }

  return (
    <App
      pulse={models.pulse}
      library={models.library}
      workforce={models.workforce}
      conversation={models.conversation}
      postingPolicy={{ enabled: true, sourceEvents: sourceEventsFor(snapshot) }}
      postingClient={postingClient}
      connected
      taskCreationClient={taskCreationClient}
      taskReviewClient={taskReviewClient}
    />
  );
}
