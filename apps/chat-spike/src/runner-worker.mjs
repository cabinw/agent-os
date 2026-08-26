#!/usr/bin/env node
/**
 * Outbound Remote Runner worker.
 *
 * The worker owns vendor adapters, project workspaces and vendor sessions. It
 * opens only authenticated outbound requests to the Hub-side RemoteRunner.
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS, getAdapter } from "./adapters/index.mjs";
import { MIN_TOKEN_LENGTH, parseAgentTokens } from "./http-security.mjs";
import { runMcpBridge } from "./mcp-bridge.mjs";
import { mountMcp } from "./mcp-mount.mjs";
import { createWindowsReplacer } from "./runners/durable-file.mjs";
import { LocalRunner } from "./runners/local.mjs";
import { RemoteRunnerWorker } from "./runners/remote.mjs";
import { SessionStore } from "./runners/session-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = realpathSync(fileURLToPath(import.meta.url));
export const WORKER_MCP_BRIDGE_ARG = "--agent-os-mcp-bridge";
const BUILTIN_EXECUTABLE_ENV = Object.freeze({
  claude: "AGENT_OS_CLAUDE_BIN",
  codex: "AGENT_OS_CODEX_BIN",
  grok: "AGENT_OS_GROK_BIN",
  kimi: "AGENT_OS_KIMI_BIN",
});

function enabledAdapterCatalog(environment, adapterCatalog) {
  const configured = environment.AGENT_OS_ENABLED_ADAPTERS;
  if (configured === undefined) return adapterCatalog;
  let ids;
  try {
    ids = JSON.parse(configured);
  } catch (error) {
    throw new Error("AGENT_OS_ENABLED_ADAPTERS must be a JSON array", { cause: error });
  }
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((id) => typeof id !== "string" || id.trim() !== id || id === "") ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error("AGENT_OS_ENABLED_ADAPTERS must contain unique adapter ids");
  }
  const byId = new Map(
    adapterCatalog.map((AdapterClass) => [AdapterClass?.id, AdapterClass]),
  );
  const selected = ids.map((id) => byId.get(id));
  if (selected.some((AdapterClass) => typeof AdapterClass !== "function")) {
    throw new Error("AGENT_OS_ENABLED_ADAPTERS names an unavailable adapter");
  }
  return selected;
}

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

function fixedExecutable(environment, name) {
  const configured = required(environment, name);
  if (resolve(configured) !== configured) {
    throw new Error(`${name} must be a canonical absolute path`);
  }
  let metadata;
  let real;
  try {
    metadata = lstatSync(configured);
    real = realpathSync(configured);
  } catch (error) {
    throw new Error(`${name} is not an available executable file`, { cause: error });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || real !== configured) {
    throw new Error(`${name} must name a fixed non-link file`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o111) === 0) {
    throw new Error(`${name} is not executable`);
  }
  return configured;
}

function fixedFile(environment, name) {
  const configured = required(environment, name);
  if (!isAbsolute(configured) || resolve(configured) !== configured) {
    throw new Error(`${name} must be a canonical absolute path`);
  }
  const metadata = lstatSync(configured);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    realpathSync(configured) !== configured
  ) {
    throw new Error(`${name} must name a fixed single-link file`);
  }
  return configured;
}

export function requireWindowsJobAssignment({
  environment = process.env,
  platform = process.platform,
  timeoutMs = 10_000,
} = {}) {
  if (platform !== "win32") return;
  const gate = required(environment, "AGENT_OS_JOB_ASSIGNMENT_GATE");
  if (!isAbsolute(gate) || resolve(gate) !== gate) {
    throw new Error("AGENT_OS_JOB_ASSIGNMENT_GATE must be a canonical absolute path");
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const metadata = lstatSync(gate);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1 ||
        realpathSync(gate) !== gate ||
        readFileSync(gate, "utf8") !== "assigned"
      ) {
        throw new Error("Windows Job Object assignment gate is unsafe");
      }
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (Date.now() >= deadline) {
        throw new Error("Windows Job Object assignment was not proven before startup");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/**
 * Production composition with narrow test injection at the vendor boundary.
 * Transport, LocalRunner, stores, credential policy and shutdown stay shared.
 */
