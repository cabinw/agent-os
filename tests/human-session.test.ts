import { describe, expect, it } from "vitest";
import {
  HUMAN_SESSION_COOKIE,
  clearHumanSessionCookie,
  createHumanSessionStore,
  humanSessionCookie,
} from "../apps/chat-spike/src/human-session.mjs";

const TOKEN = "A".repeat(43);

describe("human web sessions", () => {
  it("issues an opaque bounded session and authenticates only its exact cookie", () => {
    let now = 1_000_000;
    const sessions = createHumanSessionStore({
      ttlMs: 60_000,
      now: () => now,
      randomToken: () => TOKEN,
    });
    const issued = sessions.issue();
    expect(issued).toEqual({ token: TOKEN, maxAge: 60 });
    expect(sessions.authenticate(`${HUMAN_SESSION_COOKIE}=${TOKEN}`)).toEqual({
      kind: "human",
      id: "you",
    });
    expect(
      sessions.authenticate(
        `${HUMAN_SESSION_COOKIE}=${TOKEN}; ${HUMAN_SESSION_COOKIE}=${TOKEN}`,
      ),
    ).toBeNull();
    expect(sessions.authenticate(`${HUMAN_SESSION_COOKIE}=short`)).toBeNull();
    now += 60_000;
    expect(sessions.authenticate(`${HUMAN_SESSION_COOKIE}=${TOKEN}`)).toBeNull();
  });

  it("revokes one session without accepting an unrelated cookie", () => {
    const sessions = createHumanSessionStore({
      randomToken: () => TOKEN,
    });
    sessions.issue();
    expect(sessions.revoke("unrelated=value")).toBe(false);
    expect(sessions.revoke(`${HUMAN_SESSION_COOKIE}=${TOKEN}`)).toBe(true);
    expect(sessions.authenticate(`${HUMAN_SESSION_COOKIE}=${TOKEN}`)).toBeNull();
  });

  it("uses HttpOnly strict cookies and adds Secure only for the TLS surface", () => {
    const local = humanSessionCookie({ token: TOKEN, maxAge: 60, secure: false });
    expect(local).toBe(
      `${HUMAN_SESSION_COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=60`,
    );
    expect(humanSessionCookie({ token: TOKEN, maxAge: 60, secure: true })).toBe(
      `${local}; Secure`,
    );
    expect(clearHumanSessionCookie({ secure: true })).toBe(
      `${HUMAN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure`,
    );
  });

  it("rejects weak ttl and malformed generated values", () => {
    expect(() => createHumanSessionStore({ ttlMs: 59_999 })).toThrow(/at least 60000ms/);
    const sessions = createHumanSessionStore({ randomToken: () => "not-a-session" });
    expect(() => sessions.issue()).toThrow(/invalid token/);
  });
});
