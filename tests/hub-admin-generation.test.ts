import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bootstrap = "deploy/hub/bootstrap-admin.sh";
const library = "deploy/hub/bin/lib.sh";
const digestHelper = "deploy/hub/admin-generation-digest.mjs";
const executionFixture = "tests/fixtures/hub-admin-generation-execution.sh";
const oldAdmin = "444a95509b66052f71dfe94b725dbfbf6de82f053440cdba153f4b567422dbc6";
const newAdmin = "f90634641ef071322baa637b6eb059ee8cad7a0bf3d552b4ae8e59ac37cfcde8";
const oldRuntime = "ccbc5110a87237401808774011390e335c2437080c48ab7fedf5e04d46944440";
const newRuntime = oldRuntime;
const predecessor = "8ff2613d3a952cc35f4954b8cfccb0206e1514d094cdec2ee3c774d44e5e853f";
const predecessorTransaction =
  "upgrade-admin-migration-1f064246a0f547571aa832b374baae377a8bbfb3b8b10733ed530b459d168220-attempt-000001";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    spawnSync("/bin/chmod", ["-R", "u+w", root]);
    rmSync(root, { force: true, recursive: true });
  }
});

function executionEnvironment(root: string, nonce: string) {
  return {
    AGENT_OS_DEPLOY_TEST_MODE: "1",
    AGENT_OS_DEPLOY_TEST_NONCE: nonce,
    AGENT_OS_DEPLOY_TEST_ROOT: root,
    AGENT_OS_GENERATION_SOURCE_ROOT: join(process.cwd(), "deploy/hub"),
    AGENT_OS_NODE_BIN: process.execPath,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
}

function createExecutionFixture() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "agent-os-generation-execution-"),
  );
  roots.push(root);
  const nonce = "admin_generation_execution_test_0001";
  writeFileSync(join(root, ".agent-os-deploy-test-root"), `${nonce}\n`, {
    mode: 0o600,
  });
  const env = executionEnvironment(root, nonce);
  const initialized = spawnSync("/bin/bash", ["-p", executionFixture, "init"], {
    encoding: "utf8",
    env,
  });
  expect(initialized.status, initialized.stderr).toBe(0);
  return { env, oldDigest: initialized.stdout.trim(), root };
}

function runExecutionFixture(
  fixture: ReturnType<typeof createExecutionFixture>,
  ...args: string[]
) {
  return spawnSync("/bin/bash", ["-p", executionFixture, ...args], {
    encoding: "utf8",
    env: fixture.env,
  });
}

function killExecutionAtPhase(
  fixture: ReturnType<typeof createExecutionFixture>,
  action: "forward" | "rollback",
  phase: string,
) {
  return new Promise<{ signal: NodeJS.Signals | null; stderr: string; stdout: string }>(
    (resolve, reject) => {
      const child = spawn("/bin/bash", ["-p", executionFixture, "run", action], {
        env: fixture.env,
      });
      let stdout = "";
      let stderr = "";
      let killed = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (
          !killed &&
          stdout.includes(`phase=admin_migration_${phase} status=recorded`)
        ) {
          killed = child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (_code, signal) => {
        if (!killed) {
          reject(new Error(`phase ${phase} was not observed; stderr=${stderr}`));
          return;
        }
        resolve({ signal, stderr, stdout });
      });
    },
  );
}

function statusFields(fixture: ReturnType<typeof createExecutionFixture>) {
  const result = runExecutionFixture(fixture, "status");
  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split(" ")
      .map((field) => field.split("=", 2)),
  );
}

function copySource(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-os-admin-generation-"));
  roots.push(root);
  cpSync("deploy/hub", root, { recursive: true });
  return root;
}

