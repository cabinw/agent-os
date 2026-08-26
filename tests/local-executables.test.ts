import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverLocalExecutables } from "../apps/chat-spike/src/local-executables.mjs";

describe("local vendor executable discovery", () => {
  it("canonicalizes executable files found on an absolute PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "local-executables-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const claude = join(bin, "claude");
    writeFileSync(claude, "#!/bin/sh\nexit 0\n");
    chmodSync(claude, 0o700);

    const found = discoverLocalExecutables({ PATH: bin }, ["claude", "grok"]);

    expect(found.get("claude")).toBe(realpathSync(claude));
    expect(found.has("grok")).toBe(false);
  });

  it("ignores relative PATH entries and honors an explicit absolute override", () => {
    const root = mkdtempSync(join(tmpdir(), "local-executables-explicit-"));
    const grok = join(root, "grok-custom");
    writeFileSync(grok, "#!/bin/sh\nexit 0\n");
    chmodSync(grok, 0o700);

    const found = discoverLocalExecutables(
      { PATH: "relative", AGENT_OS_GROK_BIN: grok },
      ["grok"],
    );

    expect(found.get("grok")).toBe(realpathSync(grok));
  });
});
