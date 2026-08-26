#!/usr/bin/env node
/**
 * Agent OS as an MCP server, over stdio.
 *
 * This is the **participation channel** an external agent connects to. It is a
 * thin bridge: the agent's MCP client spawns this process, and every tool call
 * is forwarded to the running chat-spike over HTTP, where validation,
 * authorization and event emission actually happen.
 *
 *   agent ──spawn──▶ this ──HTTP──▶ chat-spike ──▶ MCP tools ──▶ event log
 *
 * Deliberately holds no state and makes no decisions — putting either here
 * would create a second place that can write to the log.
 *
 * Attach it to Claude Code with:
 *   claude --mcp-config '{"mcpServers":{"agent-os":{"command":"node","args":["<abs path>"]}}}'
 *
 * Env: AGENT_OS_URL (default http://127.0.0.1:4173), AGENT_OS_SECRET_FILE.
 */

import { runMcpBridge } from "../src/mcp-bridge.mjs";

runMcpBridge();
