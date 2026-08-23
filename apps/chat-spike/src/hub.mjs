/**
 * The Agent Hub runtime — the seam between the two channels.
 *
 * The spike proved each channel separately: Agent OS can wake any of four
 * vendors, and three of them can call our tools unaided. It never joined them,
 * because `to` was always the human. This is the join:
 *
 *   agent A ──send_message(to: B)──▶ [validate] ──▶ event log
 *                                                      │
 *                                        runtime sees the recipient is an agent
 *                                                      ▼
 *                                   get_context ──▶ wake B ──▶ B replies
 *
 * Nothing is handed between A and B. B is woken with context rebuilt from the
 * log, which is the only reason a human and an agent can address it the same
 * way. Delegation is therefore not a feature — it is what routing already does.
 *
 * Two rules this file exists to hold:
 *
 *   - **One queue per agent.** A global queue would make "A waits while B works"
 *     impossible, which is the whole point of more than one agent.
 *   - **A causal chain has a budget.** A→B→A→B is free to the model and not to
 *     the user. Depth is derived from `causedBy`, never stored (ADR-005).
 */

import { makeEvent } from "./events.mjs";
import { participates } from "./mcp-mount.mjs";
import { HUMAN_ID, createToolRouter } from "./mcp-tools.mjs";
import { RUNNER_INTERFACE_METHODS } from "./runners/contract.mjs";
import { TRANSITIONS, project } from "./thread.mjs";
import { ValidationError } from "./validate.mjs";

/** How many agent→agent hops one human message may cause before it is stopped. */
export const DEFAULT_BUDGET = 6;

function requireRunner(runner) {
  if (!runner || typeof runner !== "object") {
    throw new TypeError("Hub.runner 必须实现共享 Runner 接口");
  }
  const missing = RUNNER_INTERFACE_METHODS.filter(
    (method) => typeof runner[method] !== "function",
  );
  if (missing.length > 0) {
    throw new TypeError(`Hub.runner 缺少共享接口方法：${missing.join(", ")}`);
  }
  return runner;
}

export class Hub {
  /**
   * @param {object} opts
   * @param {import("./log.mjs").EventLog} opts.log
   * @param {string} opts.projectId
   * @param {(type: string, data: object) => void} opts.broadcast
   * @param {(id: string) => any} opts.getAdapter   provider catalog lookup only
   * @param {number} [opts.budget]
   * @param {object} opts.runner                    complete shared execution contract
   * @param {string} [opts.userId] authenticated owner of Runner sessions
   */
  constructor({ log, projectId, broadcast, getAdapter, budget, runner, userId }) {
    this.log = log;
    this.projectId = projectId;
    this.broadcast = broadcast;
    this.getAdapter = getAdapter;
    this.budget = budget ?? DEFAULT_BUDGET;
    this.runner = requireRunner(runner);
    this.userId = userId ?? HUMAN_ID;

    /** @type {Map<string, {id, label, adapterId, queue, busy, integration}>} */
    this.agents = new Map();
    /** Causal index for depth. Rebuilt on boot so a restart keeps its budgets. */
    this.byId = new Map();
    /** Registration idempotency also survives a Hub restart. */
    this.announcedIds = new Set();
    for (const e of log.replay()) {
      this.byId.set(e.id, e);
      if (e.type === "agent.registered" && e.payload?.id) {
        this.announcedIds.add(e.payload.id);
      }
    }

    this.tools = createToolRouter(this.runtime());
  }

  // ---------------------------------------------------------------- emitting

  emit(event) {
    const stored = this.log.append(event);
    this.byId.set(stored.id, stored);
    this.broadcast("event", { event: stored });
    return stored;
  }

  /**
   * How many links back to the human who started this. Derived, because the log
   * already knows — storing it would be a second source of truth for something
   * a walk can answer.
   */
  depthOf(eventId) {
    let depth = 0;
    let cur = eventId ? this.byId.get(eventId) : null;
    while (cur?.causedBy && depth < 1000) {
      depth++;
      cur = this.byId.get(cur.causedBy);
    }
    return depth;
  }

