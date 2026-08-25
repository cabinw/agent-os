import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve("deploy/hub/bin/state-forensic.mjs");
const scratchDirectories: string[] = [];

type CommandResult = ReturnType<typeof spawnSync>;

type Summary = {
  operation: "create" | "verify";
  version: number;
  files: number;
  directories: number;
  bytes: number;
  treeSha256: string;
  manifestSha256: string;
};

type Fixture = {
  events: string;
  ledger: string;
  opaque: string;
  root: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalValue(record[key])]),
  );
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function scratch(): string {
  const path = realpathSync.native(
    mkdtempSync(join(tmpdir(), "agent-os-state-forensic-")),
  );
  chmodSync(path, 0o700);
  scratchDirectories.push(path);
  return path;
}

function shortScratch(): string {
  const path = realpathSync.native(mkdtempSync("/tmp/aof-"));
  chmodSync(path, 0o700);
  scratchDirectories.push(path);
  return path;
}

function directory(path: string, mode = 0o700): void {
  mkdirSync(path, { mode, recursive: true });
  chmodSync(path, mode);
}

function file(path: string, body: string | Buffer, mode = 0o600): void {
  directory(dirname(path));
  writeFileSync(path, body, { mode });
  chmodSync(path, mode);
}

function runtimeSecretCanary(): Buffer {
  return Buffer.from(
    `test-only-secret-canary-${randomBytes(32).toString("hex")}`,
    "utf8",
  );
}

function expectCanaryAbsent(canary: Buffer, value: string | Buffer): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  expect(bytes.includes(canary)).toBe(false);
}

function expectCredentialBearingArtifactProtection(root: string): void {
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      expect(stat.mode & 0o777).toBe(0o500);
      for (const name of readdirSync(path)) visit(join(path, name));
      return;
    }
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o400);
    expect(stat.nlink).toBe(1);
  };
  visit(root);
}

function fixture(base = scratch()): Fixture {
  const root = join(base, "state");
  directory(root);
  const events = join(root, "events.jsonl");
  const ledger = join(root, "remote-placement.json.requests", `${"a".repeat(64)}.json`);
  const opaque = join(root, "opaque.bin");
  file(events, Buffer.from('{"seq":1}\n{"broken":', "utf8"));
  file(ledger, Buffer.from('{"version":1,"request":', "utf8"));
  file(opaque, Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0a]));
  return { events, ledger, opaque, root };
}

function run(...arguments_: string[]): CommandResult {
  return spawnSync(process.execPath, [SCRIPT, ...arguments_], {
    encoding: "utf8",
    timeout: 20_000,
  });
}

function runCreate(root: string, snapshot: string): CommandResult {
  return run(
    "create",
    root,
    snapshot,
    "--owner-uid",
    String(process.getuid?.() ?? 0),
    "--owner-gid",
    String(process.getgid?.() ?? 0),
  );
}

function success(result: CommandResult): Summary {
  expect(result.status, result.stderr?.toString()).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout.toString()) as Summary;
}

function rejected(result: CommandResult, code: string): void {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`Hub state forensic snapshot failed: ${code}\n`);
}

function noPartial(parent: string): void {
  expect(readdirSync(parent).some((name) => name.includes(".partial-"))).toBe(false);
}

function makeWritable(path: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  } else if (stat.isFile()) {
    chmodSync(path, 0o600);
  }
}

function rewriteManifest(snapshot: string, body: string | Buffer): string {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const digest = sha256(bytes);
  chmodSync(snapshot, 0o700);
  for (const [name, value] of [
    ["manifest.json", bytes],
    ["manifest.sha256", Buffer.from(`${digest}\n`, "utf8")],
    ["COMPLETE", Buffer.from(`forensic-v1 ${digest}\n`, "utf8")],
  ] as const) {
    const path = join(snapshot, name);
    chmodSync(path, 0o600);
    writeFileSync(path, value);
    chmodSync(path, 0o400);
  }
  chmodSync(snapshot, 0o500);
  return digest;
}

