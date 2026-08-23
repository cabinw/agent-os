#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, normalize } from "node:path/posix";

const MAX_ENV_BYTES = 64 * 1024;
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 4096;
const REQUIRED_AGENTS = Object.freeze(["claude", "grok", "kimi", "codex"]);
const REQUIRED_NAMES = Object.freeze([
  "HOST",
  "PORT",
  "LOG_PATH",
  "AGENT_OS_REMOTE_STATE_PATH",
  "AGENT_OS_RUNNER_MODE",
  "AGENT_OS_RUNNER_ID",
  "AGENT_OS_RUNNER_TOKEN",
  "AGENT_OS_HUMAN_TOKEN",
  "AGENT_OS_AGENT_TOKENS",
  "AGENT_OS_ALLOWED_ORIGINS",
  "HOP_BUDGET",
]);
const ALLOWED_NAMES = new Set(REQUIRED_NAMES);

function invalid(message) {
  throw new Error(message);
}

function assertFilePolicy(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    invalid("environment file is not readable");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    invalid("environment file must be a regular file, not a symbolic link");
  }
  if (stat.size > MAX_ENV_BYTES) invalid("environment file exceeds 64 KiB");
  if ((stat.mode & 0o777) !== 0o600) {
    invalid("environment file mode must be exactly 0600");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && stat.uid !== currentUid) {
    invalid(
      currentUid === 0
        ? "environment file must be owned by root"
        : "environment file must be owned by the validating account",
    );
  }
}

function parseRestrictedEnvironment(path) {
  assertFilePolicy(path);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    invalid("environment file is not readable UTF-8 text");
  }
  if (raw.includes("\0")) invalid("environment file contains a NUL byte");

  const values = new Map();
  for (const [offset, line] of raw.split(/\r?\n/u).entries()) {
    const lineNumber = offset + 1;
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([^\r\n]*)$/u.exec(line);
    if (!match) invalid(`line ${lineNumber} is not in restricted NAME=value form`);
    const [, name, encodedValue] = match;
    if (!ALLOWED_NAMES.has(name))
      invalid(`line ${lineNumber} uses unknown variable ${name}`);
    if (values.has(name)) invalid(`line ${lineNumber} duplicates variable ${name}`);
    if (encodedValue === "" || encodedValue !== encodedValue.trim()) {
      invalid(`variable ${name} must have one non-empty, unpadded value`);
    }
    let value = encodedValue;
    if (name === "AGENT_OS_AGENT_TOKENS") {
      const quoted = /^'([^']+)'$/u.exec(encodedValue);
      if (!quoted) {
        invalid("AGENT_OS_AGENT_TOKENS must be one single-quoted canonical JSON value");
      }
      value = quoted[1];
    } else if (
      encodedValue.includes("\\") ||
      encodedValue.includes("'") ||
      encodedValue.includes('"')
    ) {
      invalid(`variable ${name} contains unsupported EnvironmentFile quoting`);
    }
    if (value.includes("<") || value.includes(">")) {
      invalid(`variable ${name} still contains a placeholder`);
    }
    values.set(name, value);
  }
  for (const name of REQUIRED_NAMES) {
    if (!values.has(name)) invalid(`required variable ${name} is missing`);
  }
  return values;
}

function assertToken(value, label) {
  if (
    typeof value !== "string" ||
    value.length < MIN_TOKEN_LENGTH ||
    value.length > MAX_TOKEN_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    invalid(`${label} must be 32..4096 base64url characters`);
  }
  return value;
}

function assertStatePath(value, expected, label) {
  if (!isAbsolute(value) || normalize(value) !== value || value !== expected) {
    invalid(`${label} must use the canonical Hub state path`);
  }
}

function validateAgentTokens(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid("AGENT_OS_AGENT_TOKENS must be canonical compact JSON");
  }
  if (
    parsed === null ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    JSON.stringify(parsed) !== raw
  ) {
    invalid(
      "AGENT_OS_AGENT_TOKENS must be canonical compact JSON without duplicate keys",
    );
  }
  const names = Object.keys(parsed);
  if (
    names.length !== REQUIRED_AGENTS.length ||
    REQUIRED_AGENTS.some((name) => !Object.hasOwn(parsed, name))
  ) {
    invalid("AGENT_OS_AGENT_TOKENS must contain exactly claude, grok, kimi and codex");
  }
  return REQUIRED_AGENTS.map((name) =>
    assertToken(parsed[name], `token for agent ${name}`),
  );
}

function validateOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    invalid("AGENT_OS_ALLOWED_ORIGINS must be one absolute HTTPS origin");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    value !== url.origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port !== "" ||
    isIP(hostname) !== 0 ||
    !hostname.includes(".") ||
    [".invalid", ".example", ".test", ".localhost"].some((suffix) =>
      hostname.endsWith(suffix),
    )
  ) {
    invalid("AGENT_OS_ALLOWED_ORIGINS must be one non-placeholder HTTPS FQDN origin");
  }
}

function validate(path, candidateRevision = null) {
  const values = parseRestrictedEnvironment(path);
  if (values.get("HOST") !== "127.0.0.1") invalid("HOST must be exactly 127.0.0.1");

  if (
    candidateRevision !== null &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(candidateRevision)
  ) {
    invalid("candidate revision must be a filesystem-safe identifier");
  }
  const candidateStateRoot =
    candidateRevision === null
      ? "/var/lib/agent-os/hub"
      : `/var/lib/agent-os/hub-candidates/${candidateRevision}`;
  const expectedPort = candidateRevision === null ? 4173 : 14173;
  const portText = values.get("PORT");
  if (portText !== String(expectedPort)) {
    invalid(
      candidateRevision === null
        ? "PORT must be exactly 4173 for this audited deployment unit"
        : "candidate PORT must be exactly 14173",
    );
  }
  const port = expectedPort;
  assertStatePath(
    values.get("LOG_PATH"),
    `${candidateStateRoot}/events.jsonl`,
    "LOG_PATH",
  );
  assertStatePath(
    values.get("AGENT_OS_REMOTE_STATE_PATH"),
    `${candidateStateRoot}/remote-placement.json`,
    "AGENT_OS_REMOTE_STATE_PATH",
  );
  if (values.get("AGENT_OS_RUNNER_MODE") !== "remote") {
    invalid("AGENT_OS_RUNNER_MODE must be exactly remote");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(values.get("AGENT_OS_RUNNER_ID"))) {
    invalid("AGENT_OS_RUNNER_ID must be a stable 1..128 character identifier");
  }

  const tokens = [
    assertToken(values.get("AGENT_OS_RUNNER_TOKEN"), "AGENT_OS_RUNNER_TOKEN"),
    assertToken(values.get("AGENT_OS_HUMAN_TOKEN"), "AGENT_OS_HUMAN_TOKEN"),
    ...validateAgentTokens(values.get("AGENT_OS_AGENT_TOKENS")),
  ];
  if (new Set(tokens).size !== tokens.length)
    invalid("all bearer credentials must be unique");

  validateOrigin(values.get("AGENT_OS_ALLOWED_ORIGINS"));
  const hopBudgetText = values.get("HOP_BUDGET");
  const hopBudget = Number(hopBudgetText);
  if (
    !Number.isSafeInteger(hopBudget) ||
    String(hopBudget) !== hopBudgetText ||
    hopBudget < 1 ||
    hopBudget > 100
  ) {
    invalid("HOP_BUDGET must be an integer from 1 through 100");
  }
  return Object.freeze({ port });
}

function main(argv) {
  let printPort = false;
  let candidateRevision = null;
  let path = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--print-port" && !printPort) {
      printPort = true;
    } else if (argument === "--candidate" && candidateRevision === null) {
      index += 1;
      candidateRevision = argv[index] ?? invalid("--candidate requires a revision");
    } else if (path === null && !argument.startsWith("--")) {
      path = argument;
    } else {
      invalid(
        "usage: validate-config.mjs [--print-port] [--candidate REVISION] ENV_FILE",
      );
    }
  }
  if (path === null) {
    invalid("usage: validate-config.mjs [--print-port] [--candidate REVISION] ENV_FILE");
  }
  const config = validate(path, candidateRevision);
  if (printPort) process.stdout.write(`${config.port}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `hub configuration rejected: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}