function digest(root = "deploy/hub") {
  const sourceRoot = root.startsWith("/") ? root : join(process.cwd(), root);
  const testRoot = mkdtempSync(
    join(realpathSync(tmpdir()), "agent-os-generation-contract-"),
  );
  roots.push(testRoot);
  const nonce = "admin_generation_contract_test_0001";
  writeFileSync(join(testRoot, ".agent-os-deploy-test-root"), `${nonce}\n`, {
    mode: 0o600,
  });
  const result = spawnSync(
    "/bin/bash",
    [
      "-p",
      "-c",
      'source "$LIB"; admin=(); while IFS= read -r line; do admin+=("$line"); done < <(admin_files); runtime=(); while IFS= read -r line; do runtime+=("$line"); done < <(legacy_runtime_files); exec "$NODE" "$HELPER" "$SOURCE_ROOT" "${admin[@]}" --runtime "${runtime[@]}"',
    ],
    {
      encoding: "utf8",
      env: {
        AGENT_OS_DEPLOY_TEST_MODE: "1",
        AGENT_OS_DEPLOY_TEST_NONCE: nonce,
        AGENT_OS_DEPLOY_TEST_ROOT: testRoot,
        HELPER: join(process.cwd(), digestHelper),
        LIB: join(process.cwd(), library),
        NODE: process.execPath,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        SOURCE_ROOT: sourceRoot,
      },
    },
  );
  return { ...result, value: result.status === 0 ? JSON.parse(result.stdout) : null };
}

function runLibraryScript(script: string) {
  const testRoot = mkdtempSync(
    join(realpathSync(tmpdir()), "agent-os-generation-library-"),
  );
  roots.push(testRoot);
  const nonce = "admin_generation_library_test_0001";
  writeFileSync(join(testRoot, ".agent-os-deploy-test-root"), `${nonce}\n`, {
    mode: 0o600,
  });
  return spawnSync(
    "/bin/bash",
    [
      "-p",
      "-c",
      `source "$LIB"; configure_admin_migration_contract generation "$OLD_ADMIN" "$NEW_ADMIN" "$OLD_RUNTIME" "$NEW_RUNTIME" "$PREDECESSOR_TRANSACTION" "$PREDECESSOR"; ${script}`,
    ],
    {
      encoding: "utf8",
      env: {
        AGENT_OS_DEPLOY_TEST_MODE: "1",
        AGENT_OS_DEPLOY_TEST_NONCE: nonce,
        AGENT_OS_DEPLOY_TEST_ROOT: testRoot,
        AGENT_OS_NODE_BIN: process.execPath,
        LIB: join(process.cwd(), library),
        NEW_ADMIN: newAdmin,
        NEW_RUNTIME: newRuntime,
        OLD_ADMIN: oldAdmin,
        OLD_RUNTIME: oldRuntime,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PREDECESSOR: predecessor,
        PREDECESSOR_TRANSACTION: predecessorTransaction,
      },
    },
  );
}