export function createRunnerWorker({
  environment = process.env,
  platform = process.platform,
  durability,
  adapterCatalog = ADAPTERS,
  getAdapterImpl = getAdapter,
  mcpForImpl,
} = {}) {
  requireWindowsJobAssignment({ environment, platform });
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
  const configuredCredentialRoot =
    environment.AGENT_OS_CREDENTIAL_ROOT ?? resolve(dirname(sessionPath), "credentials");
  if (
    !isAbsolute(configuredCredentialRoot) ||
    resolve(configuredCredentialRoot) !== configuredCredentialRoot
  ) {
    throw new Error("AGENT_OS_CREDENTIAL_ROOT must be a canonical absolute path");
  }
  const credentialRoot = configuredCredentialRoot;
  const credentialRelative = relative(workspaceRoot, credentialRoot);
  if (
    credentialRelative === "" ||
    (!credentialRelative.startsWith("..") && !isAbsolute(credentialRelative))
  ) {
    throw new Error(
      "AGENT_OS_CREDENTIAL_ROOT must be outside the mutable workspace root",
    );
  }
  const agentTokens = parseAgentTokens(environment.AGENT_OS_AGENT_TOKENS);
  let storeDurability = durability;
  if (platform === "win32" && storeDurability === undefined) {
    const powershellPath = fixedExecutable(environment, "AGENT_OS_PWSH_BIN");
    const replaceScript = fixedFile(environment, "AGENT_OS_WINDOWS_REPLACE_SCRIPT");
    storeDurability = {
      platform,
      windowsReplace: createWindowsReplacer({
        powershellPath,
        scriptPath: replaceScript,
      }),
    };
  }
  const selectedAdapterCatalog = enabledAdapterCatalog(environment, adapterCatalog);
  const adapterIds = selectedAdapterCatalog.map((AdapterClass) => AdapterClass?.id);
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

  const builtinClasses = new Set(ADAPTERS);
  const vendorExecutables = new Map();
  for (const AdapterClass of selectedAdapterCatalog) {
    if (!builtinClasses.has(AdapterClass)) continue;
    const name = BUILTIN_EXECUTABLE_ENV[AdapterClass.id];
    if (!name)
      throw new Error(`missing executable contract for adapter ${AdapterClass.id}`);
    vendorExecutables.set(AdapterClass.id, fixedExecutable(environment, name));
  }

  // Do not leave control credentials in ambient process state. Adapter children
  // are sanitized independently as defense in depth.
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase().startsWith("AGENT_OS_")) delete environment[name];
  }

  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  mkdirSync(credentialRoot, { recursive: true, mode: 0o700 });
  for (const AdapterClass of selectedAdapterCatalog) {
    mkdirSync(join(workspaceRoot, AdapterClass.id), {
      recursive: true,
      mode: 0o700,
    });
  }

  const runner = new LocalRunner({
    workspaceRoot,
    sessionStore: new SessionStore(sessionPath, { durability: storeDurability }),
    getAdapter: getAdapterImpl,
    adapterOptionsFor: (request) => {
      const executable = vendorExecutables.get(request.adapter);
      return executable ? { executable } : {};
    },
    hostId,
    mcpFor: (request, workspace) => {
      const agentToken = agentTokenFor(agentTokens, request.agent);
      return typeof mcpForImpl === "function"
        ? mcpForImpl(request, workspace, { url, token: agentToken, hostId })
        : mountMcp(request.adapter, {
            dir: workspace,
            credentialDir: join(
              credentialRoot,
              createHash("sha256")
                .update(`${request.user}\0${request.project}\0${request.agent}`)
                .digest("hex"),
            ),
            url,
            token: agentToken,
            bridgePath: WORKER_ENTRY,
            bridgeArgs: [WORKER_MCP_BRIDGE_ARG],
          });
    },
  });
  const worker = new RemoteRunnerWorker({ url, token, hostId, runner });
  return Object.freeze({
    worker,
    runner,
    hostId,
    url,
    workspaceRoot,
    credentialRoot,
    sessionPath,
  });
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
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  if (process.argv.length === 3 && process.argv[2] === WORKER_MCP_BRIDGE_ARG) {
    runMcpBridge();
  } else {
    await runRunnerWorker();
  }
}
