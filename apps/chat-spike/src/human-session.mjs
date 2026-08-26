import { createHash, randomBytes } from "node:crypto";

export const HUMAN_SESSION_COOKIE = "agent_os_session";
export const DEFAULT_HUMAN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function digest(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function cookieValue(header, name = HUMAN_SESSION_COOKIE) {
  if (typeof header !== "string" || header.length === 0) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function createHumanSessionStore({
  ttlMs = DEFAULT_HUMAN_SESSION_TTL_MS,
  now = () => Date.now(),
  randomToken = () => randomBytes(32).toString("base64url"),
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000) {
    throw new TypeError("human session ttl must be an integer of at least 60000ms");
  }
  const sessions = new Map();

  const prune = () => {
    const current = now();
    for (const [key, expiresAt] of sessions) {
      if (expiresAt <= current) sessions.delete(key);
    }
  };

  return Object.freeze({
    issue() {
      prune();
      const token = randomToken();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        throw new Error("human session generator returned an invalid token");
      }
      sessions.set(digest(token), now() + ttlMs);
      return Object.freeze({ token, maxAge: Math.floor(ttlMs / 1000) });
    },
    authenticate(cookieHeader) {
      const token = cookieValue(cookieHeader);
      if (token === null) return null;
      const key = digest(token);
      const expiresAt = sessions.get(key);
      if (expiresAt === undefined) return null;
      if (expiresAt <= now()) {
        sessions.delete(key);
        return null;
      }
      return Object.freeze({ kind: "human", id: "you" });
    },
    revoke(cookieHeader) {
      const token = cookieValue(cookieHeader);
      return token === null ? false : sessions.delete(digest(token));
    },
  });
}

export function humanSessionCookie({ token, maxAge, secure }) {
  const attributes = [
    `${HUMAN_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearHumanSessionCookie({ secure }) {
  const attributes = [
    `${HUMAN_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}
