import { createHash, randomBytes } from "node:crypto";

export const DEFAULT_HOST = "127.0.0.1";
export const MIN_TOKEN_LENGTH = 32;

export function newBearerToken() {
  return randomBytes(32).toString("base64url");
}

function digest(token) {
  return createHash("sha256").update(token).digest("base64url");
}

function assertToken(token, label) {
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH || /\s/.test(token)) {
    throw new Error(
      `${label} must be at least ${MIN_TOKEN_LENGTH} non-whitespace characters`,
    );
  }
  return token;
}

/**
 * Bearer credentials are capabilities: one token maps to exactly one principal.
 * The raw values never become map keys, logs or API responses.
 */
export function createCredentialStore({
  humanToken,
  agentTokens = {},
  agentIds = [],
} = {}) {
  const principals = new Map();
  const tokensByAgent = new Map();

  const add = (token, principal, label) => {
    const checked = assertToken(token, label);
    const key = digest(checked);
    if (principals.has(key)) throw new Error(`${label} duplicates another bearer token`);
    principals.set(key, Object.freeze({ ...principal }));
    return checked;
  };

  const resolvedHumanToken = add(
    humanToken ?? newBearerToken(),
    { kind: "human", id: "you" },
    "AGENT_OS_HUMAN_TOKEN",
  );

  const ids = new Set([...agentIds, ...Object.keys(agentTokens)]);
  for (const id of ids) {
    if (!id || typeof id !== "string")
      throw new Error("agent credential id must be non-empty");
    const token = add(
      agentTokens[id] ?? newBearerToken(),
      { kind: "agent", id },
      `token for agent ${id}`,
    );
    tokensByAgent.set(id, token);
  }

  return Object.freeze({
    humanToken: resolvedHumanToken,
    tokenForAgent(id) {
      return tokensByAgent.get(id) ?? null;
    },
    issue(principal) {
      return add(newBearerToken(), principal, `session token for ${principal.id}`);
    },
    authenticate(authorization) {
      if (typeof authorization !== "string") return null;
      const match = /^Bearer ([^\s]+)$/.exec(authorization);
      return match ? (principals.get(digest(match[1])) ?? null) : null;
    },
  });
}

export function parseAgentTokens(raw) {
  if (!raw) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_OS_AGENT_TOKENS must be a JSON object of agent id to token");
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("AGENT_OS_AGENT_TOKENS must be a JSON object of agent id to token");
  }
  return value;
}

export function allowedOrigins({ host, port, configured }) {
  if (configured) {
    return new Set(
      configured
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    );
  }

  const origins = new Set([`http://${host}:${port}`]);
  if (["127.0.0.1", "localhost", "::1"].includes(host)) {
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
    origins.add(`http://[::1]:${port}`);
  }
  return origins;
}

/** Reject browser cross-site requests rather than reflecting arbitrary origins. */
export function requestOrigin(req, origins) {
  if (req.headers["sec-fetch-site"] === "cross-site") return { ok: false, origin: null };
  const origin = req.headers.origin;
  if (origin === undefined) return { ok: true, origin: null };
  if (typeof origin !== "string" || !origins.has(origin))
    return { ok: false, origin: null };
  return { ok: true, origin };
}

export function applySecurityHeaders(res, origin = null) {
  res.setHeader("cache-control", "no-store");
  res.setHeader(
    "content-security-policy",
    [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data:",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
    ].join("; "),
  );
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("vary", "Origin");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  if (origin) res.setHeader("access-control-allow-origin", origin);
}
