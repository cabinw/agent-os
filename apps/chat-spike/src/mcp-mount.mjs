/**
 * Attaching Agent OS to a vendor agent — the third thing an adapter owns.
 *
 * The measured surprise (FINDINGS.md) is that three vendors which all speak MCP
 * fluently are attached by three unrelated mechanisms: a CLI flag pointing at a
 * file, a dotfile in the working directory, and a TOML entry gated on folder
 * trust. Nothing is shared, so this cannot live in the core.
 *
 * Each agent gets its own directory, because two of the three mechanisms *are*
 * files in the working directory — a shared cwd would make every agent claim
 * the same identity.
 *
 * Returns `{ args, env }` to fold into the spawn, or `null` when the vendor
 * cannot participate (Codex), in which case its adapter translates for it.
 */

import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_SPECS } from "./mcp-tools.mjs";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "../bin/agent-os-mcp.mjs");

/**
 * Must stay in step with TOOL_SPECS: Claude Code refuses an unlisted tool by
 * asking a human for permission, which in a headless turn reads as the agent
 * mysteriously declining to work. Derived rather than retyped for that reason.
 */
const TOOLS = Object.keys(TOOL_SPECS);

function secureDirectory(path) {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("MCP credential directory must be a canonical absolute path");
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync(path) !== path
  ) {
    throw new Error("MCP credential directory must be a fixed non-link directory");
  }
  chmodSync(path, 0o700);
}

function readFixedFile(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("MCP material must be a private non-link regular file");
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("MCP material identity changed while opening it");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function secureWriteOnce(path, content) {
  try {
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      writeFileSync(fd, content, "utf8");
      chmodSync(path, 0o600);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error?.code !== "EEXIST" || readFixedFile(path) !== content) throw error;
  }
}

function serverJson(url, secretPath, nodeExecutable, bridgePath, bridgeArgs) {
  return {
    mcpServers: {
      "agent-os": {
        command: nodeExecutable,
        args: [bridgePath, ...bridgeArgs],
        env: { AGENT_OS_URL: url, AGENT_OS_SECRET_FILE: secretPath },
      },
    },
  };
}

const MOUNTS = {
  /**
   * A file is mandatory: an inline JSON string makes the CLI read the following
   * prompt as a second config path.
   */
  claude(dir, url, secretPath, nodeExecutable, bridgePath, bridgeArgs) {
    const path = join(dir, "mcp.json");
    secureWriteOnce(
      path,
      JSON.stringify(
        serverJson(url, secretPath, nodeExecutable, bridgePath, bridgeArgs),
        null,
        2,
      ),
    );
    return {
      args: [
        "--mcp-config",
        path,
        "--allowedTools",
        ...TOOLS.map((t) => `mcp__agent-os__${t}`),
      ],
      env: {},
    };
  },

  kimi(dir, url, secretPath, nodeExecutable, bridgePath, bridgeArgs) {
    secureWriteOnce(
      join(dir, ".mcp.json"),
      JSON.stringify(
        serverJson(url, secretPath, nodeExecutable, bridgePath, bridgeArgs),
        null,
        2,
      ),
    );
    return { args: [], env: {} };
  },

  /**
   * `grok mcp add` silently drops `env`, so the TOML is written by hand.
   * Project-scoped servers do not start in an untrusted folder; a throwaway
   * per-agent directory can never be trusted, so the gate is turned off for it.
   */
  grok(dir, url, secretPath, nodeExecutable, bridgePath, bridgeArgs) {
    const cfg = join(dir, ".grok");
    mkdirSync(cfg, { recursive: true, mode: 0o700 });
    secureWriteOnce(
      join(cfg, "config.toml"),
      [
        "[mcp_servers.agent-os]",
        `command = ${JSON.stringify(nodeExecutable)}`,
        `args = ${JSON.stringify([bridgePath, ...bridgeArgs])}`,
        "enabled = true",
        "",
        "[mcp_servers.agent-os.env]",
        `AGENT_OS_URL = ${JSON.stringify(url)}`,
        `AGENT_OS_SECRET_FILE = ${JSON.stringify(secretPath)}`,
        "",
      ].join("\n"),
    );
    return {
      args: [
        "--permission-mode",
        "dontAsk",
        "--allow",
        "MCPTool(agent-os__*)",
        "--tools",
        "todo_write",
        "--no-subagents",
        "--disable-web-search",
        "--sandbox",
        "workspace",
      ],
      // This only bypasses trust for the generated 0700 workspace above. Tool
      // execution is still deny-by-default and kernel-sandboxed.
      env: { GROK_FOLDER_TRUST: "false" },
    };
  },
};

/**
 * @param {string} providerId
 * @param {{ dir: string, credentialDir: string, url: string, token: string|null,
 *           nodeExecutable?: string, bridgePath?: string,
 *           bridgeArgs?: string[] }} opts
 * @returns {{ args: string[], env: Record<string,string> } | null}
 */
export function mountMcp(
  providerId,
  {
    dir,
    credentialDir,
    url,
    token,
    nodeExecutable = process.execPath,
    bridgePath = BRIDGE,
    bridgeArgs = [],
  },
) {
  const mount = MOUNTS[providerId];
  if (!mount) return null;
  if (!token)
    throw new Error(`missing bearer token for participating agent ${providerId}`);
  if (typeof nodeExecutable !== "string" || !isAbsolute(nodeExecutable)) {
    throw new Error("MCP bridge Node executable must be an absolute path");
  }
  if (typeof bridgePath !== "string" || !isAbsolute(bridgePath)) {
    throw new Error("MCP bridge entry must be an absolute path");
  }
  if (
    !Array.isArray(bridgeArgs) ||
    bridgeArgs.some((value) => typeof value !== "string")
  ) {
    throw new Error("MCP bridge arguments must be strings");
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  secureDirectory(credentialDir);
  const secretPath = join(credentialDir, "mcp-secret.json");
  secureWriteOnce(secretPath, JSON.stringify({ token }));
  return mount(dir, url, secretPath, nodeExecutable, bridgePath, bridgeArgs);
}

/** Which vendors will actually call our tools — measured, never declared. */
export function participates(providerId) {
  return providerId in MOUNTS;
}
