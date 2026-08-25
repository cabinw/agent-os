import { linkSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error
import {
  publishDurableFile,
  readDurableFile,
} from "../apps/chat-spike/src/runners/durable-file.mjs";
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

  it("recovers a single-link candidate left by a killed publisher", async () => {
    const root = await scratch();
    const target = join(root, "sessions.json");
    const stale = `${target}.123.dead.candidate`;
    writeFileSync(stale, "partial", { encoding: "utf8", mode: 0o600 });

    publishDurableFile(target, "next");

    expect(await readFile(target, "utf8")).toBe("next");
    expect((await readdir(root)).filter((name) => name.endsWith(".candidate"))).toEqual(
      [],
    );
  });

  it("fails closed instead of unlinking a hard-linked stale candidate", async () => {
    const root = await scratch();
    const target = join(root, "sessions.json");
    const external = join(root, "external.txt");
    const stale = `${target}.123.tampered.candidate`;
    writeFileSync(target, "old", { encoding: "utf8", mode: 0o600 });
    writeFileSync(external, "do-not-remove", { encoding: "utf8", mode: 0o600 });
    linkSync(external, stale);

    expect(() => publishDurableFile(target, "next")).toThrow(
      "unsafe stale durable candidate requires operator review",
    );
    expect(await readFile(target, "utf8")).toBe("old");
    expect(await readFile(external, "utf8")).toBe("do-not-remove");
    expect(await readFile(stale, "utf8")).toBe("do-not-remove");
  });

  it("retries the transient Windows ENOENT window without hiding other failures", () => {
    const attempts = [];
    const sleeps = [];
    const value = readDurableFile("C:\\state.json", {
      platform: "win32",
      readFile: () => {
        attempts.push(true);
        if (attempts.length < 3)
          throw Object.assign(new Error("transient"), { code: "ENOENT" });
        return "old-or-new";
      },
      sleep: (delay) => sleeps.push(delay),
      retryDelays: [1, 4, 10],
    });
    expect(value).toBe("old-or-new");
    expect(attempts).toHaveLength(3);
    expect(sleeps).toEqual([1, 4]);
    expect(() =>
      readDurableFile("C:\\state.json", {
        platform: "win32",
        readFile: () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
        sleep: () => {
          throw new Error("must not sleep");
        },
      }),
    ).toThrow("denied");
  });
});
