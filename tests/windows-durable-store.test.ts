import { readFileSync, renameSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — spike modules are plain .mjs, not part of tsc --build
import { RequestStore } from "../apps/chat-spike/src/runners/request-store.mjs";
// @ts-expect-error
import { SessionStore } from "../apps/chat-spike/src/runners/session-store.mjs";

const roots: string[] = [];

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "agent-os-windows-durable-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("Windows Worker durable stores", () => {
  it("publishes SessionStore and RequestStore candidates through one Windows replacer", async () => {
    const root = await scratch();
    const calls: Array<{ candidate: string; target: string; body: string }> = [];
    const durability = {
      platform: "win32",
      windowsReplace: (candidate: string, target: string) => {
        const body = readFileSync(candidate, "utf8");
        calls.push({ candidate, target, body });
        renameSync(candidate, target);
      },
    };
    const sessions = new SessionStore(join(root, "sessions.json"), { durability });
    sessions.set(
      { user: "u", project: "p", agent: "a" },
      { sessionId: "s", adapter: "claude", hostId: "h", workspace: root },
    );
    const requests = new RequestStore(join(root, "requests.json"), { durability });
    requests.create("request-1", "a".repeat(64));

    expect(calls).toHaveLength(2);
    expect(calls[0].body).toContain('"sessions"');
    expect(calls[1].body).toContain('"requests"');
    expect(await readFile(join(root, "sessions.json"), "utf8")).toContain(
      '"sessionId": "s"',
    );
    expect(await readFile(join(root, "requests.json"), "utf8")).toContain(
      '"requestId": "request-1"',
    );
  });

  it("does not advance memory and removes candidates when replacement fails", async () => {
    const root = await scratch();
    const durability = {
      platform: "win32",
      windowsReplace: () => {
        throw new Error("injected replace failure");
      },
    };
    const sessions = new SessionStore(join(root, "sessions.json"), { durability });
    expect(() =>
      sessions.set(
        { user: "u", project: "p", agent: "a" },
        { sessionId: "s", adapter: "claude", hostId: "h", workspace: root },
      ),
    ).toThrow();
    expect(sessions.get({ user: "u", project: "p", agent: "a" })).toBeNull();

    const requests = new RequestStore(join(root, "requests.json"), { durability });
    expect(() => requests.create("request-1", "b".repeat(64))).toThrow();
    expect(requests.entries()).toEqual([]);
    expect((await readdir(root)).filter((name) => name.endsWith(".candidate"))).toEqual(
      [],
    );
  });
});