describe("allowlisted Hub admin generation upgrade", () => {
  it("pins the one reviewed admin/runtime/predecessor edge outside the installed tree", () => {
    const source = readFileSync(bootstrap, "utf8");
    for (const value of [oldAdmin, newAdmin, oldRuntime, newRuntime, predecessor]) {
      expect(source).toContain(value);
      expect(readFileSync(library, "utf8")).not.toContain(value);
    }
    expect(source).toContain("--upgrade-generation hub-admin-25-20260825-g1");
    expect(source).not.toContain("--expected-next-sha256");
  });

  it("derives the final 25-file target identity without publishing a tree", () => {
    const result = digest();
    expect(result.status, result.stderr).toBe(0);
    expect(result.value).toEqual({
      admin: { entryCount: 28, fileCount: 25, totalBytes: 542352, treeSha256: newAdmin },
      runtime: { entryCount: 5, fileCount: 5, totalBytes: 9204, treeSha256: oldRuntime },
    });
  });

  it("rejects a changed target source before it can match the allowlist", () => {
    const root = copySource();
    writeFileSync(
      join(root, "bin/lib.sh"),
      `${readFileSync(join(root, "bin/lib.sh"), "utf8")}\n`,
    );
    const result = digest(root);
    expect(result.status).toBe(0);
    expect(result.value.admin.treeSha256).not.toBe(newAdmin);
  });

  it("rejects symbolic and multiply-linked source files", () => {
    const symlinkRoot = copySource();
    const symlinkTarget = join(symlinkRoot, "env.example");
    unlinkSync(symlinkTarget);
    symlinkSync("bin/lib.sh", symlinkTarget);
    expect(digest(symlinkRoot).status).toBe(1);

    const hardlinkRoot = copySource();
    const peer = join(hardlinkRoot, "env.example.peer");
    linkSync(join(hardlinkRoot, "env.example"), peer);
    expect(digest(hardlinkRoot).status).toBe(1);
  });

  it("completes all source and identity preflights before the global lock", () => {
    const source = readFileSync(bootstrap, "utf8");
    const configure = source.indexOf("configure_admin_migration_contract");
    const preflight = source.indexOf("preflight_installed_admin_migration", configure);
    const lock = source.indexOf("acquire_deploy_lock", preflight);
    expect(configure).toBeGreaterThan(0);
    expect(preflight).toBeGreaterThan(configure);
    expect(lock).toBeGreaterThan(preflight);
  });

  it("classifies the exact predecessor and rejects unknown generation history", () => {
    const source = readFileSync(library, "utf8");
    expect(source).toContain("verify_admin_generation_history_allowlist");
    expect(source).toContain("admin generation predecessor history changed");
    expect(source).toContain(
      "admin generation history contains an unallowlisted transaction",
    );
    expect(source.indexOf("verify_admin_generation_history_allowlist")).toBeLessThan(
      source.indexOf(
        "select_admin_migration_attempt",
        source.indexOf("preflight_installed_admin_migration"),
      ),
    );
  });

  it("permits absent predecessor history but rejects unknown and changed roots", () => {
    expect(
      runLibraryScript(
        'mkdir -p "$RECOVERY_ROOT"; verify_admin_generation_history_allowlist',
      ).status,
    ).toBe(0);

    const unknown = runLibraryScript(
      'mkdir -p "$RECOVERY_ROOT/upgrade-admin-migration-ffffffffffffffffffffffffffffffff"; verify_admin_generation_history_allowlist',
    );
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unallowlisted transaction");

    const changed = runLibraryScript(
      'mkdir -p "$RECOVERY_ROOT/$PREDECESSOR_TRANSACTION"; printf changed >"$RECOVERY_ROOT/$PREDECESSOR_TRANSACTION/tampered"; verify_admin_generation_history_allowlist',
    );
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("predecessor history changed");
  });

  it("stages and switches whole trees under the durable phase journal", () => {
    const source = readFileSync(library, "utf8");
    expect(source).toContain('mv "$ADMIN_ROOT" "$ADMIN_MIGRATION_PREVIOUS"');
    expect(source).toContain('mv "$ADMIN_MIGRATION_STAGE" "$ADMIN_ROOT"');
    for (const phase of [
      "blocked",
      "stopped",
      "prepared",
      "runtime_activated",
      "admin_activated",
      "committed",
      "rolled_back",
      "finalized",
    ]) {
      expect(source).toContain(phase);
    }
    expect(source).not.toContain('cp -R "$ADMIN_MIGRATION_STAGE" "$ADMIN_ROOT"');
  });

  it("resumes a real whole-tree generation switch after external SIGKILL", async () => {
    const fixture = createExecutionFixture();
    const killed = await killExecutionAtPhase(fixture, "forward", "admin_activated");
    expect(killed.signal).toBe("SIGKILL");

    const resumed = runExecutionFixture(fixture, "run", "forward");
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(statusFields(fixture)).toMatchObject({
      active: "yes",
      committed: "yes",
      enabled: "yes",
      finalized: "yes",
      guards: "clean",
      rolled_back: "no",
    });
  }, 30_000);

  it.each([
    ["stopped", 0],
    ["prepared", 1],
  ])(
    "rolls back the old whole tree after a %s phase crash",
    async (phase, _prepared) => {
      const fixture = createExecutionFixture();
      const killed = await killExecutionAtPhase(fixture, "forward", phase);
      expect(killed.signal).toBe("SIGKILL");

      const rolledBack = runExecutionFixture(fixture, "run", "rollback");
      expect(rolledBack.status, rolledBack.stderr).toBe(0);
      expect(statusFields(fixture)).toMatchObject({
        active: "yes",
        current: fixture.oldDigest,
        enabled: "yes",
        finalized: "yes",
        guards: "clean",
        rolled_back: "yes",
      });
    },
    30_000,
  );

  it("rejects a changed frozen payload and remains transaction-blocked", async () => {
    const fixture = createExecutionFixture();
    const killed = await killExecutionAtPhase(fixture, "forward", "prepared");
    expect(killed.signal).toBe("SIGKILL");
    expect(runExecutionFixture(fixture, "tamper-new-runtime").status).toBe(0);

    const rejected = runExecutionFixture(fixture, "run", "forward");
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      "frozen admin migration runtime payload digest changed",
    );
    expect(statusFields(fixture)).toMatchObject({
      active: "no",
      committed: "no",
      enabled: "no",
      finalized: "no",
      guards: "present",
    });
  }, 30_000);
});
