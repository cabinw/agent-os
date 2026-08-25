import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
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

const SCRIPT = resolve("deploy/hub/bin/tree-digest.mjs");
const scratchDirectories: string[] = [];

type Digest = {
  entryCount: number;
  fileCount: number;
  totalBytes: number;
  treeSha256: string;
};

type RunResult = ReturnType<typeof spawnSync>;

function scratch(): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-os-tree-digest-")));
  scratchDirectories.push(path);
  return path;
}

function directory(path: string, mode = 0o700): void {
  mkdirSync(path, { mode, recursive: true });
  chmodSync(path, mode);
}

function file(path: string, value: string | Buffer, mode = 0o600): void {
  directory(dirname(path));
  writeFileSync(path, value, { mode });
  chmodSync(path, mode);
}

function fixture(root = join(scratch(), "tree"), reverse = false): string {
  directory(root);
  const writes: Array<[string, string]> = [
    [join(root, "alpha.txt"), "alpha"],
    [join(root, "nested", "beta.txt"), "beta-value"],
    [join(root, "nested", "deeper", "gamma.txt"), "gamma"],
  ];
  for (const [path, value] of reverse ? writes.reverse() : writes) file(path, value);
  return root;
}

function run(...arguments_: string[]): RunResult {
  return spawnSync(process.execPath, [SCRIPT, ...arguments_], {
    encoding: "utf8",
    timeout: 15_000,
  });
}

function parse(result: RunResult): Digest {
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as Digest;
}

async function runWhile(root: string, mutate: () => void): Promise<RunResult> {
  const child = spawn(process.execPath, [SCRIPT, root], {
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
      // A rename may temporarily remove the target; the next iteration retries.
    }
  }, 0);
  const result = await new Promise<RunResult>((resolveResult) => {
    child.on("close", (status, signal) => {
      clearInterval(timer);
      resolveResult({
        error: undefined,
        output: [null, stdout, stderr],
        pid: child.pid ?? 0,
        signal,
        status,
        stderr,
        stdout,
      } as RunResult);
    });
  });
  return result;
}