  /**
   * Resolve a reply link without letting an agent choose the budget it sees.
   * During a wake the runtime-owned cause always wins, even when the caller
   * supplies a different `replyTo`. Outside a wake, a reply may only target a
   * stored message that was actually addressed to that agent.
   */
  causeFor(agentId, requestedId) {
    const active = this.agents.get(agentId)?.cause;
    if (active?.id) return active.id;
    if (!requestedId) return undefined;

    const requested = this.byId.get(requestedId);
    if (requested?.type !== "message.sent" || requested.payload?.to !== agentId) {
      throw new ValidationError(
        `replyTo ${requestedId} 不是发给 "${agentId}" 的消息，不能作为回复目标`,
      );
    }
    return requested.id;
  }

  // ------------------------------------------------------------------ agents

  /** Registration is idempotent: re-registering reconnects, per mcp-protocol.md. */
  register(id, { capabilities = [], role = "worker" } = {}) {
    const catalogEntry = this.getAdapter(id);
    if (!catalogEntry) throw new Error(`未知 provider：${id}`);
    if (this.agents.has(id)) return this.agents.get(id);

    const entry = {
      id,
      label: catalogEntry.label,
      adapterId: catalogEntry.id ?? id,
      queue: Promise.resolve(),
      busy: false,
      role,
      capabilities,
      /** The message this agent is currently answering, for causal linkage. */
      cause: null,
      /** The task this agent is currently working, so its messages are scoped. */
      task: null,
      /** Whether `agent.registered` has been written for it. */
      announced: this.announcedIds.has(id),
      integration: { ...catalogEntry.capabilities, participates: participates(id) },
    };
    this.agents.set(id, entry);

    this.tools.call("register_agent", {
      id,
      name: catalogEntry.label,
      provider: id,
      role,
      capabilities,
    });
    return entry;
  }

  roster() {
    return [...this.agents.values()].map((a) => ({
      id: a.id,
      label: a.label,
      role: a.role,
      capabilities: a.capabilities,
      integration: a.integration,
      busy: a.busy,
      hasSession: this.runner.hasSession({
        user: this.userId,
        project: this.projectId,
        agent: a.id,
      }),
    }));
  }

  broadcastExecutionEvent(entry, event) {
    if (event.kind === "delta") {
      this.broadcast("delta", { agent: entry.id, text: event.text });
    } else if (event.kind === "thought") {
      this.broadcast("thought", { agent: entry.id, text: event.text });
    } else if (event.kind === "usage") {
      this.broadcast("usage", { agent: entry.id, ...event });
    } else if (["started", "completed", "failed"].includes(event.kind)) {
      this.broadcast("runner", { agent: entry.id, event });
    } else {
      this.broadcast("progress", {
        agent: entry.id,
        kind: event.label ?? "event",
      });
    }
  }

  broadcastTurnError(entry, error) {
    const normalized = error?.error;
    this.broadcast("error", {
      agent: entry.id,
      message: String(normalized?.message ?? error?.message ?? error),
      ...(normalized?.requestId ? { requestId: normalized.requestId } : {}),
      ...(normalized?.code ? { code: normalized.code } : {}),
      ...(typeof normalized?.retryable === "boolean"
        ? { retryable: normalized.retryable }
        : {}),
    });
  }

  async requireExecutionReady() {
    const health = await this.runner.health();
    if (health?.ready === true) return;
    throw new ValidationError(
      "Runner 尚未就绪，未写入会唤醒 agent 的事件；请等待 Worker 连接后重试",
    );
  }

  // ------------------------------------------------------------------- tasks

  /** Current derived task state. Never stored — this is a fold, every time. */
  tasks() {
    return project(this.log.replay()).tasks;
  }

  /**
   * Legality is checked here, at the boundary, and the illegal move is
   * *rejected* rather than corrected (ADR-002). Correcting would mean the log
   * records a transition nobody asked for.
   */
  guard(taskId, type) {
    const task = this.tasks()[taskId];
    if (!task) throw new ValidationError(`没有任务 ${taskId}`);
    const rule = TRANSITIONS[type];
    if (!rule.from.includes(task.status)) {
      throw new ValidationError(
        `${taskId} 现在是 ${task.status}，不能 ${type}（只允许从 ${rule.from.join(" / ")}）`,
      );
    }
    return task;
  }

