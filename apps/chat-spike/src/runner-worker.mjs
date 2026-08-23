#!/usr/bin/env node
/**
 * Outbound Remote Runner worker.
 *
 * The worker owns vendor adapters, project workspaces and vendor sessions. It
 * opens only authenticated outbound requests to the Hub-side RemoteRunner.
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS, getAdapter } from "./adapters/index.mjs";
import { MIN_TOKEN_LENGTH, parseAgentTokens } from "./http-security.mjs";
import { mountMcp } from "./mcp-mount.mjs";
import { LocalRunner } from "./runners/local.mjs";
import { RemoteRunnerWorker } from "./runners/remote.mjs";
import { SessionStore } from "./runners/session-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function runnerToken(environment) {
  const token = required(environment, "AGENT_OS_RUNNER_TOKEN");
  if (token.length < MIN_TOKEN_LENGTH || /\s/.test(token)) {
    throw new Error(
      `AGENT_OS_RUNNER_TOKEN must be at least ${MIN_TOKEN_LENGTH} non-whitespace characters`,
    );
  }
  return token;
}

function hubUrl(environment) {
  const raw = required(environment, "AGENT_OS_URL");
  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error("AGENT_OS_URL must be an absolute HTTP(S) URL", { cause: error });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("AGENT_OS_URL must use HTTP or HTTPS");
  }
  const hostname = url.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    (() => {
      const octets = hostname.split(".");
      return (
        octets.length === 4 &&
        octets[0] === "127" &&
        octets.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
      );
    })();
  if (url.protocol === "http:" && !loopback) {
    throw new Error("AGENT_OS_URL must use HTTPS; HTTP is allowed only for loopback");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("AGENT_OS_URL must not contain credentials, query or fragment");
  }
  return url.origin;
}

function agentTokenFor(tokens, agentId) {
  const token = tokens[agentId];
  if (typeof token !== "string") {
    throw new Error(`missing explicit bearer token for agent ${agentId}`);
  }
  return token;
}

/**
 * Production composition with narrow test injection at the vendor boundary.
 * Transport, LocalRunner, stores, credential policy and shutdown stay shared.
 */
export function createRunnerWorker({
  environment = process.env,
  adapterCatalog = ADAPTERS,
  getAdapterImpl = getAdapter,
  mcpForImpl,
} = {}) {
  if (!Array.isArray(adapterCatalog) || adapterCatalog.length === 0) {
    throw new TypeError("adapterCatalog must be a non-empty array");
  }
  if (typeof getAdapterImpl !== "function") {
    throw new TypeError("getAdapterImpl must be a function");
  }

  const url = hubUrl(environment);
  const token = runnerToken(environment);
  const hostId = required(environment, "AGENT_OS_RUNNER_ID");
  const workspaceRoot = resolve(environment.AGENT_CWD ?? resolve(HERE, "../workspace"));
  const sessionPath = resolve(
    environment.SESSION_PATH ?? resolve(HERE, "../data/runner-sessions.json"),
  );
  const agentTokens = parseAgentTokens(environment.AGENT_OS_AGENT_TOKENS);
  const adapterIds = adapterCatalog.map((AdapterClass) => AdapterClass?.id);
  if (
    adapterIds.some((id) => typeof id !== "string" || id.trim() === "") ||
    new Set(adapterIds).size !== adapterIds.length
  ) {
    throw new TypeError("adapterCatalog ids must be unique non-empty strings");
  }

  const missingAgentTokens = adapterIds.filter(
    (agentId) => !Object.hasOwn(agentTokens, agentId),
  );
  if (missingAgentTokens.length > 0) {
    throw new Error(
      `AGENT_OS_AGENT_TOKENS must explicitly configure Worker principals: ${missingAgentTokens.join(", ")}`,
    );
  }

  const configuredTokens = new Set();
  for (const [agentId, agentToken] of Object.entries(agentTokens)) {
    if (
      typeof agentToken !== "string" ||
      agentToken.length < MIN_TOKEN_LENGTH ||
      /\s/.test(agentToken)
    ) {
      throw new Error(
        `token for agent ${agentId} must be at least ${MIN_TOKEN_LENGTH} non-whitespace characters`,
      );
    }
    if (agentToken === token) {
      throw new Error("AGENT_OS_RUNNER_TOKEN must be independent from agent credentials");
    }
    if (configuredTokens.has(agentToken)) {
      throw new Error(`token for agent ${agentId} duplicates another agent credential`);
    }
    configuredTokens.add(agentToken);
  }

  // Do not leave control credentials in ambient process state. Adapter children
  // are sanitized independently as defense in depth.
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase().startsWith("AGENT_OS_")) delete environment[name];
  }

  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  for (const AdapterClass of adapterCatalog) {
    mkdirSync(join(workspaceRoot, AdapterClass.id), {
      recursive: true,
      mode: 0o700,
    });
  }

  const runner = new LocalRunner({
    workspaceRoot,
    sessionStore: new SessionStore(sessionPath),
    getAdapter: getAdapterImpl,
    hostId,
    mcpFor: (request, workspace) => {
      const agentToken = agentTokenFor(agentTokens, request.agent);
      return typeof mcpForImpl === "function"
        ? mcpForImpl(request, workspace, { url, token: agentToken, hostId })
        : mountMcp(request.adapter, {
            dir: workspace,
            url,
            token: agentToken,
          });
    },
  });
  const worker = new RemoteRunnerWorker({ url, token, hostId, runner });
  return Object.freeze({ worker, runner, hostId, url, workspaceRoot, sessionPath });
}

export async function runRunnerWorker({ logger = console, ...options } = {}) {
  const { worker, hostId, url } = createRunnerWorker(options);
  let stopPromise = null;
  const stop = () => {
    stopPromise ??= worker.stop();
    return stopPromise;
  };
  const handlers = new Map();

  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      void stop().catch((error) => {
        logger.error(
          `remote runner worker shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      });
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  logger.log(`remote runner worker → ${hostId} @ ${url}`);
  worker.start();
  try {
    await worker.wait();
  } catch (error) {
    logger.error(
      `remote runner worker failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    await stop();
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runRunnerWorker();