afterEach(() => {
  for (const path of scratchDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("stable no-follow tree digest", () => {
  it("returns only the canonical fixed summary", () => {
    const root = fixture(join(scratch(), "opaque-root-marker"));
    const result = run(root);
    const digest = parse(result);

    expect(Object.keys(digest)).toEqual([
      "entryCount",
      "fileCount",
      "totalBytes",
      "treeSha256",
    ]);
    expect(digest).toMatchObject({ entryCount: 5, fileCount: 3, totalBytes: 20 });
    expect(digest.treeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.stdout).not.toContain(root);
    expect(result.stdout).not.toContain("opaque-root-marker");
  });

  it("is stable when the whole root is renamed", () => {
    const root = fixture();
    const before = parse(run(root));
    const renamed = join(dirname(root), "renamed-tree");
    renameSync(root, renamed);

    expect(parse(run(renamed))).toEqual(before);
  });

  it("uses canonical directory ordering instead of insertion order", () => {
    const first = fixture(join(scratch(), "first"));
    const second = fixture(join(scratch(), "second"), true);

    expect(parse(run(second)).treeSha256).toBe(parse(run(first)).treeSha256);
  });

  it("changes when file contents change without changing size", () => {
    const root = fixture();
    const before = parse(run(root)).treeSha256;
    file(join(root, "alpha.txt"), "ALPHA");

    expect(parse(run(root)).treeSha256).not.toBe(before);
  });

  it("changes when a file mode changes", () => {
    const root = fixture();
    const before = parse(run(root)).treeSha256;
    chmodSync(join(root, "alpha.txt"), 0o640);

    expect(parse(run(root)).treeSha256).not.toBe(before);
  });

  it("changes when a relative path changes", () => {
    const root = fixture();
    const before = parse(run(root)).treeSha256;
    renameSync(join(root, "alpha.txt"), join(root, "delta.txt"));

    expect(parse(run(root)).treeSha256).not.toBe(before);
  });

  it("changes when ownership changes if the test account can chown", () => {
    if ((process.getuid?.() ?? -1) !== 0) return;
    const root = fixture();
    const before = parse(run(root)).treeSha256;
    chownSync(join(root, "alpha.txt"), 1, 1);

    expect(parse(run(root)).treeSha256).not.toBe(before);
  });

  it("can normalize only owner metadata for a production-root audit", () => {
    const root = fixture();
    const normalized = parse(run("--canonical-root-owner", root));

    expect(normalized).toMatchObject({ entryCount: 5, fileCount: 3, totalBytes: 20 });
    expect(normalized.treeSha256).toMatch(/^[a-f0-9]{64}$/u);
    if ((process.getuid?.() ?? 0) !== 0 || (process.getgid?.() ?? 0) !== 0) {
      expect(normalized.treeSha256).not.toBe(parse(run(root)).treeSha256);
    }
  });

  it("validates canonical-owner grammar before touching a tree", () => {
    for (const arguments_ of [
      ["--canonical-root-owner"],
      ["--canonical-root-owner", "/missing", "extra"],
      ["--unknown", "/missing"],
    ]) {
      const result = run(...arguments_);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("tree digest failed: invalid_arguments\n");
    }
  });

  it("rejects an internal symbolic link", () => {
    const root = fixture();
    symlinkSync(join(root, "alpha.txt"), join(root, "link"));

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("tree digest failed: unsafe_tree\n");
  });

  it("rejects a symbolic-link root", () => {
    const root = fixture();
    const link = join(dirname(root), "tree-link");
    symlinkSync(root, link);

    const result = run(link);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("rejects multiply-linked regular files", () => {
    const root = fixture();
    linkSync(join(root, "alpha.txt"), join(root, "hardlink"));

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("tree digest failed: unsafe_tree\n");
  });

  it("rejects a FIFO without opening it", () => {
    const root = fixture();
    const fifo = join(root, "queue");
    const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    expect(created.status, created.stderr).toBe(0);

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("tree digest failed: unsafe_tree\n");
  });

  it("rejects a device as the root", () => {
    const result = run(realpathSync.native("/dev/null"));

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("/dev/null");
  });

  it("rejects a socket entry", async () => {
    const root = fixture();
    const socket = join(root, "listener.sock");
    const server = createServer();
    const listenError = await new Promise<NodeJS.ErrnoException | null>(
      (resolveListen) => {
        server.once("error", (error: NodeJS.ErrnoException) => resolveListen(error));
        server.listen(socket, () => resolveListen(null));
      },
    );
    if (listenError) {
      expect(listenError.code).toBe("EPERM");
      return;
    }
    expect(listenError).toBeNull();
    try {
      const result = run(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("tree digest failed: unsafe_tree\n");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      try {
        unlinkSync(socket);
      } catch {
        // Some platforms remove the socket entry when the server closes.
      }
    }
  });

  it("fails closed when file contents change during the two passes", async () => {
    const root = fixture();
    const target = join(root, "large.bin");
    file(target, Buffer.alloc(32 * 1024 * 1024, 0x41));
    let value = 0x42;

    const result = await runWhile(root, () => {
      const buffer = Buffer.alloc(4096, value);
      value = value === 0x42 ? 0x43 : 0x42;
      writeFileSync(target, buffer, { flag: "r+" });
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /^tree digest failed: (tree_changed|filesystem_error)\n$/u,
    );
  });

  it("fails closed when directory entries change during traversal", async () => {
    const root = fixture();
    file(join(root, "large.bin"), Buffer.alloc(32 * 1024 * 1024, 0x41));
    const moving = join(root, "moving");
    let present = false;

    const result = await runWhile(root, () => {
      if (present) unlinkSync(moving);
      else file(moving, "moving");
      present = !present;
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("fails closed when identical internal files exchange path identities", async () => {
    const root = fixture();
    file(join(root, "large.bin"), Buffer.alloc(32 * 1024 * 1024, 0x41));
    const target = join(root, "alpha.txt");
    const replacement = join(root, "alpha.replacement");
    const held = join(root, "alpha.held");
    file(replacement, "alpha");

    const result = await runWhile(root, () => {
      renameSync(target, held);
      renameSync(replacement, target);
      renameSync(held, replacement);
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("fails closed when an ancestor is exchanged", async () => {
    const parent = join(scratch(), "live");
    const held = join(dirname(parent), "held");
    const root = fixture(join(parent, "tree"));
    file(join(root, "large.bin"), Buffer.alloc(32 * 1024 * 1024, 0x41));
    let moved = false;

    const result = await runWhile(root, () => {
      if (moved) renameSync(held, parent);
      else renameSync(parent, held);
      moved = !moved;
    });
    if (moved) renameSync(held, parent);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("rejects missing, extra, relative, and non-canonical arguments", () => {
    const root = fixture();
    const cases = [run(), run(root, root), run("relative"), run(`${root}/.`)];

    for (const result of cases) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(
        /^tree digest failed: (invalid_arguments|unsafe_root)\n$/u,
      );
    }
  });

  it("never includes a rejected path or file contents in diagnostics", () => {
    const root = fixture(join(scratch(), "do-not-print-this-root"));
    const secret = "do-not-print-this-filename-or-content";
    symlinkSync(join(root, "alpha.txt"), join(root, secret));

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(root);
    expect(result.stderr).not.toContain(secret);
  });
});
