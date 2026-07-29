#!/usr/bin/env node
/**
 * Stage 3 — the experiment the spike exists for.
 *
 * Agent OS is memory-first: context lives in the event log, and an agent is
 * expected to be ephemeral (`agent.disconnected` is described as normal). That
 * is a real bet, because the alternative — keeping the vendor's own session
 * alive — is free coherence. This measures what the bet costs.
 *
 *   resident  send() with the vendor session intact (--resume / threadId)
 *   rebuild   drop the vendor session every turn; prepend get_context output
 *
 * Same turns, same order, same grader. `rebuild` is the real mechanism, not a
 * simulation of it: the preamble comes from the tool, off the actual log.
 *
 * Second experiment, once the first came back 8/8: `--pad N` buries the planted
 * facts under N messages of plausible project chatter before asking. That is the
 * question that actually decides the memory-first bet — not "does rebuild work"
 * but "does it still work when the log is a year old". Padding is seeded straight
 * into the log, so it costs no vendor calls.
 *
 *   node .../context-rebuild.mjs [provider…]
 *   node .../context-rebuild.mjs --pad 200 [provider…]
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../src/adapters/index.mjs";
import { makeEvent } from "../src/events.mjs";
import { EventLog } from "../src/log.mjs";
import { createToolRouter } from "../src/mcp-tools.mjs";
import { project } from "../src/thread.mjs";

/**
 * Facts are arbitrary on purpose — a model cannot infer "7734" or "青铜麋鹿"
 * from context, so a hit is recall rather than a plausible guess. Turn 3 is a
 * distractor: it pushes unrelated tokens between planting and asking, which is
 * where a thin context window actually fails.
 */
const SCRIPT = [
  {
    say: "记住三件事，之后我会问你。代号：青铜麋鹿。端口：7734。负责人：Vera。只回复「已记录」。",
    expect: [],
  },
  { say: "再补一条：部署窗口是周四 02:00。只回复「已记录」。", expect: [] },
  { say: "换个话题，用一句话解释什么是幂等。", expect: [] },
  { say: "回到之前：代号是什么？端口是多少？", expect: ["青铜麋鹿", "7734"] },
  { say: "负责人是谁？部署窗口是什么时候？", expect: ["Vera", "周四"] },
];

const GRADED = SCRIPT.filter((t) => t.expect.length > 0).reduce(
  (n, t) => n + t.expect.length,
  0,
);

const PROJECT = "proj_exp";
const HUMAN = "you";

/**
 * The haystack. Deliberately on-topic — unrelated filler would be easy to skip,
 * and a real project log is all plausibly relevant.
 */
const CHATTER = [
  ["你", "队列消费者的重试上限调成多少合适？"],
  ["agent", "建议 5 次，指数退避，超过就进死信队列人工看。"],
  ["你", "迁移脚本要不要在事务里跑？"],
  ["agent", "要，但拆成批，单个事务别超过一万行，不然锁表时间太长。"],
  ["你", "缓存失效用主动推还是过期？"],
  ["agent", "读多写少用过期加抖动就够了，主动推的复杂度不划算。"],
  ["你", "这个接口的分页用游标还是偏移？"],
  ["agent", "游标。偏移在深翻页时会全表扫，而且插入会导致重复。"],
  ["你", "日志采样率现在是多少？"],
  ["agent", "错误全采，正常路径 1%，慢请求单独打标全采。"],
];

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "agentos-exp-"));
  const log = new EventLog(join(dir, "events.jsonl"));
  const registered = new Set();

  const emit = (e) => log.append(e);

  const tools = createToolRouter({
    registeredIds: () => registered,
    registerAgent(p) {
      registered.add(p.id);
      emit(
        makeEvent({
          type: "agent.registered",
          project: PROJECT,
          actor: { kind: "system", id: "runtime" },
          subject: { kind: "agent", id: p.id },
          payload: { id: p.id, name: p.name, provider: p.id, capabilities: [] },
        }),
      );
      return { registered: p.id };
    },
    sendMessage(p) {
      const evt = emit(
        makeEvent({
          type: "message.sent",
          project: PROJECT,
          actor: { kind: "agent", id: p.from },
          subject: { kind: "project", id: PROJECT },
          causedBy: p.replyTo,
          payload: { from: p.from, to: p.to, type: p.type, content: p.content },
        }),
      );
      return { id: evt.id, seq: evt.seq };
    },
    getContext() {
      const thread = project(log.replay());
      return {
        project: PROJECT,
        messages: thread.items
          .filter((i) => i.kind === "message")
          .map((i) => ({ from: i.from, content: i.text })),
      };
    },
  });

  return { log, tools, emit };
}

/**
 * What an agent with no memory of its own is handed. Deliberately plain — if
 * coherence needs a clever prompt format, that is a finding, not a fix.
 */
function preamble(ctx, self) {
  if (ctx.messages.length === 0) return "";
  const lines = ctx.messages.map(
    (m) => `${m.from === self ? "你" : m.from}：${m.content}`,
  );
  return [
    "以下是本项目此前的完整对话记录。你没有它的记忆，请把它当作你自己的上下文：",
    "---",
    ...lines,
    "---",
    "现在回答最新一条：",
    "",
  ].join("\n");
}

