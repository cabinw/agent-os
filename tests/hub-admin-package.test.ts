import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("deploy/hub/bin/package-admin-kit.sh");
const source = resolve("deploy/hub");
const roots: string[] = [];

function outputPath() {
  const root = mkdtempSync(join(tmpdir(), "agent-os-admin-package-test-"));
  roots.push(root);
  return join(root, "admin-kit.tar.gz");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("admin-kit package boundary", () => {
  it("creates the exact 27-file cold artifact and checksum", () => {
    const output = outputPath();
    const result = spawnSync(script, ["--source", source, "--output", output], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /^admin_kit status=ok sha256=[a-f0-9]{64} files=27\n$/u,
    );
    expect(existsSync(output)).toBe(true);
    expect(readFileSync(`${output}.sha256`, "utf8")).toMatch(
      /^[a-f0-9]{64} {2}admin-kit\.tar\.gz\n$/u,
    );
    const listing = spawnSync("/usr/bin/tar", ["-tzf", output], {
      encoding: "utf8",
      env: {},
    });
    expect(listing.status, listing.stderr).toBe(0);
    const files = listing.stdout
      .trim()
      .split("\n")
      .filter((item) => !item.endsWith("/"));
    expect(files).toHaveLength(27);
    expect(files).toContain("./admin-generation-digest.mjs");
    expect(files).toContain("./bootstrap-admin.sh");
    expect(files).toContain("./bin/lib.sh");
  });

  it("never overwrites an existing artifact", () => {
    const output = outputPath();
    writeFileSync(output, "preserve", { mode: 0o600 });
    const result = spawnSync(script, ["--source", source, "--output", output], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("output already exists");
    expect(readFileSync(output, "utf8")).toBe("preserve");
  });
});
