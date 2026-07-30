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
import { mountMcp, participates } from "./mcp-mount.mjs";
import { HUMAN_ID, createToolRouter } from "./mcp-tools.mjs";
import { project } from "./thread.mjs";
import { ValidationError } from "./validate.mjs";

/** How many agent→agent hops one human message may cause before it is stopped. */
export const DEFAULT_BUDGET = 6;

export class Hub {
  /**
   * @param {object} opts
   * @param {import("./log.mjs").EventLog} opts.log
   * @param {string} opts.projectId
   * @param {(type: string, data: object) => void} opts.broadcast
   * @param {(id: string) => any} opts.getAdapter   adapter class by provider id
   * @param {string} opts.workspace                 per-agent directories live here
   * @param {string} opts.url                       where the MCP bridge calls back
   * @param {number} [opts.budget]
   */
  constructor({ log, projectId, broadcast, getAdapter, workspace, url, budget }) {
    this.log = log;
    this.projectId = projectId;
    this.broadcast = broadcast;
    this.getAdapter = getAdapter;
    this.workspace = workspace;
    this.url = url;
    this.budget = budget ?? DEFAULT_BUDGET;

    /** @type {Map<string, {id, label, adapter, queue, busy, integration}>} */
    this.agents = new Map();
    /** Causal index for depth. Rebuilt on boot so a restart keeps its budgets. */
    this.byId = new Map();
    for (const e of log.replay()) this.byId.set(e.id, e);

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

  // ------------------------------------------------------------------ agents

  /** Registration is idempotent: re-registering reconnects, per mcp-protocol.md. */
  register(id, { capabilities = [], role = "worker" } = {}) {
    const Cls = this.getAdapter(id);
    if (!Cls) throw new Error(`未知 provider：${id}`);
    if (this.agents.has(id)) return this.agents.get(id);

    const entry = {
      id,
      label: Cls.label,
      Cls,
      adapter: null,
      queue: Promise.resolve(),
      busy: false,
      role,
      capabilities,
      /** The message this agent is currently answering, for causal linkage. */
      cause: null,
      /** Whether `agent.registered` has been written for it. */
      announced: false,
      integration: { ...Cls.capabilities, participates: participates(id) },
    };
    this.agents.set(id, entry);

    this.tools.call("register_agent", {
      id,
      name: Cls.label,
      provider: id,
      role,
      capabilities,
    });
    return entry;
  }

  adapterFor(entry) {
    if (entry.adapter) return entry.adapter;
    const dir = `${this.workspace}/${entry.id}`;
    // Every agent gets its own directory because two of the three mount
    // mechanisms are files in the working directory — a shared cwd would make
    // every agent present the same identity to the bridge.
    const mcp = mountMcp(entry.id, { dir, url: this.url, caller: entry.id });
    entry.adapter = new entry.Cls({
      cwd: dir,
      mcp,
      onEvent: (e) => {
        if (e.kind === "delta")
          this.broadcast("delta", { agent: entry.id, text: e.text });
        else if (e.kind === "thought")
          this.broadcast("thought", { agent: entry.id, text: e.text });
        else if (e.kind === "usage") this.broadcast("usage", { agent: entry.id, ...e });
        else this.broadcast("progress", { agent: entry.id, kind: e.label ?? "event" });
      },
    });
    return entry.adapter;
  }

  roster() {
    return [...this.agents.values()].map((a) => ({
      id: a.id,
      label: a.label,
      role: a.role,
      capabilities: a.capabilities,
      integration: a.integration,
      busy: a.busy,
      hasSession: a.adapter?.hasSession ?? false,
    }));
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
        this.broadcast("error", {
          agent: entry.id,
          message: String(err?.message ?? err),
        });
      });
    return entry.queue;
  }

  /**
   * One turn. The agent is woken with context rebuilt from the log — it holds no
   * memory of its own, and the measured price of that is ~2× per turn, nearly
   * independent of how much context is shipped (FINDINGS 3c).
   */
  async turn(entry, cause) {
    entry.busy = true;
    // Remembered so the agent cannot detach itself from the causal chain. An
    // agent that omits `replyTo` would otherwise reset its own hop count to zero
    // and loop forever — the budget has to be the runtime's to enforce.
    entry.cause = cause;
    this.broadcast("roster", { agents: this.roster() });
    try {
      const reply = await this.adapterFor(entry).send(this.prompt(entry, cause));

      // An agent that called `send_message` itself has already spoken; echoing
      // its transcript text as a second message would double every turn.
      if (this.spokeDuring(entry.id, cause.id)) {
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
          replyTo: cause.id,
        },
        entry.id,
      );
      this.broadcast("turn", { agent: entry.id, ms: reply.ms, fresh: reply.fresh });
    } finally {
      entry.busy = false;
      entry.cause = null;
      this.broadcast("roster", { agents: this.roster() });
    }
  }

  /** Did this agent emit anything caused by the message we woke it with? */
  spokeDuring(agentId, causeId) {
    for (const e of this.byId.values()) {
      if (e.causedBy === causeId && e.payload?.from === agentId) return true;
    }
    return false;
  }

  /**
   * What a woken agent is handed. Identity first: it has no idea who it is in
   * this project, and every tool call it makes has to name itself correctly.
   */
  prompt(entry, cause) {
    const ctx = this.runtime().getContext({});
    const history = ctx.messages
      .slice(0, -1)
      .map((m) => `${m.from} → ${m.to}：${m.content}`)
      .join("\n");

    const tools = entry.integration.participates
      ? [
          "你可以直接调用 Agent OS 的 MCP 工具（服务名 agent-os）：",
          "  · find_agent(capabilities) —— 找谁能干某件事。**这是发现同伴的唯一途径**，不要凭印象点名。",
          `  · send_message(from: "${entry.id}", to, type, content) —— 发言或委派。to 填 "${HUMAN_ID}" 是回给人。`,
          "  · get_context() —— 补读上下文。",
          "如果你调用了 send_message，就不要在正文里重复同样的话。",
        ].join("\n")
      : "你没有工具，直接把回复写成正文即可，运行时会代你发出。";

    return [
      `你是 Agent OS 里的 agent「${entry.label}」，id 是 "${entry.id}"。`,
      tools,
      "",
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

      sendMessage(p) {
        // `replyTo` is a courtesy; the link is not optional. Falling back to the
        // message this agent was woken with keeps the chain — and the budget —
        // intact whatever the model chooses to send.
        const causedBy = p.replyTo ?? hub.agents.get(p.from)?.cause?.id;
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
              ...(p.attachments ? { attachments: p.attachments } : {}),
            },
          }),
        );
        hub.route(evt);
        return { id: evt.id, seq: evt.seq };
      },

      getContext(p) {
        const thread = project(hub.log.replay());
        const limit = p?.limit ?? 200;
        return {
          project: hub.projectId,
          messages: thread.items
            .filter((i) => i.kind === "message")
            .slice(-limit)
            .map((i) => ({
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

  async close() {
    for (const a of this.agents.values()) await a.adapter?.close().catch(() => {});
  }
}