/** Seeds the log without calling anyone — padding must be free to be usable. */
function pad(emit, n) {
  for (let i = 0; i < n; i++) {
    const [who, text] = CHATTER[i % CHATTER.length];
    const human = who === "你";
    emit(
      makeEvent({
        type: "message.sent",
        project: PROJECT,
        actor: { kind: human ? "human" : "agent", id: human ? HUMAN : "peer" },
        subject: { kind: "project", id: PROJECT },
        payload: {
          from: human ? HUMAN : "peer",
          to: human ? "peer" : HUMAN,
          type: human ? "instruction" : "answer",
          content: `${text}（#${Math.floor(i / CHATTER.length) + 1}）`,
        },
      }),
    );
  }
}

async function run(providerId, mode, padding = 0) {
  const Cls = getAdapter(providerId);
  if (!Cls) throw new Error(`未知 provider：${providerId}`);

  const { log, tools, emit } = harness();
  tools.call("register_agent", { id: providerId, name: Cls.label });

  // Usage is the axis the first two experiments missed: recall held and latency
  // stayed flat, so what a rebuild actually costs is what it is billed.
  let usage = null;
  const adapter = new Cls({
    cwd: process.env.AGENT_CWD ?? process.cwd(),
    onEvent: (e) => {
      if (e.kind === "usage") usage = e;
    },
  });
  const turns = [];
  let hits = 0;
  let tokens = 0;
  let costUsd = 0;

  let padded = false;
  for (const step of SCRIPT) {
    // Bury the facts once they are planted, before anything is asked.
    if (!padded && step.expect.length === 0 && SCRIPT.indexOf(step) === 2) {
      pad(emit, padding);
      padded = true;
    }
    const asked = emit(
      makeEvent({
        type: "message.sent",
        project: PROJECT,
        actor: { kind: "human", id: HUMAN },
        subject: { kind: "project", id: PROJECT },
        payload: { from: HUMAN, to: providerId, type: "instruction", content: step.say },
      }),
    );

    // In rebuild the vendor holds nothing, so ungraded turns need no vendor call
    // when we are only measuring recall against a padded log.
    let prompt = step.say;
    if (mode === "rebuild") {
      // The whole point: the vendor keeps nothing, the log supplies everything.
      adapter.resetSession();
      const ctx = await tools.call("get_context", {});
      prompt = preamble(ctx, providerId) + step.say;
    }

    usage = null;
    const started = Date.now();
    const reply = await adapter.send(prompt);
    const ms = Date.now() - started;
    tokens += usage?.total ?? 0;
    costUsd += usage?.costUsd ?? 0;

    await tools.call(
      "send_message",
      {
        from: providerId,
        to: HUMAN,
        type: "answer",
        content: reply.text || "（空回复）",
        replyTo: asked.id,
      },
      providerId,
    );

    const found = step.expect.filter((needle) => reply.text?.includes(needle));
    hits += found.length;
    turns.push({
      ms,
      chars: prompt.length,
      graded: step.expect.length,
      found: found.length,
      missed: step.expect.filter((n) => !found.includes(n)),
      text: (reply.text ?? "").replace(/\s+/g, " ").slice(0, 70),
    });
  }

  await adapter.close().catch(() => {});
  return { turns, hits, tokens, costUsd, events: log.size };
}

const argv = process.argv.slice(2);
const padAt = argv.indexOf("--pad");
const padding = padAt >= 0 ? Number(argv[padAt + 1]) : 0;
const providers = argv.filter(
  (a, i) => !a.startsWith("--") && !(padAt >= 0 && i === padAt + 1),
);
const targets = providers.length > 0 ? providers : ["claude"];
const modes = padding > 0 ? ["rebuild"] : ["resident", "rebuild"];

const haystack = padding > 0 ? `，日志里另有 ${padding} 条无关消息` : "";
console.log(`探针：${SCRIPT.length} 轮，${GRADED} 个待回忆事实${haystack}\n`);

for (const id of targets) {
  for (const mode of modes) {
    process.stdout.write(`${id.padEnd(7)} ${mode.padEnd(9)} `);
    try {
      const r = await run(id, mode, padding);
      const total = r.turns.reduce((n, t) => n + t.ms, 0);
      const chars = r.turns.reduce((n, t) => n + t.chars, 0);
      const billed =
        r.tokens > 0
          ? `  计费 ${(r.tokens / 1000).toFixed(1)}k tok${r.costUsd > 0 ? ` · $${r.costUsd.toFixed(4)}` : ""}`
          : "  计费 —";
      console.log(
        `召回 ${r.hits}/${GRADED}  总耗时 ${(total / 1000).toFixed(1)}s  ` +
          `每轮 [${r.turns.map((t) => (t.ms / 1000).toFixed(1)).join(", ")}]  ` +
          `送出 ${(chars / 1000).toFixed(1)}k 字${billed}`,
      );
      for (const t of r.turns.filter((x) => x.missed.length > 0)) {
        console.log(`${" ".repeat(17)}✗ 漏掉 ${t.missed.join("、")} — 「${t.text}」`);
      }
    } catch (e) {
      console.log(`失败：${e.message}`);
    }
  }
}
