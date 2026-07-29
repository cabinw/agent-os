import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import { makeEvent, newEventId } from "../apps/chat-spike/src/events.mjs";
// @ts-expect-error
import { EventLog } from "../apps/chat-spike/src/log.mjs";
// @ts-expect-error
import { emptyThread, project, reduce } from "../apps/chat-spike/src/thread.mjs";

const dirs: string[] = [];

function tmpLog(): string {
  const d = mkdtempSync(join(tmpdir(), "agentos-log-"));
  dirs.push(d);
  return join(d, "events.jsonl");
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function msg(from: string, kind: string, content: string, causedBy?: string) {
  return makeEvent({
    type: "message.sent",
    project: "proj_test",
    actor: { kind, id: from },
    causedBy,
    payload: { from, to: "other", type: "answer", content },
  });
}

describe("事件信封", () => {
  it("id 可排序且单毫秒内严格递增", () => {
    const ids = Array.from({ length: 200 }, () => newEventId());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("seq 由 store 分配，不在构造时", () => {
    expect(msg("you", "human", "hi").seq).toBeNull();
  });
});

describe("EventLog", () => {
  it("seq 在项目内单调递增", () => {
    const log = new EventLog(tmpLog());
    const a = log.append(msg("you", "human", "1"));
    const b = log.append(msg("codex", "agent", "2"));
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it("重启后从磁盘重放，seq 接着走", () => {
    const path = tmpLog();
    const first = new EventLog(path);
    first.append(msg("you", "human", "1"));
    first.append(msg("codex", "agent", "2"));

    const second = new EventLog(path);
    expect(second.size).toBe(2);
    expect(second.seq).toBe(2);
    expect(second.append(msg("you", "human", "3")).seq).toBe(3);
  });

  it("只追加——已有行永不被改写", () => {
    const path = tmpLog();
    const log = new EventLog(path);
    log.append(msg("you", "human", "1"));
    const afterFirst = readFileSync(path, "utf8");
    log.append(msg("codex", "agent", "2"));
    expect(readFileSync(path, "utf8").startsWith(afterFirst)).toBe(true);
  });

  it("崩溃后的半行被跳过，而不是让整个日志失效", () => {
    const path = tmpLog();
    const log = new EventLog(path);
    log.append(msg("you", "human", "完整"));
    writeFileSync(path, `${readFileSync(path, "utf8")}{"id":"evt_hal`, "utf8");

    const reopened = new EventLog(path);
    expect(reopened.size).toBe(1);
    expect(project(reopened.replay()).items).toHaveLength(1);
  });
});

/**
 * The assertion stage 1 exists for. If this holds, ADR-005 stops being a
 * principle and becomes a property the machine keeps.
 */
describe("重放等价性（ADR-005）", () => {
  it("从 seq 0 全量重放 === 增量归约", () => {
    const log = new EventLog(tmpLog());
    const events = [
      makeEvent({
        type: "agent.registered",
        project: "proj_test",
        actor: { kind: "system", id: "runtime" },
        payload: { id: "codex", name: "Codex", provider: "codex", capabilities: [] },
      }),
      msg("you", "human", "记住暗号"),
      msg("codex", "agent", "记住了"),
      msg("you", "human", "暗号是什么"),
      msg("codex", "agent", "青铜麋鹿"),
    ];

    let incremental = emptyThread();
    for (const e of events) incremental = reduce(incremental, log.append(e));

    const replayed = project(log.replay());
    expect(replayed).toEqual(incremental);
  });

  it("重启进程后重放，结果不变", () => {
    const path = tmpLog();
    const first = new EventLog(path);
    const a = first.append(msg("you", "human", "问题"));
    first.append(
      makeEvent({
        type: "message.sent",
        project: "proj_test",
        actor: { kind: "agent", id: "codex" },
        causedBy: a.id,
        payload: { from: "codex", to: "you", type: "answer", content: "回答" },
      }),
    );
    const before = project(first.replay());

    expect(project(new EventLog(path).replay())).toEqual(before);
  });

  it("未知事件类型被忽略——老日志比读它的代码活得久", () => {
    const state = reduce(emptyThread(), {
      id: "evt_x",
      type: "some.future.type",
      at: new Date().toISOString(),
      actor: { kind: "system", id: "x" },
      payload: {},
    });
    expect(state.items).toHaveLength(0);
  });
});

describe("派生而非存储", () => {
  it("延迟由因果链算出，不写进日志", () => {
    const log = new EventLog(tmpLog());
    const q = log.append(msg("you", "human", "问题"));
    const raw = JSON.parse(readFileSync(log.path, "utf8").split("\n")[0] as string);
    expect(raw.payload).not.toHaveProperty("ms");

    const a = log.append(
      makeEvent({
        type: "message.sent",
        project: "proj_test",
        actor: { kind: "agent", id: "codex" },
        causedBy: q.id,
        payload: { from: "codex", to: "you", type: "answer", content: "回答" },
      }),
    );
    a.at = new Date(Date.parse(q.at) + 1500).toISOString();

    const thread = project([q, a]);
    expect(thread.items[1].ms).toBe(1500);
  });

  it("冷启动标记不进日志——它描述适配器会话，不是项目事实", () => {
    const log = new EventLog(tmpLog());
    log.append(msg("codex", "agent", "回答"));
    const raw = readFileSync(log.path, "utf8");
    expect(raw).not.toContain("fresh");
  });
});
