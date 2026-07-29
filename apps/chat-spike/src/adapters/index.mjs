/**
 * The adapter registry.
 *
 * Nothing above this file names a vendor — the server picks an adapter by id
 * and reads `capabilities` to decide what the UI can show. That is ADR-004
 * applied one level down: routing reads capability, not provider.
 *
 * Note these are *integration* capabilities (can it stream? does it expose
 * reasoning? can a session be continued?), distinct from the *task*
 * capabilities in docs/protocol/agent-schema.md (coding, testing, research…).
 * Both are needed and they are not the same axis.
 */

import { ClaudeAdapter } from "./claude.mjs";
import { CodexAdapter } from "./codex.mjs";
import { GrokAdapter } from "./grok.mjs";
import { KimiAdapter } from "./kimi.mjs";

export const ADAPTERS = [CodexAdapter, ClaudeAdapter, GrokAdapter, KimiAdapter];

const BY_ID = new Map(ADAPTERS.map((A) => [A.id, A]));

export function getAdapter(id) {
  return BY_ID.get(id) ?? null;
}

/** Serialisable descriptor for the UI — no class references cross the wire. */
export function describeAdapters() {
  return ADAPTERS.map((A) => ({
    id: A.id,
    label: A.label,
    capabilities: A.capabilities,
  }));
}
