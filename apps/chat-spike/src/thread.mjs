/**
 * The thread reducer — docs/product/threads.md, ADR-006.
 *
 * A pure fold over events. Same log in, same thread out, every time: that is
 * what makes the UI a projection rather than a second source of truth
 * (ADR-005). Nothing here reaches for storage, a clock, or a network.
 *
 * A thread is scoped to a task; messages sent without one land in the project
 * thread, which is all the spike has.
 *
 * Interleaving is the point. A thread showing only messages reads as
 * disembodied chat; folding in lifecycle events makes it a record of the work.
 */

/**
 * The legal moves, from ADR-002. The reducer *applies*; it never judges — a
 * reducer that rejected an event could not replay a log written by a runtime
 * that once allowed it. Legality is enforced at the MCP boundary, and this table
 * is exported so both sides read the same one.
 */
export const TRANSITIONS = {
  "task.created": { from: [], to: "created" },
  "task.assigned": { from: ["created", "assigned", "review"], to: "assigned" },
  "task.started": { from: ["assigned", "blocked"], to: "running" },
  "task.blocked": { from: ["running"], to: "blocked" },
  "task.unblocked": { from: ["blocked"], to: "running" },
  "task.review.requested": { from: ["running"], to: "review" },
  "task.completed": { from: ["review"], to: "completed" },
  "task.failed": { from: ["running", "assigned", "blocked"], to: "failed" },
  "task.cancelled": {
    from: ["created", "assigned", "running", "blocked", "review"],
    to: "cancelled",
  },
};

/** @returns {{items: object[], agents: Record<string, object>, tasks: Record<string, object>}} */
export function emptyThread() {
  return { items: [], agents: {}, tasks: {} };
}

/**
 * Two things the log deliberately does **not** carry, and why:
 *
 *  - `ms` (turn latency) is *derived* here from the causal chain, not stored.
 *    A field that can be reduced from the log must not also be written to it.
 *  - `fresh` (vendor cold start) is not in the log at all. It describes the
 *    adapter's session, not the project, so it is live telemetry that replay
 *    correctly forgets.
 *
 * @param {ReturnType<typeof emptyThread>} state
 * @param {object} evt
 */
export function reduce(state, evt) {
  switch (evt.type) {
    case "agent.registered": {
      const { id, name, provider, capabilities, integration } = evt.payload;
      return {
        ...state,
        agents: {
          ...state.agents,
          [id]: { id, name, provider, capabilities, integration },
        },
        items: [
          ...state.items,
          {
            kind: "divider",
            id: evt.id,
            at: evt.at,
            seq: evt.seq,
            label: `${name} 加入会话`,
            tone: "neutral",
          },
        ],
      };
    }

    case "task.created":
    case "task.assigned":
    case "task.started":
    case "task.blocked":
    case "task.unblocked":
    case "task.review.requested":
    case "task.completed":
    case "task.failed":
    case "task.cancelled": {
      const id = evt.subject?.id ?? evt.payload.task;
      const prior = state.tasks[id] ?? { id, title: id, requires: [], executor: null };
      const task = {
        ...prior,
        ...(evt.payload.title ? { title: evt.payload.title } : {}),
        ...(evt.payload.requires ? { requires: evt.payload.requires } : {}),
        ...(evt.payload.executor !== undefined ? { executor: evt.payload.executor } : {}),
        status: TRANSITIONS[evt.type].to,
      };
      return {
        ...state,
        tasks: { ...state.tasks, [id]: task },
        // Interleaving is the point: a thread of only messages reads as
        // disembodied chat, while lifecycle events make it a record of the work.
        items: [
          ...state.items,
          {
            kind: "lifecycle",
            id: evt.id,
            at: evt.at,
            seq: evt.seq,
            task: id,
            status: task.status,
            label: lifecycleLabel(evt, task),
            actorKind: evt.actor.kind,
          },
        ],
      };
    }

    case "message.sent": {
      const { from, to, content, type, task } = evt.payload;

      // Latency and causal depth are both *derived* from the message this one
      // answers. Depth is what makes a delegation chain legible — and it is the
      // same number the runtime budgets on, computed the same way from the same
      // links, so the UI cannot disagree with the enforcement.
      let ms;
      let depth = 0;
      if (evt.causedBy) {
        const cause = state.items.find((i) => i.id === evt.causedBy);
        if (cause) {
          ms = Date.parse(evt.at) - Date.parse(cause.at);
          depth = (cause.depth ?? 0) + 1;
        }
      }

      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "message",
            id: evt.id,
            at: evt.at,
            seq: evt.seq,
            actorKind: evt.actor.kind,
            from,
            to,
            messageType: type,
            text: content,
            agent: state.agents[from] ?? null,
            // Which thread this message joins. Absent means the project thread —
            // mcp-protocol.md; agents should scope to a task whenever one applies.
            task: task ?? null,
            causedBy: evt.causedBy ?? null,
            depth,
            ...(ms !== undefined ? { ms } : {}),
          },
        ],
      };
    }

    default:
      // An unknown type is not an error — old logs outlive the code that reads
      // them, and a reducer that throws on one can never replay history.
      return state;
  }
}

const LIFECYCLE_TEXT = {
  "task.created": (t) => `建了任务 ${t.id}：${t.title}`,
  "task.assigned": (t, names) => `${t.id} 指派给 ${names(t.executor)}`,
  "task.started": (t, names) => `${names(t.executor)} 开始做 ${t.id}`,
  "task.blocked": (t) => `${t.id} 被阻塞`,
  "task.unblocked": (t) => `${t.id} 解除阻塞`,
  "task.review.requested": (t) => `${t.id} 交付待验收`,
  "task.completed": (t) => `${t.id} 已验收`,
  "task.failed": (t) => `${t.id} 失败`,
  "task.cancelled": (t) => `${t.id} 已取消`,
};

function lifecycleLabel(evt, task) {
  return LIFECYCLE_TEXT[evt.type](task, (id) => id ?? "—");
}

/** Fold a whole log. This is the definition of "the thread". */
export function project(events) {
  return events.reduce(reduce, emptyThread());
}
