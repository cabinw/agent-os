import { X_OK } from "node:constants";
import { accessSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const EXECUTABLE_ENV = Object.freeze({
  claude: "AGENT_OS_CLAUDE_BIN",
  codex: "AGENT_OS_CODEX_BIN",
  grok: "AGENT_OS_GROK_BIN",
  kimi: "AGENT_OS_KIMI_BIN",
});

function usableExecutable(candidate) {
  if (!isAbsolute(candidate)) return null;
  try {
    const real = realpathSync(candidate);
    accessSync(real, X_OK);
    return real;
  } catch {
    return null;
  }
}

/**
 * Local development discovers installed vendor CLIs once at composition time.
 * Spawned adapters still receive an absolute, canonical executable and a
 * minimal environment; PATH is never forwarded to the child.
 */
export function discoverLocalExecutables(environment, adapterIds) {
  const result = new Map();
  const search = String(environment.PATH ?? "")
    .split(delimiter)
    .filter((entry) => isAbsolute(entry));
  for (const id of adapterIds) {
    const envName = EXECUTABLE_ENV[id];
    const configured = envName ? environment[envName] : undefined;
    const executable =
      (typeof configured === "string" ? usableExecutable(configured) : null) ??
      search.map((directory) => usableExecutable(join(directory, id))).find(Boolean) ??
      null;
    if (executable !== null) result.set(id, executable);
  }
  return result;
}
