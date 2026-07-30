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

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "../bin/agent-os-mcp.mjs");

const TOOLS = ["register_agent", "find_agent", "get_context", "send_message"];

function serverJson(url, caller) {
  return {
    mcpServers: {
      "agent-os": {
        command: "node",
        args: [BRIDGE],
        env: { AGENT_OS_URL: url, AGENT_OS_CALLER: caller },
      },
    },
  };
}

const MOUNTS = {
  /**
   * A file is mandatory: an inline JSON string makes the CLI read the following
   * prompt as a second config path.
   */
  claude(dir, url, caller) {
    const path = join(dir, "mcp.json");
    writeFileSync(path, JSON.stringify(serverJson(url, caller), null, 2));
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

  kimi(dir, url, caller) {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify(serverJson(url, caller), null, 2),
    );
    return { args: [], env: {} };
  },

  /**
   * `grok mcp add` silently drops `env`, so the TOML is written by hand.
   * Project-scoped servers do not start in an untrusted folder; a throwaway
   * per-agent directory can never be trusted, so the gate is turned off for it.
   */
  grok(dir, url, caller) {
    const cfg = join(dir, ".grok");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(
      join(cfg, "config.toml"),
      [
        "[mcp_servers.agent-os]",
        'command = "node"',
        `args = ["${BRIDGE}"]`,
        "enabled = true",
        "",
        "[mcp_servers.agent-os.env]",
        `AGENT_OS_URL = "${url}"`,
        `AGENT_OS_CALLER = "${caller}"`,
        "",
      ].join("\n"),
    );
    return { args: ["--always-approve"], env: { GROK_FOLDER_TRUST: "false" } };
  },
};

/**
 * @param {string} providerId
 * @param {{ dir: string, url: string, caller: string }} opts
 * @returns {{ args: string[], env: Record<string,string> } | null}
 */
export function mountMcp(providerId, { dir, url, caller }) {
  const mount = MOUNTS[providerId];
  if (!mount) return null;
  mkdirSync(dir, { recursive: true });
  return mount(dir, url, caller);
}

/** Which vendors will actually call our tools — measured, never declared. */
export function participates(providerId) {
  return providerId in MOUNTS;
}
