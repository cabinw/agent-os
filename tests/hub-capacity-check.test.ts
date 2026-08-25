import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — deployment helpers are plain .mjs, not part of tsc --build
import {
  MIN_RESERVE_BYTES,
  MIN_RESERVE_INODES,
  evaluateCapacity,
  serializeCapacity,
} from "../deploy/hub/bin/capacity-check.mjs";

const SCRIPT = resolve("deploy/hub/bin/capacity-check.mjs");
const roots: string[] = [];
const NONCE = "capacity_check_test_nonce_1234567890";

function sample(device: string, availableBytes: bigint, availableInodes: bigint) {
  return {
    bavail: availableBytes,
    bsize: 1n,
    device,
    ffree: availableInodes,
  };
}

function makeRoot() {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "agent-os-capacity-")),
  );
  roots.push(root);
  const state = join(root, "state");
  const backup = join(root, "backup");
  mkdirSync(state);
  mkdirSync(backup);
  const marker = join(root, ".agent-os-deploy-test-root");
  writeFileSync(marker, NONCE, { mode: 0o600 });
  chmodSync(marker, 0o600);
  return { backup, root, state };
}

function injectedSample(dev: string, availableBytes: bigint, availableInodes: bigint) {
  return {
    bavail: availableBytes.toString(),
    bsize: "1",
    dev,
    ffree: availableInodes.toString(),
  };
}

function run(
  paths: { backup: string; root: string; state: string },
  statfs: unknown,
  extraArguments: string[] = [],
  envOverrides: Record<string, string | undefined> = {},
) {
  const env = { ...process.env };
  for (const name of [
    "AGENT_OS_DEPLOY_TEST_MODE",
    "AGENT_OS_DEPLOY_TEST_ROOT",
    "AGENT_OS_DEPLOY_TEST_NONCE",
  ]) {
    delete env[name];
  }
  for (const [name, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--state",
      paths.state,
      "--backup",
      paths.backup,
      ...extraArguments,
      "--test-statfs-json",
      JSON.stringify(statfs),
    ],
    { encoding: "utf8", env },
  );
}

function validEnvironment(root: string) {
  return {
    AGENT_OS_DEPLOY_TEST_MODE: "1",
    AGENT_OS_DEPLOY_TEST_NONCE: NONCE,
    AGENT_OS_DEPLOY_TEST_ROOT: root,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Hub capacity calculation", () => {
  it("uses bavail times bsize and rejects a byte deficit", () => {
    const result = evaluateCapacity({
      state: {
        bavail: MIN_RESERVE_BYTES / 4096n - 1n,
        bsize: 4096n,
        device: "1",
        ffree: MIN_RESERVE_INODES,
      },
      backup: sample("2", MIN_RESERVE_BYTES, MIN_RESERVE_INODES),
    });

    expect(result.ok).toBe(false);
    expect(result.filesystems[0]).toMatchObject({
      availableBytes: MIN_RESERVE_BYTES - 4096n,
      requiredBytes: MIN_RESERVE_BYTES,
      sufficient: false,
    });
  });

  it("rejects an inode deficit even when byte capacity is sufficient", () => {
    const result = evaluateCapacity({
      state: sample("1", MIN_RESERVE_BYTES, MIN_RESERVE_INODES - 1n),
      backup: sample("2", MIN_RESERVE_BYTES, MIN_RESERVE_INODES),
    });

    expect(result.ok).toBe(false);
    expect(result.filesystems[0]).toMatchObject({
      availableInodes: MIN_RESERVE_INODES - 1n,
      requiredInodes: MIN_RESERVE_INODES,
      sufficient: false,
    });
  });

  it("accepts exact byte and inode boundaries", () => {
    const requiredBytes = 12345n;
    const requiredInodes = 23n;
    const result = evaluateCapacity({
      state: sample("1", MIN_RESERVE_BYTES, MIN_RESERVE_INODES),
      backup: sample(
        "2",
        MIN_RESERVE_BYTES + requiredBytes,
        MIN_RESERVE_INODES + requiredInodes,
      ),
      requiredBytes,
      requiredInodes,
    });

    expect(result.ok).toBe(true);
    expect(result.filesystems).toHaveLength(2);
    expect(result.filesystems[1]).toMatchObject({
      availableBytes: MIN_RESERVE_BYTES + requiredBytes,
      availableInodes: MIN_RESERVE_INODES + requiredInodes,
      requiredBytes: MIN_RESERVE_BYTES + requiredBytes,
      requiredInodes: MIN_RESERVE_INODES + requiredInodes,
      sufficient: true,
    });
  });

  it("deduplicates one filesystem and applies snapshot demand only once", () => {
    const requiredBytes = 99n;
    const requiredInodes = 7n;
    const result = evaluateCapacity({
      state: sample(
        "7",
        MIN_RESERVE_BYTES + requiredBytes + 500n,
        MIN_RESERVE_INODES + requiredInodes + 10n,
      ),
      backup: sample(
        "7",
        MIN_RESERVE_BYTES + requiredBytes,
        MIN_RESERVE_INODES + requiredInodes,
      ),
      requiredBytes,
      requiredInodes,
    });

    expect(result.ok).toBe(true);
    expect(result.filesystems).toHaveLength(1);
    expect(result.filesystems[0]).toMatchObject({
      roles: ["state", "backup"],
      availableBytes: MIN_RESERVE_BYTES + requiredBytes,
      requiredBytes: MIN_RESERVE_BYTES + requiredBytes,
      requiredInodes: MIN_RESERVE_INODES + requiredInodes,
    });
  });

  it("keeps state and backup requirements separate across filesystems", () => {
    const result = evaluateCapacity({
      state: sample("1", MIN_RESERVE_BYTES, MIN_RESERVE_INODES),
      backup: sample("2", MIN_RESERVE_BYTES + 8n, MIN_RESERVE_INODES + 3n),
      requiredBytes: 8n,
      requiredInodes: 3n,
    });
    const report = JSON.parse(serializeCapacity(result));

    expect(report).toEqual({
      ok: true,
      filesystemCount: 2,
      filesystems: [
        {
          roles: ["state"],
          availableBytes: MIN_RESERVE_BYTES.toString(),
          requiredBytes: MIN_RESERVE_BYTES.toString(),
          availableInodes: MIN_RESERVE_INODES.toString(),
          requiredInodes: MIN_RESERVE_INODES.toString(),
          sufficient: true,
        },
        {
          roles: ["backup"],
          availableBytes: (MIN_RESERVE_BYTES + 8n).toString(),
          requiredBytes: (MIN_RESERVE_BYTES + 8n).toString(),
          availableInodes: (MIN_RESERVE_INODES + 3n).toString(),
          requiredInodes: (MIN_RESERVE_INODES + 3n).toString(),
          sufficient: true,
        },
      ],
    });
  });

  it("accounts for restore staging on the state filesystem", () => {
    const result = evaluateCapacity({
      state: sample("1", MIN_RESERVE_BYTES + 50n, MIN_RESERVE_INODES + 4n),
      backup: sample("2", MIN_RESERVE_BYTES, MIN_RESERVE_INODES),
      requiredStateBytes: 50n,
      requiredStateInodes: 4n,
    });

    expect(result.ok).toBe(true);
    expect(result.filesystems[0]).toMatchObject({
      roles: ["state"],
      requiredBytes: MIN_RESERVE_BYTES + 50n,
      requiredInodes: MIN_RESERVE_INODES + 4n,
    });
  });
});