  taskEvent(type, taskId, payload, actor) {
    return this.emit(
      makeEvent({
        type,
        project: this.projectId,
        actor: actor ?? { kind: "system", id: "runtime" },
        subject: { kind: "task", id: taskId },
        causedBy:
          actor?.kind === "agent" ? this.agents.get(actor.id)?.cause?.id : undefined,
        payload: { task: taskId, ...payload },
      }),
    );
  }

  // ----------------------------------------------------------------- routing

  /**
   * The seam. A stored `message.sent` addressed to an agent becomes a wake.
   * Deliberately not awaited by the caller: the sender's turn must finish and
   * release its own queue, or an A→B→A exchange would deadlock on itself.
   */
  route(stored) {
    const to = stored.payload?.to;
    if (!to || to === HUMAN_ID) return;
    const entry = this.agents.get(to);
    if (!entry) return;

    const depth = this.depthOf(stored.id);
    if (depth >= this.budget) return this.stopRunaway(stored, depth);

    this.enqueue(entry, stored);
  }

  /**
   * A budget stop is addressed to the humans, not logged as telemetry — the
   * people reading the thread are the ones who have to decide what happens next.
   */
  stopRunaway(stored, depth) {
    this.emit(
      makeEvent({
        type: "message.sent",
        project: this.projectId,
        actor: { kind: "system", id: "runtime" },
        subject: { kind: "project", id: this.projectId },
        causedBy: stored.id,
        payload: {
          from: "runtime",
          to: HUMAN_ID,
          type: "warning",
          content:
            `因果链已达 ${depth} 跳（预算 ${this.budget}），停止继续唤醒。` +
            `最后一条是 ${stored.payload.from} → ${stored.payload.to}。需要继续请直接对它说话。`,
        },
      }),
    );
    this.broadcast("budget", { depth, budget: this.budget });
  }

  enqueue(entry, cause) {
    entry.queue = entry.queue
      .then(() => this.turn(entry, cause))
      .catch((err) => {
        this.broadcastTurnError(entry, err);
      });
    return entry.queue;
  }

  /**
   * One turn. The agent is woken with context rebuilt from the log — it holds no
   * memory of its own, and the measured price of that is ~2× per turn, nearly
   * independent of how much context is shipped (FINDINGS 3c).
   */
  async turn(entry, cause, taskId = null) {
    entry.busy = true;
    entry.task = taskId ?? cause?.payload?.task ?? null;
    // Remembered so the agent cannot detach itself from the causal chain. An
    // agent that omits `replyTo` would otherwise reset its own hop count to zero
    // and loop forever — the budget has to be the runtime's to enforce.
    entry.cause = cause;
    this.broadcast("roster", { agents: this.roster() });
    try {
      // Everything this agent writes during the turn lands after this mark.
      const before = this.log.seq;
      const reply = await this.execute(entry, cause, this.prompt(entry, cause));

      // An agent that already acted — sent a message, or delivered a task — has
      // spoken. Echoing its transcript on top would double every turn, and the
      // first live run of C did exactly that: `report_result` plus a verbatim
      // copy of the same summary as a message.
      if (this.actedDuring(entry.id, before)) {
        this.broadcast("turn", { agent: entry.id, ms: reply.ms, viaTools: true });
        return;
      }

      await this.tools.call(
        "send_message",
        {
          from: entry.id,
          to: cause.payload.from,
          type: "answer",
          content: reply.text || "（空回复）",
          ...(entry.task ? { task: entry.task } : {}),
          replyTo: cause.id,
        },
        entry.id,
      );
      this.broadcast("turn", { agent: entry.id, ms: reply.ms, fresh: reply.fresh });
    } finally {
      entry.busy = false;
      entry.cause = null;
      entry.task = null;
      this.broadcast("roster", { agents: this.roster() });
    }
  }

  /** Run one prompt through the shared Runner — the Hub has no execution path of its own. */
  execute(entry, cause, prompt) {
    if (!cause?.id) {
      throw new ValidationError("Runner dispatch 缺少 runtime-owned cause id");
    }
    return this.runner.dispatch(
      {
        requestId: cause.id,
        user: this.userId,
        project: this.projectId,
        agent: entry.id,
        adapter: entry.adapterId,
        workspace: entry.id,
        prompt,
        ...(entry.task ? { taskId: entry.task } : {}),
        causedBy: cause.id,
      },
      { onEvent: (event) => this.broadcastExecutionEvent(entry, event) },
    );
  }