function createSnapshot(
  source: Fixture,
  name = "snapshot-1",
): {
  path: string;
  summary: Summary;
} {
  const path = join(dirname(source.root), name);
  return { path, summary: success(runCreate(source.root, path)) };
}

async function runWhile(
  arguments_: string[],
  mutate: () => void,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [SCRIPT, ...arguments_], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timer = setInterval(() => {
    try {
      mutate();
    } catch {
      // Concurrent rename/write windows are expected; the next tick retries.
    }
  }, 0);
  return await new Promise((resolveResult) => {
    child.on("close", (status) => {
      clearInterval(timer);
      resolveResult({ status, stdout, stderr });
    });
  });
}

afterEach(() => {
  for (const path of scratchDirectories.splice(0)) {
    makeWritable(path);
    rmSync(path, { force: true, recursive: true });
  }
});

describe("raw Hub state forensic snapshot", () => {
  it("preserves malformed JSONL, malformed ledger JSON, and invalid UTF-8 byte-for-byte", () => {
    const source = fixture();
    const before = new Map(
      [source.events, source.ledger, source.opaque].map((path) => [
        path,
        readFileSync(path),
      ]),
    );
    const { path: snapshot, summary } = createSnapshot(source);

    expect(summary).toMatchObject({
      operation: "create",
      version: 1,
      files: 3,
      directories: 2,
      treeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    for (const sourcePath of [source.events, source.ledger, source.opaque]) {
      const relative = sourcePath.slice(source.root.length + 1);
      expect(readFileSync(join(snapshot, "data", relative))).toEqual(
        before.get(sourcePath),
      );
      expect(readFileSync(sourcePath)).toEqual(before.get(sourcePath));
    }
    expect(
      success(run("verify", snapshot, "--manifest-sha256", summary.manifestSha256)),
    ).toEqual({
      ...summary,
      operation: "verify",
    });
  });

  it("publishes only fixed owner-readable modes and records deep source metadata", () => {
    const source = fixture();
    chmodSync(source.opaque, 0o640);
    const { path: snapshot, summary } = createSnapshot(source);
    const manifest = JSON.parse(
      readFileSync(join(snapshot, "manifest.json"), "utf8"),
    ) as {
      artifactOwner: { uid: number; gid: number };
      directories: Array<Record<string, unknown>>;
      files: Array<Record<string, unknown>>;
      sourceTreeSha256: string;
      totals: Record<string, number>;
    };

    expect(lstatSync(snapshot).mode & 0o777).toBe(0o500);
    expect(lstatSync(join(snapshot, "data")).mode & 0o777).toBe(0o500);
    expect(
      lstatSync(join(snapshot, "data", "remote-placement.json.requests")).mode & 0o777,
    ).toBe(0o500);
    for (const path of [
      join(snapshot, "manifest.json"),
      join(snapshot, "manifest.sha256"),
      join(snapshot, "COMPLETE"),
      join(snapshot, "data", "events.jsonl"),
      join(snapshot, "data", "opaque.bin"),
    ]) {
      expect(lstatSync(path).mode & 0o777).toBe(0o400);
    }
    expect(manifest.artifactOwner).toEqual({
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    });
    expect(
      manifest.files.find((entry) => entry.relativePath === "opaque.bin"),
    ).toMatchObject({
      type: "file",
      mode: 0o640,
      size: 5,
      sha256: sha256(readFileSync(source.opaque)),
    });
    expect(manifest.directories[0]).toMatchObject({
      relativePath: ".",
      type: "directory",
    });
    expect(manifest.totals).toEqual({
      bytes: summary.bytes,
      directories: 2,
      entries: 4,
      files: 3,
    });
    expect(manifest.sourceTreeSha256).toBe(summary.treeSha256);
  });

  it("preserves an opaque secret canary without emitting it outside protected data", () => {
    const base = scratch();
    const source = fixture(base);
    const canary = runtimeSecretCanary();
    const relativePath = "credential-envelope.opaque";
    const sourcePath = join(source.root, relativePath);
    file(sourcePath, canary);
    expect(lstatSync(sourcePath).isFile()).toBe(true);
    expect(lstatSync(sourcePath).mode & 0o777).toBe(0o600);
    expect(lstatSync(sourcePath).nlink).toBe(1);

    const snapshot = join(base, "snapshot-redacted");
    const createdResult = runCreate(source.root, snapshot);
    expectCanaryAbsent(canary, createdResult.stdout?.toString() ?? "");
    expectCanaryAbsent(canary, createdResult.stderr?.toString() ?? "");
    const created = success(createdResult);
    expectCanaryAbsent(canary, JSON.stringify(created));

    expect(Object.keys(created)).toEqual([
      "operation",
      "version",
      "files",
      "directories",
      "bytes",
      "treeSha256",
      "manifestSha256",
    ]);
    expect(createdResult.stdout).not.toContain(base);
    expect(createdResult.stdout).not.toContain(relativePath);

    const verifiedResult = run(
      "verify",
      snapshot,
      "--manifest-sha256",
      created.manifestSha256,
    );
    expectCanaryAbsent(canary, verifiedResult.stdout?.toString() ?? "");
    expectCanaryAbsent(canary, verifiedResult.stderr?.toString() ?? "");
    const verified = success(verifiedResult);
    expectCanaryAbsent(canary, JSON.stringify(verified));
    expect(verified).toEqual({ ...created, operation: "verify" });
    expect(readFileSync(join(snapshot, "data", relativePath)).equals(canary)).toBe(true);

    for (const controlName of ["manifest.json", "manifest.sha256", "COMPLETE"]) {
      expectCanaryAbsent(canary, readFileSync(join(snapshot, controlName)));
    }

    // Forensic capture intentionally performs no content secret scan. Every artifact
    // must therefore be handled as root-only, credential-bearing high-sensitivity data.
    expectCredentialBearingArtifactProtection(snapshot);

    chmodSync(snapshot, 0o700);
    symlinkSync(join(snapshot, "data"), join(snapshot, "extra-link"));
    chmodSync(snapshot, 0o500);
    const failed = run("verify", snapshot);
    expectCanaryAbsent(canary, failed.stdout?.toString() ?? "");
    expectCanaryAbsent(canary, failed.stderr?.toString() ?? "");
    expect(failed.status).toBe(1);
    expect(failed.stderr).not.toContain(base);
  });

  it("never overwrites the only snapshot target and leaves it byte-identical", () => {
    const source = fixture();
    const { path: snapshot, summary } = createSnapshot(source);
    const manifestBefore = readFileSync(join(snapshot, "manifest.json"));
    const opaqueBefore = readFileSync(join(snapshot, "data", "opaque.bin"));
    file(source.opaque, Buffer.from("changed"));

    rejected(runCreate(source.root, snapshot), "target_exists");
    expect(readFileSync(join(snapshot, "manifest.json"))).toEqual(manifestBefore);
    expect(readFileSync(join(snapshot, "data", "opaque.bin"))).toEqual(opaqueBefore);
    expect(
      success(run("verify", snapshot, "--manifest-sha256", summary.manifestSha256))
        .manifestSha256,
    ).toBe(summary.manifestSha256);
    noPartial(dirname(snapshot));
  });

  it("does not follow symbolic links or accept multiply-linked files", () => {
    const symlinkSource = fixture();
    symlinkSync(symlinkSource.events, join(symlinkSource.root, "linked-events"));
    const symlinkTarget = join(dirname(symlinkSource.root), "symlink-snapshot");
    rejected(runCreate(symlinkSource.root, symlinkTarget), "unsafe_tree");
    expect(() => lstatSync(symlinkTarget)).toThrow();
    noPartial(dirname(symlinkTarget));

    const hardlinkSource = fixture();
    linkSync(hardlinkSource.events, join(hardlinkSource.root, "hardlinked-events"));
    const hardlinkTarget = join(dirname(hardlinkSource.root), "hardlink-snapshot");
    rejected(runCreate(hardlinkSource.root, hardlinkTarget), "unsafe_tree");
    expect(() => lstatSync(hardlinkTarget)).toThrow();
    noPartial(dirname(hardlinkTarget));
  });

  it("rejects FIFO and socket entries without opening or publishing them", async () => {
    const fifoSource = fixture();
    const fifo = join(fifoSource.root, "queue");
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    expect(made.status, made.stderr).toBe(0);
    const fifoTarget = join(dirname(fifoSource.root), "fifo-snapshot");
    rejected(runCreate(fifoSource.root, fifoTarget), "unsafe_tree");
    expect(() => lstatSync(fifoTarget)).toThrow();

    const socketSource = fixture(shortScratch());
    const socket = join(socketSource.root, "listener.sock");
    const server = createServer();
    const error = await new Promise<NodeJS.ErrnoException | null>((resolveListen) => {
      server.once("error", (value: NodeJS.ErrnoException) => resolveListen(value));
      server.listen(socket, () => resolveListen(null));
    });
    if (error) {
      expect(["EACCES", "EPERM"]).toContain(error.code);
      return;
    }
    try {
      const target = join(dirname(socketSource.root), "socket-snapshot");
      rejected(runCreate(socketSource.root, target), "unsafe_tree");
      expect(() => lstatSync(target)).toThrow();
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      try {
        unlinkSync(socket);
      } catch {
        // Some platforms remove a socket path during close.
      }
    }
  });

  it("rejects temporary, hidden, and unsafe state names", () => {
    for (const [index, name] of [
      "orphan.tmp",
      ".hidden",
      "state-partial-copy",
    ].entries()) {
      const source = fixture();
      file(join(source.root, name), "unsafe");
      const target = join(dirname(source.root), `unsafe-name-${index}`);
      rejected(runCreate(source.root, target), "unsafe_tree");
      expect(() => lstatSync(target)).toThrow();
      noPartial(dirname(target));
    }
  });

  it("rejects a device source without attempting to copy it", () => {
    const base = scratch();
    const target = join(base, "device-snapshot");
    rejected(runCreate(realpathSync.native("/dev/null"), target), "unsafe_source");
    expect(() => lstatSync(target)).toThrow();
    noPartial(base);
  });

  it("requires a no-follow private target parent", () => {
    const base = scratch();
    const source = fixture(base);
    const publicParent = join(base, "public-parent");
    directory(publicParent, 0o777);
    const publicTarget = join(publicParent, "snapshot-public");
    rejected(runCreate(source.root, publicTarget), "unsafe_target_parent");

    const privateParent = join(base, "private-parent");
    directory(privateParent);
    const linkParent = join(base, "linked-parent");
    symlinkSync(privateParent, linkParent);
    const linkedTarget = join(linkParent, "snapshot-linked");
    rejected(runCreate(source.root, linkedTarget), "unsafe_target_parent");
    expect(() => lstatSync(publicTarget)).toThrow();
    expect(() => lstatSync(join(privateParent, "snapshot-linked"))).toThrow();
  });

  it("accepts swapped create flags and a pinned verify digest", () => {
    const source = fixture();
    const snapshot = join(dirname(source.root), "swapped-flags");
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);
    const created = success(
      run("create", source.root, snapshot, "--owner-gid", gid, "--owner-uid", uid),
    );
    expect(
      success(run("verify", snapshot, "--manifest-sha256", created.manifestSha256)),
    ).toMatchObject({
      operation: "verify",
      manifestSha256: created.manifestSha256,
      treeSha256: created.treeSha256,
    });
    rejected(
      run("verify", snapshot, "--manifest-sha256", "0".repeat(64)),
      "manifest_digest_mismatch",
    );
  });

  it("validates all create grammar, ownership, and path syntax before filesystem I/O", () => {
    const base = scratch();
    const missing = join(base, "missing-source");
    const target = join(base, "new-snapshot");
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);
    const invalidArguments: string[][] = [
      ["create", missing, target],
      ["create", missing, target, "--owner-uid", uid],
      ["create", missing, target, "--owner-uid", uid, "--owner-uid", uid],
      ["create", missing, target, "--owner-uid", uid, "--unknown", gid],
      ["create", missing, target, uid, gid],
      ["create", missing, target, "--owner-uid", uid, "--owner-gid"],
    ];
    for (const arguments_ of invalidArguments)
      rejected(run(...arguments_), "invalid_arguments");
    for (const owner of ["-1", "01", "4294967295", "9007199254740992"]) {
      rejected(
        run("create", missing, target, "--owner-uid", owner, "--owner-gid", gid),
        "ownership_invalid",
      );
    }
    rejected(
      run("create", missing, "relative-target", "--owner-uid", uid, "--owner-gid", gid),
      "unsafe_path",
    );
    rejected(
      run("create", "relative-source", target, "--owner-uid", uid, "--owner-gid", gid),
      "unsafe_path",
    );
    expect(() => lstatSync(target)).toThrow();
    noPartial(base);
  });

  it("validates verify grammar and digest before touching a missing snapshot", () => {
    const missing = join(scratch(), "missing-snapshot");
    for (const arguments_ of [
      ["verify", missing, "--manifest-sha256"],
      ["verify", missing, "--unknown", "a".repeat(64)],
      [
        "verify",
        missing,
        "--manifest-sha256",
        "a".repeat(64),
        "--manifest-sha256",
        "a".repeat(64),
      ],
      ["verify", missing, "a".repeat(64)],
    ]) {
      rejected(run(...arguments_), "invalid_arguments");
    }
    rejected(
      run("verify", missing, "--manifest-sha256", "not-a-digest"),
      "manifest_digest_invalid",
    );
    rejected(run("verify", "relative-snapshot"), "unsafe_path");
  });

  it("rejects a snapshot target nested under the live source before creating it", () => {
    const source = fixture();
    const target = join(source.root, "nested-snapshot");
    rejected(runCreate(source.root, target), "unsafe_path");
    expect(() => lstatSync(target)).toThrow();
    noPartial(source.root);
  });

  it("fails closed on a noncanonical or schema-invalid manifest", () => {
    const source = fixture();
    const { path: snapshot } = createSnapshot(source);
    const manifest = JSON.parse(
      readFileSync(join(snapshot, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    manifest.unexpected = true;
    rewriteManifest(snapshot, canonicalJson(manifest));
    rejected(run("verify", snapshot), "manifest_invalid");

    const { unexpected: _unexpected, ...validManifest } = manifest;
    const noncanonical = `${JSON.stringify(validManifest, null, 2)}\n`;
    rewriteManifest(snapshot, noncanonical);
    rejected(run("verify", snapshot), "manifest_invalid");
  });

  it("rejects invalid UTF-8 in the manifest even with matching control hashes", () => {
    const source = fixture();
    const { path: snapshot } = createSnapshot(source);
    rewriteManifest(snapshot, Buffer.from([0xff, 0xfe, 0x7b, 0x7d, 0x0a]));
    rejected(run("verify", snapshot), "manifest_invalid");
  });

  it("detects control, data, extra-entry, symlink, and hardlink corruption", () => {
    const control = createSnapshot(fixture(), "control-corrupt").path;
    chmodSync(control, 0o700);
    chmodSync(join(control, "manifest.sha256"), 0o600);
    writeFileSync(join(control, "manifest.sha256"), `${"0".repeat(64)}\n`);
    chmodSync(join(control, "manifest.sha256"), 0o400);
    chmodSync(control, 0o500);
    rejected(run("verify", control), "snapshot_incomplete");

    const data = createSnapshot(fixture(), "data-corrupt").path;
    chmodSync(data, 0o700);
    chmodSync(join(data, "data"), 0o700);
    chmodSync(join(data, "data", "opaque.bin"), 0o600);
    writeFileSync(join(data, "data", "opaque.bin"), Buffer.from([1, 2, 3, 4, 5]));
    chmodSync(join(data, "data", "opaque.bin"), 0o400);
    chmodSync(join(data, "data"), 0o500);
    chmodSync(data, 0o500);
    rejected(run("verify", data), "snapshot_data_mismatch");

    const extra = createSnapshot(fixture(), "extra-corrupt").path;
    chmodSync(extra, 0o700);
    file(join(extra, "extra"), "extra", 0o400);
    chmodSync(extra, 0o500);
    rejected(run("verify", extra), "snapshot_extra_entry");

    const linked = createSnapshot(fixture(), "link-corrupt").path;
    chmodSync(linked, 0o700);
    chmodSync(join(linked, "data"), 0o700);
    symlinkSync(join(linked, "data", "opaque.bin"), join(linked, "data", "linked"));
    chmodSync(join(linked, "data"), 0o500);
    chmodSync(linked, 0o500);
    rejected(run("verify", linked), "snapshot_invalid");

    const hardlinked = createSnapshot(fixture(), "hardlink-corrupt").path;
    chmodSync(hardlinked, 0o700);
    chmodSync(join(hardlinked, "data"), 0o700);
    linkSync(
      join(hardlinked, "data", "opaque.bin"),
      join(hardlinked, "data", "hardlinked"),
    );
    chmodSync(join(hardlinked, "data"), 0o500);
    chmodSync(hardlinked, 0o500);
    rejected(run("verify", hardlinked), "snapshot_invalid");
  });

  it("fails closed and removes partial output when bytes change during capture", async () => {
    const source = fixture();
    const large = join(source.root, "large.bin");
    file(large, Buffer.alloc(48 * 1024 * 1024, 0x41));
    const target = join(dirname(source.root), "raced-snapshot");
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);
    let marker = 0x42;
    const result = await runWhile(
      ["create", source.root, target, "--owner-uid", uid, "--owner-gid", gid],
      () => {
        writeFileSync(large, Buffer.alloc(4096, marker), { flag: "r+" });
        marker = marker === 0x42 ? 0x43 : 0x42;
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /^Hub state forensic snapshot failed: (tree_changed|filesystem_error)\n$/u,
    );
    expect(() => lstatSync(target)).toThrow();
    noPartial(dirname(target));
  }, 30_000);

  it("fails closed when a source ancestor is exchanged", async () => {
    const base = scratch();
    const liveParent = join(base, "live-parent");
    const heldParent = join(base, "held-parent");
    directory(liveParent);
    const source = fixture(liveParent);
    file(join(source.root, "large.bin"), Buffer.alloc(32 * 1024 * 1024, 0x41));
    const target = join(base, "ancestor-raced-snapshot");
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);
    let moved = false;
    const result = await runWhile(
      ["create", source.root, target, "--owner-uid", uid, "--owner-gid", gid],
      () => {
        if (moved) renameSync(heldParent, liveParent);
        else renameSync(liveParent, heldParent);
        moved = !moved;
      },
    );
    if (moved) renameSync(heldParent, liveParent);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(() => lstatSync(target)).toThrow();
    noPartial(base);
  }, 30_000);

  it("produces a stable tree hash after the source root is renamed", () => {
    const base = scratch();
    const first = fixture(base);
    const firstSnapshot = createSnapshot(first, "before-rename");
    const renamed = join(base, "renamed-state");
    renameSync(first.root, renamed);
    const second = { ...first, root: renamed };
    const secondSnapshot = createSnapshot(second, "after-rename");

    expect(secondSnapshot.summary.treeSha256).toBe(firstSnapshot.summary.treeSha256);
    expect(secondSnapshot.summary.manifestSha256).not.toBe(
      firstSnapshot.summary.manifestSha256,
    );
  });
});
