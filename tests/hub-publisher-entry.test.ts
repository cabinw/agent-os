import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const LIB = resolve("deploy/hub/bin/lib.sh");
const INSTALL = resolve("deploy/hub/bin/install.sh");
const UPGRADE = resolve("deploy/hub/bin/upgrade.sh");
const NONCE = "publisher_entry_test_nonce_000001";
const roots: string[] = [];

function fixture(output?: string) {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "publisher-entry-")),
  );
  roots.push(root);
  const verifier = join(root, "usr/libexec/agent-os/publisher/verify");
  const verifierPin = join(root, "etc/agent-os/publisher/verifier.sha256");
  const staging = join(root, "var/lib/agent-os/publisher/staging");
  mkdirSync(join(root, "usr/libexec/agent-os/publisher"), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "etc/agent-os/publisher"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, ".agent-os-deploy-test-root"), NONCE, { mode: 0o600 });
  const hash = "a".repeat(64);
  const published = join(staging, `hub-release-7-${hash}`);
  const caller = join(root, "caller.tar.gz");
  const envelope = join(root, "caller.envelope");
  writeFileSync(caller, "caller-bytes", { mode: 0o600 });
  writeFileSync(envelope, "envelope\n", { mode: 0o600 });
  writeFileSync(`${envelope}.sig`, "signature", { mode: 0o600 });
  writeFileSync(published, "verified-copy", { mode: 0o600 });
  const result =
    output ??
    `publisher_verifier result=ok artifact_type=hub-release sequence=7 artifact_sha256=${hash} artifact_bytes=13 published_path=${published}`;
  const verifierSource = `#!/bin/sh\nprintf '%s\\n' '${result}'\n`;
  writeFileSync(verifier, verifierSource, { mode: 0o555 });
  chmodSync(verifier, 0o555);
  writeFileSync(
    verifierPin,
    `${createHash("sha256").update(verifierSource).digest("hex")}\n`,
    { mode: 0o400 },
  );
  return { root, verifier, published, caller, envelope, hash };
}

function invoke(item: ReturnType<typeof fixture>) {
  const source = `
set -Eeuo pipefail
export AGENT_OS_DEPLOY_TEST_ROOT=${JSON.stringify(item.root)}
export AGENT_OS_DEPLOY_TEST_MODE=1
export AGENT_OS_DEPLOY_TEST_NONCE=${JSON.stringify(NONCE)}
source ${JSON.stringify(LIB)}
archive=${JSON.stringify(item.caller)}
checksum=
verify_published_hub_release "$archive" ${JSON.stringify(item.envelope)}
printf '%s|%s\\n' "$archive" "$checksum"
`;
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-p", "-c", source], {
    encoding: "utf8",
    env: {},
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Hub publisher entry boundary", () => {
  it("returns only the fixed published copy and caller replacement is irrelevant", () => {
    const item = fixture();
    const result = invoke(item);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`${item.published}|${item.hash}`);
    writeFileSync(item.caller, "replacement");
    expect(readFileSync(item.published, "utf8")).toBe("verified-copy");
  });

  it.each([
    [
      "polluted",
      `publisher_verifier result=ok artifact_type=hub-release sequence=7 artifact_sha256=${"a".repeat(64)} artifact_bytes=13 published_path=/tmp/wrong extra`,
      "release publisher verifier output is invalid",
    ],
    [
      "wrong-path",
      `publisher_verifier result=ok artifact_type=hub-release sequence=7 artifact_sha256=${"a".repeat(64)} artifact_bytes=13 published_path=/tmp/wrong`,
      "verified release publication path is invalid",
    ],
  ])("rejects %s output before deployment state exists", (_name, output, expected) => {
    const item = fixture(output);
    const result = invoke(item);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
    expect(existsSync(join(item.root, "run/agent-os/deploy.lock"))).toBe(false);
  });

  it("rejects a verifier digest mismatch without executing it", () => {
    const item = fixture();
    const marker = join(item.root, "verifier-executed");
    chmodSync(item.verifier, 0o755);
    writeFileSync(item.verifier, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, {
      mode: 0o555,
    });
    chmodSync(item.verifier, 0o555);
    const result = invoke(item);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "publisher verifier executable digest is not allowlisted",
    );
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(item.root, "run/agent-os/deploy.lock"))).toBe(false);
  });

  it("does not relay verifier stderr", () => {
    const item = fixture();
    const canary = "publisher-secret-canary";
    const source = `#!/bin/sh\nprintf '%s\\n' '${canary}' >&2\nexit 1\n`;
    chmodSync(item.verifier, 0o755);
    writeFileSync(item.verifier, source, { mode: 0o555 });
    chmodSync(item.verifier, 0o555);
    const pin = join(item.root, "etc/agent-os/publisher/verifier.sha256");
    chmodSync(pin, 0o600);
    writeFileSync(pin, `${createHash("sha256").update(source).digest("hex")}\n`, {
      mode: 0o400,
    });
    chmodSync(pin, 0o400);
    const result = invoke(item);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release publisher verification failed");
    expect(result.stderr).not.toContain(canary);
    expect(existsSync(join(item.root, "run/agent-os/deploy.lock"))).toBe(false);
  });

  it("places verification before the deploy lock and removes checksum-only grammar", () => {
    for (const path of [INSTALL, UPGRADE]) {
      const source = readFileSync(path, "utf8");
      expect(source.indexOf("verify_published_hub_release")).toBeGreaterThan(0);
      expect(source.indexOf("verify_published_hub_release")).toBeLessThan(
        source.indexOf("acquire_deploy_lock"),
      );
      expect(source).not.toContain("--sha256");
    }
  });
});
