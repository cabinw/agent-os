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

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_SPECS } from "./mcp-tools.mjs";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "../bin/agent-os-mcp.mjs");

/**
 * Must stay in step with TOOL_SPECS: Claude Code refuses an unlisted tool by
 * asking a human for permission, which in a headless turn reads as the agent
 * mysteriously declining to work. Derived rather than retyped for that reason.
 */
const TOOLS = Object.keys(TOOL_SPECS);

function secureWrite(path, content) {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function serverJson(url, token) {
  return {
    mcpServers: {
      "agent-os": {
        command: "node",
        args: [BRIDGE],
        env: { AGENT_OS_URL: url, AGENT_OS_TOKEN: token },
      },
    },
  };
}

const MOUNTS = {
  /**
   * A file is mandatory: an inline JSON string makes the CLI read the following
   * prompt as a second config path.
   */
  claude(dir, url, token) {
    const path = join(dir, "mcp.json");
    secureWrite(path, JSON.stringify(serverJson(url, token), null, 2));
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

  kimi(dir, url, token) {
    secureWrite(join(dir, ".mcp.json"), JSON.stringify(serverJson(url, token), null, 2));
    return { args: [], env: {} };
  },

  /**
   * `grok mcp add` silently drops `env`, so the TOML is written by hand.
   * Project-scoped servers do not start in an untrusted folder; a throwaway
   * per-agent directory can never be trusted, so the gate is turned off for it.
   */
  grok(dir, url, token) {
    const cfg = join(dir, ".grok");
    mkdirSync(cfg, { recursive: true, mode: 0o700 });
    secureWrite(
      join(cfg, "config.toml"),
      [
        "[mcp_servers.agent-os]",
        'command = "node"',
        `args = [${JSON.stringify(BRIDGE)}]`,
        "enabled = true",
        "",
        "[mcp_servers.agent-os.env]",
        `AGENT_OS_URL = ${JSON.stringify(url)}`,
        `AGENT_OS_TOKEN = ${JSON.stringify(token)}`,
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
 * @param {{ dir: string, url: string, token: string|null }} opts
 * @returns {{ args: string[], env: Record<string,string> } | null}
 */
export function mountMcp(providerId, { dir, url, token }) {
  const mount = MOUNTS[providerId];
  if (!mount) return null;
  if (!token)
    throw new Error(`missing bearer token for participating agent ${providerId}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return mount(dir, url, token);
}

/** Which vendors will actually call our tools — measured, never declared. */
export function participates(providerId) {
  return providerId in MOUNTS;
}