describe("Hub capacity CLI", () => {
  it("emits path-free JSON and exits zero at the exact injected boundary", () => {
    const paths = makeRoot();
    const result = run(
      paths,
      {
        state: injectedSample("9", MIN_RESERVE_BYTES + 11n, MIN_RESERVE_INODES + 2n),
        backup: injectedSample("9", MIN_RESERVE_BYTES + 11n, MIN_RESERVE_INODES + 2n),
      },
      ["--required-bytes", "11", "--required-inodes", "2"],
      validEnvironment(paths.root),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      filesystemCount: 1,
      filesystems: [{ roles: ["state", "backup"], sufficient: true }],
    });
    expect(result.stdout).not.toContain(paths.root);
  });

  it("uses a fixed diagnostic and exit one for insufficient capacity", () => {
    const paths = makeRoot();
    const result = run(
      paths,
      {
        state: injectedSample("1", MIN_RESERVE_BYTES - 1n, MIN_RESERVE_INODES),
        backup: injectedSample("2", MIN_RESERVE_BYTES, MIN_RESERVE_INODES),
      },
      [],
      validEnvironment(paths.root),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Hub capacity check failed: insufficient filesystem capacity\n",
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
    expect(result.stderr).not.toContain(paths.root);
  });

  it("rejects test statfs injection unless every test-root guard holds", () => {
    const paths = makeRoot();
    const statfs = {
      state: injectedSample("1", MIN_RESERVE_BYTES, MIN_RESERVE_INODES),
      backup: injectedSample("2", MIN_RESERVE_BYTES, MIN_RESERVE_INODES),
    };

    const production = run(paths, statfs);
    expect(production.status).toBe(1);
    expect(production.stderr).toBe(
      "Hub capacity check failed: test filesystem injection requires deploy test mode\n",
    );

    const wrongNonce = run(paths, statfs, [], {
      ...validEnvironment(paths.root),
      AGENT_OS_DEPLOY_TEST_NONCE: `${NONCE}x`,
    });
    expect(wrongNonce.status).toBe(1);
    expect(wrongNonce.stderr).toBe(
      "Hub capacity check failed: deploy test root marker is missing or invalid\n",
    );

    const outside = makeRoot();
    const outsidePaths = { ...paths, state: outside.state };
    const escaped = run(outsidePaths, statfs, [], validEnvironment(paths.root));
    expect(escaped.status).toBe(1);
    expect(escaped.stderr).toBe(
      "Hub capacity check failed: state directory is outside the deploy test root\n",
    );
  });

  it("rejects a symlink in either directory path", () => {
    const paths = makeRoot();
    const linkedState = join(paths.root, "linked-state");
    symlinkSync(paths.state, linkedState);
    const statfs = {
      state: injectedSample("1", MIN_RESERVE_BYTES, MIN_RESERVE_INODES),
      backup: injectedSample("2", MIN_RESERVE_BYTES, MIN_RESERVE_INODES),
    };
    const result = run(
      { ...paths, state: linkedState },
      statfs,
      [],
      validEnvironment(paths.root),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Hub capacity check failed: state directory must be a canonical real directory\n",
    );
    expect(result.stderr).not.toContain(linkedState);
  });
});