  /**
   * Did this agent write anything at all during the turn? Keyed on the log's own
   * position rather than on causal links, because a link is something the agent
   * can omit and a `seq` is not.
   */
  actedDuring(agentId, sinceSeq) {
    for (const e of this.byId.values()) {
      if (e.seq > sinceSeq && e.actor?.kind === "agent" && e.actor.id === agentId)
        return true;
    }
    return false;
  }

  /**
   * What a woken agent is handed. Identity first: it has no idea who it is in
   * this project, and every tool call it makes has to name itself correctly.
   */
  prompt(entry, cause) {
    const ctx = this.runtime().getContext({ task: entry.task });
    const history = ctx.messages
      .slice(0, -1)
      .map((m) => `${m.from} → ${m.to}：${m.content}`)
      .join("\n");

    const task = entry.task ? this.tasks()[entry.task] : null;
    const brief = task
      ? [
          `你正在做任务 ${task.id}：${task.title}`,
          `做完后调 report_result(task: "${task.id}", status, summary) 交付。`,
          "**交付不等于完成**——它只会进入待验收，验收是别人的事，你不能验收自己的活。",
          "",
        ].join("\n")
      : "";

    const tools = entry.integration.participates
      ? [
          "你可以直接调用 Agent OS 的 MCP 工具（服务名 agent-os）：",
          "  · find_agent(capabilities) —— 找谁能干某件事。**这是发现同伴的唯一途径**，不要凭印象点名。",
          `  · send_message(from: "${entry.id}", to, type, content) —— 发言或委派。to 填 "${HUMAN_ID}" 是回给人。`,
          "  · get_context() —— 补读上下文。",
          "  · create_task(title, requires) / assign_task(task, executor) —— 拆活派活。" +
            "assign_task 不填 executor 就由运行时按能力匹配，这比你自己点名更可靠。",
          "如果你调用了 send_message，就不要在正文里重复同样的话。",
        ].join("\n")
      : "你没有工具，直接把回复写成正文即可，运行时会代你发出。";

    return [
      `你是 Agent OS 里的 agent「${entry.label}」，id 是 "${entry.id}"。`,
      tools,
      "",
      brief,
      history ? `此前的项目记录：\n${history}\n` : "",
      `${cause.payload.from} 对你说：${cause.payload.content}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // ----------------------------------------------------------------- runtime

  /** The object behind the MCP tools. Agents request; this decides. */
  runtime() {
    const hub = this;
    return {
      registeredIds: () => new Set(hub.agents.keys()),

      /**
       * Idempotent, per mcp-protocol.md: "re-registering an existing id
       * reconnects it rather than duplicating". Agents do re-register — the
       * coordinator did it unprompted on the first real run — and a second
       * `agent.registered` with nothing changed is not a fact. It is a duplicate
       * divider in every thread that replays the log, forever.
       *
       * The guard is `announced`, not membership: Hub.register puts the entry in
       * the pool *before* calling this, so a membership check would swallow the
       * very first registration.
       */
      registerAgent(p) {
        let entry = hub.agents.get(p.id);
        if (entry?.announced) return { registered: p.id, reconnected: true };

        // An agent may register itself through the tool, so this path — not only
        // Hub.register — has to create the pool entry. Without one the sender
        // passes validation and is then unreachable by anyone replying to it.
        if (!entry) {
          if (!hub.getAdapter(p.id)) {
            throw new ValidationError(`没有 "${p.id}" 的适配器，无法唤醒它`);
          }
          entry = hub.register(p.id, {
            capabilities: p.capabilities ?? [],
            role: p.role ?? "worker",
          });
          return { registered: p.id, seq: hub.log.seq };
        }

        entry.announced = true;
        hub.announcedIds.add(p.id);
        const evt = hub.emit(
          makeEvent({
            type: "agent.registered",
            project: hub.projectId,
            actor: { kind: "system", id: "runtime" },
            subject: { kind: "agent", id: p.id },
            payload: {
              id: p.id,
              name: p.name,
              provider: p.provider ?? p.id,
              role: p.role,
              capabilities: p.capabilities ?? [],
              integration: hub.agents.get(p.id)?.integration,
            },
          }),
        );
        hub.broadcast("roster", { agents: hub.roster() });
        return { registered: p.id, seq: evt.seq };
      },

      /** Capability in, candidates out. No vendor name crosses this (ADR-004). */
      findAgent(p) {
        const want = p.capabilities ?? [];
        const candidates = [...hub.agents.values()]
          .filter((a) => want.every((c) => a.capabilities.includes(c)))
          .filter((a) => (p.available ? !a.busy : true))
          .map((a) => ({
            id: a.id,
            name: a.label,
            capabilities: a.capabilities,
            busy: a.busy,
          }));
        return { candidates, matched: candidates.length };
      },

      executorOf(taskId) {
        return hub.tasks()[taskId]?.executor ?? null;
      },

      createTask(p, caller) {
        // Ids are derived from the log, so a replay produces the same ones.
        const n = hub.log.replay().filter((e) => e.type === "task.created").length + 1;
        const id = `TASK-${String(n).padStart(3, "0")}`;
        const evt = hub.taskEvent(
          "task.created",
          id,
          { title: p.title, requires: p.requires ?? [], detail: p.detail },
          caller ? { kind: "agent", id: caller } : undefined,
        );
        hub.broadcast("tasks", { tasks: hub.tasks() });
        return { task: id, status: "created", seq: evt.seq };
      },

      /**
       * Omitting `executor` is the good path: the runtime matches on capability
       * and the caller never names a vendor (ADR-004). Naming one is allowed but
       * still has to be an agent that exists.
       */
      async assignTask(p, caller) {
        await hub.requireExecutionReady();
        const task = hub.guard(p.task, "task.assigned");
        let executor = p.executor;
        if (!executor) {
          const [best] = [...hub.agents.values()]
            .filter((a) => (task.requires ?? []).every((c) => a.capabilities.includes(c)))
            .sort((x, y) => Number(x.busy) - Number(y.busy));
          if (!best) {
            throw new ValidationError(
              `没有具备 ${(task.requires ?? []).join("、") || "所需"} 能力的 agent`,
            );
          }
          executor = best.id;
        }
        const entry = hub.agents.get(executor);
        if (!entry) throw new ValidationError(`未知执行者 "${executor}"`);

        const assigned = hub.taskEvent(
          "task.assigned",
          p.task,
          { executor },
          caller ? { kind: "agent", id: caller } : undefined,
        );
        hub.broadcast("tasks", { tasks: hub.tasks() });

        // The seam again: assignment wakes, exactly as a message does.
        hub.wakeForTask(entry, p.task, {
          id: assigned.id,
          payload: {
            from: caller ?? HUMAN_ID,
            to: executor,
            task: p.task,
            content: `你被指派了 ${p.task}：${task.title}`,
          },
        });
        return { task: p.task, executor, status: "assigned" };
      },

      /**
       * `status` is the executor's *claim*. The runtime writes
       * `task.review.requested` either way — rule 3, made structural rather than
       * checked: there is no argument that reaches `completed`.
       */
      reportResult(p, caller) {
        hub.guard(p.task, "task.review.requested");
        const evt = hub.taskEvent(
          "task.review.requested",
          p.task,
          { claimed: p.status, summary: p.summary, outputs: p.outputs },
          caller ? { kind: "agent", id: caller } : undefined,
        );
        hub.broadcast("tasks", { tasks: hub.tasks() });
        return { task: p.task, status: "review", seq: evt.seq };
      },

      async sendMessage(p) {
        if (p.to !== HUMAN_ID) await hub.requireExecutionReady();
        // The runtime-owned wake cause wins over caller input. Otherwise an
        // agent could point at an older event and reset its own hop budget.
        const causedBy = hub.causeFor(p.from, p.replyTo);
        const evt = hub.emit(
          makeEvent({
            type: "message.sent",
            project: hub.projectId,
            actor: { kind: "agent", id: p.from },
            subject: { kind: "project", id: hub.projectId },
            causedBy,
            payload: {
              from: p.from,
              to: p.to,
              type: p.type,
              content: p.content,
              // Scoped to the sender's current task unless it says otherwise, so
              // a delegation chain stays in one thread without every agent
              // having to remember to say which.
              ...((p.task ?? hub.agents.get(p.from)?.task)
                ? { task: p.task ?? hub.agents.get(p.from)?.task }
                : {}),
              ...(p.attachments ? { attachments: p.attachments } : {}),
            },
          }),
        );
        hub.route(evt);
        return { id: evt.id, seq: evt.seq };
      },

      getContext(p) {
        const thread = project(hub.log.replay());
        // Scoping to a task is a filter on the same fold, never a second store.
        const scope = p?.task ? (i) => i.task === p.task || i.task == null : () => true;
        const messages = thread.items.filter((i) => i.kind === "message").filter(scope);
        if (p?.limit !== undefined && (!Number.isInteger(p.limit) || p.limit < 1)) {
          throw new ValidationError("get_context.limit 必须是正整数");
        }
        // Canonical protocol: no small default limit. A caller may explicitly
        // ask for a bounded response, but omission means the complete scope.
        const selected = p?.limit === undefined ? messages : messages.slice(-p.limit);
        return {
          project: hub.projectId,
          tasks: Object.values(thread.tasks).map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            executor: t.executor,
          })),
          messages: selected.map((i) => ({
            from: i.from,
            to: i.to,
            type: i.messageType,
            content: i.text,
          })),
          agents: hub.roster().map((a) => ({ id: a.id, name: a.label })),
        };
      },
    };
  }

  /**
   * Assignment is a wake, the same seam as a message. The executor is told what
   * it is working on; everything else it needs it reads from the log.
   */
  wakeForTask(entry, taskId, cause) {
    entry.queue = entry.queue
      .then(async () => {
        // Assignment is repeatable for re-routing, but only the current
        // assignment may start. A second queued wake observes running/review
        // and becomes a no-op instead of emitting another task.started.
        const current = this.tasks()[taskId];
        if (current?.status !== "assigned" || current.executor !== entry.id) return;
        // `task.started` is the real event that woke this turn, so it is the
        // cause. A synthetic one with no id would detach the whole turn from the
        // causal chain — the same hole `replyTo` had.
        const started = this.taskEvent("task.started", taskId, { executor: entry.id });
        await this.turn(entry, { ...cause, id: started.id }, taskId);
      })
      .catch((err) => {
        this.broadcastTurnError(entry, err);
      });
    return entry.queue;
  }

  /**
   * Acceptance is the human's act and has no tool. That is the point: rule 5
   * says a message in a thread is guidance, never a grant, so there must be no
   * way to reach `completed` by saying something persuasive.
   */
  accept(taskId, ok = true) {
    this.guard(taskId, ok ? "task.completed" : "task.assigned");
    if (ok) this.taskEvent("task.completed", taskId, {}, { kind: "human", id: HUMAN_ID });
    else {
      const t = this.tasks()[taskId];
      this.taskEvent(
        "task.assigned",
        taskId,
        { executor: t.executor },
        { kind: "human", id: HUMAN_ID },
      );
      this.wakeForTask(this.agents.get(t.executor), taskId, {
        id: null,
        payload: {
          from: HUMAN_ID,
          to: t.executor,
          task: taskId,
          content: `${taskId} 未通过验收，请重做。`,
        },
      });
    }
    this.broadcast("tasks", { tasks: this.tasks() });
  }

  /** A human message enters through the same door an agent's does. */
  say(text, to) {
    const stored = this.emit(
      makeEvent({
        type: "message.sent",
        project: this.projectId,
        actor: { kind: "human", id: HUMAN_ID },
        subject: { kind: "project", id: this.projectId },
        payload: { from: HUMAN_ID, to, type: "instruction", content: text },
      }),
    );
    this.route(stored);
    return stored;
  }

  async resetSession(agentId) {
    const entry = this.agents.get(agentId);
    if (!entry) throw new ValidationError(`未知 agent "${agentId}"`);
    await this.runner.resetSession({
      user: this.userId,
      project: this.projectId,
      agent: agentId,
    });
  }

  async close() {
    await this.runner.close();
  }
}
