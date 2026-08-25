import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — deployment helpers are plain .mjs, not part of tsc --build
import {
  deletedDescriptorTargetWritesState,
  descriptorWritesState,
  hasWritableAccess,
  inspectStateOpenFiles,
  linuxDeviceIdentity,
  normalizeDescriptorTarget,
  parseCgroupEvents,
  parseFdinfoFlags,
  parseFdinfoIdentity,
  parseMountinfo,
  parseProcCgroup,
  parseProcStatStarttime,
  parseProcStatusUids,
  parseSharedMayWriteMappings,
  parseSharedWritableMappings,
  procCgroupContains,
  procDirectoryIdentityProjection,
  targetIsWithinState,
} from "../deploy/hub/bin/state-open-files.mjs";

const SCRIPT = resolve("deploy/hub/bin/state-open-files.mjs");
const NONCE = "state_open_files_test_nonce_1234567890";
const roots: string[] = [];

type Fixture = {
  cgroup: string;
  forbiddenCgroup: string;
  inspectorPid: string;
  proc: string;
  root: string;
  scope: string;
  serviceUid: bigint;
  state: string;
};

type CommandResult = ReturnType<typeof spawnSync>;

function privateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700, recursive: true });
  chmodSync(path, 0o700);
}

function privateFile(path: string, contents: string): void {
  privateDirectory(dirname(path));
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function makeFixture({ nested = false }: { nested?: boolean } = {}): Fixture {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "agent-os-state-open-files-")),
  );
  roots.push(root);
  chmodSync(root, 0o700);
  privateFile(join(root, ".agent-os-deploy-test-root"), NONCE);
  const scope = nested ? join(root, "scope") : root;
  privateDirectory(scope);
  const state = join(scope, "state");
  const proc = join(scope, "proc");
  const cgroup = join(scope, "cgroup");
  privateDirectory(state);
  privateDirectory(proc);
  privateDirectory(cgroup);
  privateFile(join(state, "events.jsonl"), "fixture\n");
  const fixture = {
    cgroup,
    forbiddenCgroup: "/system.slice/agent-os-hub.service",
    inspectorPid: "999",
    proc,
    root,
    scope,
    serviceUid: 1001n,
    state,
  };
  privateFile(
    join(cgroup, "system.slice", "agent-os-hub.service", "cgroup.events"),
    "populated 0\nfrozen 0\n",
  );
  ensureProcess(fixture, { pid: fixture.inspectorPid, uid: 0n });
  return fixture;
}

function procStat(pid: string, starttime: string, state = "S"): string {
  const fields = Array.from({ length: 20 }, () => "0");
  fields[0] = state;
  fields[19] = starttime;
  return `${pid} (fixture ${pid}) ${fields.join(" ")}\n`;
}

function mountinfo(fixture: Fixture, extra = ""): string {
  return `1 0 0:42 / ${fixture.root} rw - ext4 /dev/vda2 rw\n${extra}`;
}

type TaskOptions = {
  cgroup?: string;
  maps?: string;
  mountNamespace?: string;
  mountinfoExtra?: string;
  smaps?: string;
  starttime?: string;
  state?: string;
  tid: string;
  uid?: bigint;
};

function writeTaskFixture(
  fixture: Fixture,
  processRoot: string,
  {
    cgroup = "/system.slice/unrelated.service",
    maps = "",
    mountNamespace = "1",
    mountinfoExtra = "",
    smaps = "",
    starttime = "1000",
    state = "S",
    tid,
    uid = 1000n,
  }: TaskOptions,
): string {
  const taskRoot = join(processRoot, "task", tid);
  privateDirectory(join(taskRoot, "fd"));
  privateDirectory(join(taskRoot, "fdinfo"));
  privateFile(join(taskRoot, "stat"), procStat(tid, starttime, state));
  privateFile(
    join(taskRoot, "status"),
    `Name:\tfixture\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
  );
  privateFile(join(taskRoot, "cgroup"), `0::${cgroup}\n`);
  privateFile(join(taskRoot, "mountinfo"), mountinfo(fixture, mountinfoExtra));
  privateFile(join(taskRoot, "maps"), maps);
  privateFile(join(taskRoot, "smaps"), smaps);
  installTaskMountNamespace(fixture, taskRoot, mountNamespace);
  const contextRoot = join(fixture.root, "process-context", tid);
  const cwdTarget = join(contextRoot, "cwd");
  const rootTarget = join(contextRoot, "root");
  privateDirectory(cwdTarget);
  privateDirectory(rootTarget);
  const cwd = join(taskRoot, "cwd");
  const processRootLink = join(taskRoot, "root");
  if (!existsSync(cwd)) symlinkSync(cwdTarget, cwd);
  if (!existsSync(processRootLink)) symlinkSync(rootTarget, processRootLink);
  return taskRoot;
}

function installTaskMountNamespace(
  fixture: Fixture,
  taskRoot: string,
  namespace: string,
  generation = "stable",
): void {
  const namespaceDirectory = join(taskRoot, "ns");
  privateDirectory(namespaceDirectory);
  const backing = join(
    fixture.scope,
    "namespace-identities",
    `mnt-${namespace}-${generation}`,
  );
  if (!existsSync(backing)) privateFile(backing, "mount namespace\n");
  const targetName = `mnt:[${namespace}]`;
  const localTarget = join(namespaceDirectory, targetName);
  const link = join(namespaceDirectory, "mnt");
  if (existsSync(link)) unlinkSync(link);
  if (existsSync(localTarget)) unlinkSync(localTarget);
  linkSync(backing, localTarget);
  symlinkSync(targetName, link);
}

function ensureProcess(
  fixture: Fixture,
  {
    cgroup = "/system.slice/unrelated.service",
    maps = "",
    mountNamespace = "1",
    mountinfoExtra = "",
    pid = "101",
    smaps = "",
    starttime = "1000",
    state = "S",
    uid = 1000n,
  }: {
    cgroup?: string;
    maps?: string;
    mountNamespace?: string;
    mountinfoExtra?: string;
    pid?: string;
    smaps?: string;
    starttime?: string;
    state?: string;
    uid?: bigint;
  } = {},
): string {
  const processRoot = join(fixture.proc, pid);
  privateDirectory(join(processRoot, "task"));
  privateFile(join(processRoot, "stat"), procStat(pid, starttime, state));
  writeTaskFixture(fixture, processRoot, {
    cgroup,
    maps,
    mountNamespace,
    mountinfoExtra,
    smaps,
    starttime,
    state,
    tid: pid,
    uid,
  });
  return processRoot;
}

function ensureThread(
  fixture: Fixture,
  {
    pid = "101",
    ...options
  }: Omit<TaskOptions, "tid"> & {
    pid?: string;
    tid: string;
  },
): string {
  const processRoot = join(fixture.proc, pid);
  if (!existsSync(join(processRoot, "stat"))) ensureProcess(fixture, { pid });
  return writeTaskFixture(fixture, processRoot, options);
}

function addDescriptor(
  fixture: Fixture,
  {
    descriptor = "7",
    flags = "0100000",
    inode,
    mountId = "1",
    mountinfoExtra = "",
    pid = "101",
    target = join(fixture.state, "events.jsonl"),
    tid = pid,
  }: {
    descriptor?: string;
    flags?: string;
    inode?: number | bigint;
    mountId?: string;
    mountinfoExtra?: string;
    pid?: string;
    target?: string;
    tid?: string;
  } = {},
): { fdinfo: string; link: string } {
  const taskRoot =
    tid === pid
      ? join(ensureProcess(fixture, { mountinfoExtra, pid }), "task", tid)
      : ensureThread(fixture, { mountinfoExtra, pid, tid });
  const fd = join(taskRoot, "fd");
  const fdinfo = join(taskRoot, "fdinfo");
  const normalized = target.endsWith(" (deleted)")
    ? target.slice(0, -" (deleted)".length)
    : target;
  if (normalized.startsWith(fixture.root) && !existsSync(normalized)) {
    privateFile(normalized, "descriptor target\n");
  }
  if (target.startsWith(fixture.root) && !existsSync(target)) {
    privateFile(target, "descriptor target\n");
  }
  const link = join(fd, descriptor);
  symlinkSync(target, link);
  const info = join(fdinfo, descriptor);
  const descriptorInode =
    inode ?? (normalized.startsWith(fixture.root) ? lstatSync(normalized).ino : 2);
  privateFile(
    info,
    `pos:\t0\nflags:\t${flags}\nmnt_id:\t${mountId}\nino:\t${descriptorInode}\n`,
  );
  return { fdinfo: info, link };
}

function addCgroup(fixture: Fixture, contents: string, pid = "101"): string {
  ensureProcess(fixture, { pid });
  const path = join(fixture.proc, pid, "task", pid, "cgroup");
  privateFile(path, contents);
  return path;
}

function validEnvironment(root: string): Record<string, string> {
  return {
    AGENT_OS_DEPLOY_TEST_MODE: "1",
    AGENT_OS_DEPLOY_TEST_NONCE: NONCE,
    AGENT_OS_DEPLOY_TEST_ROOT: root,
  };
}

function fakeMountNamespaceIdentity(namespace = "1", inode = 1n) {
  return Object.freeze({
    namespaceIdentity: Object.freeze({
      dev: 1n,
      fileType: 0o100000n,
      ino: inode,
    }),
    target: `mnt:[${namespace}]`,
  });
}

function sameMountNamespaceArguments() {
  const identity = fakeMountNamespaceIdentity();
  return Object.freeze({
    inspectorMountNamespaceIdentity: identity,
    taskMountNamespaceIdentity: identity,
  });
}

function run(
  fixture: Fixture,
  {
    envOverrides = {},
    forbiddenCgroup,
    proc = fixture.proc,
    serviceUid,
    state = fixture.state,
    unitInactiveProof,
  }: {
    envOverrides?: Record<string, string | undefined>;
    forbiddenCgroup?: string;
    proc?: string;
    serviceUid?: string | null;
    state?: string;
    unitInactiveProof?: string;
  } = {},
): CommandResult {
  const env = { ...process.env };
  for (const name of [
    "AGENT_OS_DEPLOY_TEST_MODE",
    "AGENT_OS_DEPLOY_TEST_NONCE",
    "AGENT_OS_DEPLOY_TEST_ROOT",
  ]) {
    delete env[name];
  }
  Object.assign(env, validEnvironment(fixture.root));
  for (const [name, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const arguments_ = [SCRIPT, state];
  arguments_.push("--forbidden-cgroup", forbiddenCgroup ?? fixture.forbiddenCgroup);
  const selectedServiceUid =
    serviceUid === undefined ? fixture.serviceUid.toString() : serviceUid;
  if (selectedServiceUid !== null) {
    arguments_.push("--service-uid", selectedServiceUid);
  }
  if (unitInactiveProof !== undefined) {
    arguments_.push("--unit-inactive-proof", unitInactiveProof);
  }
  arguments_.push(
    "--proc-root",
    proc,
    "--cgroup-root",
    fixture.cgroup,
    "--inspector-pid",
    fixture.inspectorPid,
  );
  return spawnSync(process.execPath, arguments_, {
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
}

function expectedJson(
  writableDescriptorDetected: boolean,
  forbiddenCgroupMemberDetected = false,
  ok = !writableDescriptorDetected && !forbiddenCgroupMemberDetected,
  overrides: Record<string, boolean> = {},
) {
  return {
    aliasInspectionComplete: true,
    cgroupDirectoryAbsent: false,
    cgroupPopulatedDetected: false,
    directoryDescriptorDetected: false,
    forbiddenCgroupMemberDetected,
    gate: "observable-reference",
    inspectionComplete: true,
    ok,
    processRootDetected: false,
    scanCount: 2,
    serviceUidProcessDetected: false,
    sharedWritableMappingDetected: false,
    workingDirectoryDetected: false,
    writableDescriptorDetected,
    ...overrides,
  };
}

function expectInspectionUnavailable(
  result: CommandResult,
  fixture: Fixture,
  {
    aliasInspectionComplete = true,
    reason = "inspection unavailable",
  }: { aliasInspectionComplete?: boolean; reason?: string } = {},
): void {
  expect(result.status).toBe(1);
  expect(result.stderr).toBe(`Hub state observable-reference gate failed: ${reason}\n`);
  expect(JSON.parse(result.stdout.toString())).toEqual(
    expectedJson(false, false, false, {
      aliasInspectionComplete,
      inspectionComplete: false,
    }),
  );
  expect(result.stdout).not.toContain(fixture.root);
  expect(result.stderr).not.toContain(fixture.root);
  expect(result.stdout).not.toContain("101");
  expect(result.stderr).not.toContain("101");
}

function withDeployTestEnvironment<T>(root: string, callback: () => T): T {
  const names = [
    "AGENT_OS_DEPLOY_TEST_MODE",
    "AGENT_OS_DEPLOY_TEST_NONCE",
    "AGENT_OS_DEPLOY_TEST_ROOT",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, validEnvironment(root));
  try {
    return callback();
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Hub state observable-reference pure checks", () => {
  it("strictly parses octal access flags", () => {
    expect(parseFdinfoFlags("pos:\t0\nflags:\t0100000\n")).toBe(0o100000n);
    expect(hasWritableAccess(parseFdinfoFlags("flags:\t0100000\n"))).toBe(false);
    expect(hasWritableAccess(parseFdinfoFlags("flags:\t0100001\n"))).toBe(true);
    expect(hasWritableAccess(parseFdinfoFlags("flags:\t0100002\n"))).toBe(true);

    for (const invalid of [
      "flags:\t2\n",
      "flags:\t0100008\n",
      "flags: 0100002\n",
      "flags:\t0100002\nflags:\t0100002\n",
      "flags:\t0100003\n",
    ]) {
      expect(() => hasWritableAccess(parseFdinfoFlags(invalid))).toThrow();
    }
  });

  it("normalizes deleted targets before applying the state boundary", () => {
    const state = "/var/lib/agent-os";
    const target = `${state}/events.jsonl (deleted)`;
    expect(normalizeDescriptorTarget(target)).toBe(`${state}/events.jsonl`);
    expect(targetIsWithinState(target, state)).toBe(true);
    expect(targetIsWithinState("/var/lib/agent-os-other/events.jsonl", state)).toBe(
      false,
    );
    expect(
      descriptorWritesState({
        fdinfo: "flags:\t0100002\n",
        stateRoot: state,
        target,
      }),
    ).toBe(true);
  });

  it("strictly parses v1 and v2 cgroup membership paths", () => {
    const contents =
      "0::/system.slice/agent-os-hub.service\n7:name=systemd:/legacy.slice/job.service\n";
    expect(parseProcCgroup(contents)).toEqual([
      "/system.slice/agent-os-hub.service",
      "/legacy.slice/job.service",
    ]);
    expect(procCgroupContains(contents, "/system.slice/agent-os-hub.service")).toBe(true);
    expect(procCgroupContains(contents, "/system.slice/other.service")).toBe(false);
    expect(() => parseProcCgroup("0:/missing-field\n")).toThrow();
    expect(() => parseProcCgroup("0::/duplicated\n0::/again\n")).toThrow();
  });

  it("parses stable process identity, descriptor identity and cgroup evidence", () => {
    expect(parseProcStatStarttime(procStat("101", "987654"), "101")).toBe("987654");
    expect(() => parseProcStatStarttime(procStat("101", "987654", "?"), "101")).toThrow();
    expect(parseProcStatusUids("Name:\tfixture\nUid:\t1001\t1001\t1001\t1001\n")).toEqual(
      [1001n, 1001n, 1001n, 1001n],
    );
    expect(() =>
      parseProcStatusUids("Name:\tfixture\nUid:\t4294967296\t1001\t1001\t1001\n"),
    ).toThrow();
    expect(
      parseFdinfoIdentity("pos:\t0\nflags:\t0100002\nmnt_id:\t7\nino:\t9\n"),
    ).toEqual({ flags: 0o100002n, inode: 9n, mountId: "7" });
    expect(parseCgroupEvents("populated 0\nfrozen 0\n")).toEqual({
      populated: 0n,
    });
    expect(() => parseCgroupEvents("frozen 0\n")).toThrow();
    expect(() => parseCgroupEvents("populated 2\n")).toThrow();
  });

  it("projects proc directory reuse identity without display owner or permissions", () => {
    const original = procDirectoryIdentityProjection({
      dev: 42n,
      gid: 1000n,
      ino: 7n,
      mode: 0o040700n,
      uid: 1000n,
    });
    const displayChanged = procDirectoryIdentityProjection({
      dev: 42n,
      gid: 0n,
      ino: 7n,
      mode: 0o040555n,
      uid: 0n,
    });

    expect(displayChanged).toEqual(original);
    expect(
      procDirectoryIdentityProjection({
        dev: 42n,
        gid: 0n,
        ino: 7n,
        mode: 0o100555n,
        uid: 0n,
      }),
    ).not.toEqual(original);
  });

  it("maps mount namespaces and shared writable mappings by device and inode", () => {
    expect(
      parseMountinfo(
        "1 0 0:42 / / rw - tmpfs fixture rw\n2 1 8:1 /state /alias rw - ext4 /dev/vda1 rw\n",
      ),
    ).toEqual([
      {
        device: "0:42",
        filesystemType: "tmpfs",
        mountId: "1",
        mountPoint: "/",
        parentId: "0",
        readWrite: true,
        root: "/",
        rootIsCanonicalAbsolute: true,
      },
      {
        device: "8:1",
        filesystemType: "ext4",
        mountId: "2",
        mountPoint: "/alias",
        parentId: "1",
        readWrite: true,
        root: "/state",
        rootIsCanonicalAbsolute: true,
      },
    ]);
    expect(
      parseSharedWritableMappings(
        "1000-2000 rw-s 00000000 00:2a 42 /alias/events.jsonl\n2000-3000 rw-p 00000000 00:2a 42 /private\n",
      ),
    ).toEqual([{ device: "0:42", inode: 42n }]);
    expect(
      parseSharedMayWriteMappings(
        "1000-2000 r--s 00000000 00:2a 42 /alias/events.jsonl\nSize: 4 kB\nVmFlags: rd sh mr mw me ms\n2000-3000 ---s 00000000 00:2a 43 /alias/ledger.json\nSize: 4 kB\nVmFlags: sh mr mw me ms\n",
      ),
    ).toEqual([
      { device: "0:42", inode: 42n },
      { device: "0:42", inode: 43n },
    ]);
    expect(() =>
      parseSharedWritableMappings(
        "1000-2000 rw-z 00000000 00:2a 42 /alias/events.jsonl\n",
      ),
    ).toThrow();
    expect(() =>
      parseSharedMayWriteMappings(
        "1000-2000 r--s 00000000 00:2a 42 /alias/events.jsonl\nSize: 4 kB\n",
      ),
    ).toThrow();
  });

  it("retains an unrelated opaque mount root without treating it as a path", () => {
    const mounts = parseMountinfo(
      "1 0 0:42 / / rw - ext4 /dev/vda2 rw\n" +
        "260 1 0:4 mnt:[4026532223] /run/snapd/ns/lxd.mnt rw - nsfs nsfs rw\n",
    );

    expect(mounts[1]).toMatchObject({
      filesystemType: "nsfs",
      mountPoint: "/run/snapd/ns/lxd.mnt",
      root: "mnt:[4026532223]",
      rootIsCanonicalAbsolute: false,
    });
    expect(() =>
      deletedDescriptorTargetWritesState({
        ...sameMountNamespaceArguments(),
        descriptorMount: mounts[1],
        nlink: 0n,
        readerMountEntries: mounts,
        stateFilesystemDevice: "0:4",
        stateFilesystemRoot: "/state",
        target: "/run/snapd/ns/lxd.mnt/#1 (deleted)",
      }),
    ).toThrowError("alias_inspection_unavailable");
  });

  it("accepts a self-parent namespace root but rejects a visible foreign parent", () => {
    const selfParent = parseMountinfo("1 1 0:42 / / rw - ext4 /dev/vda2 rw\n");
    expect(
      deletedDescriptorTargetWritesState({
        ...sameMountNamespaceArguments(),
        descriptorMount: selfParent[0],
        nlink: 0n,
        readerMountEntries: selfParent,
        stateFilesystemDevice: "0:42",
        stateFilesystemRoot: "/",
        target: "/#1 (deleted)",
      }),
    ).toBe(true);

    const foreignParent = parseMountinfo(
      "1 2 0:42 / / rw - ext4 /dev/vda2 rw\n" +
        "2 2 0:43 /other /elsewhere rw - ext4 /dev/vda3 rw\n",
    );
    expect(() =>
      deletedDescriptorTargetWritesState({
        ...sameMountNamespaceArguments(),
        descriptorMount: foreignParent[0],
        nlink: 0n,
        readerMountEntries: foreignParent,
        stateFilesystemDevice: "0:42",
        stateFilesystemRoot: "/",
        target: "/#1 (deleted)",
      }),
    ).toThrowError("alias_inspection_unavailable");
  });

  it.each([
    ["different-device nested mount", "0:43", "/"],
    ["same-device bind-root nested mount", "0:42", "/other-root"],
  ])("rejects a %s in the state tree", (_label, device, root) => {
    const fixture = makeFixture();
    const nestedMount = `2 1 ${device} ${root} ${fixture.state}/events.jsonl rw - tmpfs fixture rw\n`;
    privateFile(
      join(fixture.proc, fixture.inspectorPid, "task", fixture.inspectorPid, "mountinfo"),
      mountinfo(fixture, nestedMount),
    );

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrowError("state_root_cross_mount");
  });

  it("rejects stacked mounts at a state entry", () => {
    const fixture = makeFixture();
    const mountPoint = `${fixture.state}/events.jsonl`;
    privateFile(
      join(fixture.proc, fixture.inspectorPid, "task", fixture.inspectorPid, "mountinfo"),
      mountinfo(
        fixture,
        `2 1 0:42 /first ${mountPoint} rw - tmpfs fixture rw\n` +
          `3 1 0:42 /second ${mountPoint} rw - tmpfs fixture rw\n`,
      ),
    );

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrowError("state_root_cross_mount");
  });

  it("maps a replaced deleted/O_TMPFILE inode only through its nlink-zero fd mount", () => {
    const mounts = parseMountinfo(
      "1 0 0:42 / / rw - tmpfs fixture rw\n" +
        "2 1 0:42 /state /alias rw - tmpfs fixture rw\n" +
        "3 1 0:43 /state /same-name rw - tmpfs other rw\n",
    );
    const evidence = {
      nlink: 0n,
      stateFilesystemDevice: "0:42",
      stateFilesystemRoot: "/state",
      target: "/alias/#12345 (deleted)",
    };
    const liveIdentity = parseFdinfoIdentity("flags:\t0100002\nmnt_id:\t2\nino:\t42\n");
    const deletedIdentity = parseFdinfoIdentity(
      "flags:\t022000002\nmnt_id:\t2\nino:\t99\n",
    );
    expect(deletedIdentity.inode).not.toBe(liveIdentity.inode);
    expect(
      deletedDescriptorTargetWritesState({
        ...evidence,
        ...sameMountNamespaceArguments(),
        descriptorMount: mounts[1],
        readerMountEntries: mounts,
      }),
    ).toBe(true);
    expect(
      deletedDescriptorTargetWritesState({
        ...evidence,
        ...sameMountNamespaceArguments(),
        descriptorMount: mounts[1],
        nlink: 1n,
        readerMountEntries: mounts,
      }),
    ).toBe(false);
    expect(
      deletedDescriptorTargetWritesState({
        ...evidence,
        ...sameMountNamespaceArguments(),
        descriptorMount: mounts[2],
        readerMountEntries: mounts,
        target: "/same-name/#12345 (deleted)",
      }),
    ).toBe(false);
  });

  it("maps deleted descriptor text in the inspector namespace", () => {
    const targetMounts = parseMountinfo(
      "1 0 0:42 / / rw - tmpfs fixture rw\n" +
        "2 1 0:42 /state /target-alias rw - tmpfs fixture rw\n",
    );
    const readerMounts = parseMountinfo(
      "1 0 0:42 / / rw - tmpfs fixture rw\n" +
        "2 1 0:42 /state /reader-alias rw - tmpfs fixture rw\n",
    );

    expect(
      deletedDescriptorTargetWritesState({
        ...sameMountNamespaceArguments(),
        descriptorMount: targetMounts[1],
        nlink: 0n,
        readerMountEntries: readerMounts,
        stateFilesystemDevice: "0:42",
        stateFilesystemRoot: "/state",
        target: "/reader-alias/#12345 (deleted)",
      }),
    ).toBe(true);
    expect(() =>
      deletedDescriptorTargetWritesState({
        ...sameMountNamespaceArguments(),
        descriptorMount: targetMounts[1],
        nlink: 0n,
        readerMountEntries: readerMounts,
        stateFilesystemDevice: "0:42",
        stateFilesystemRoot: "/state",
        target: "reader-alias/#12345 (deleted)",
      }),
    ).toThrowError("alias_inspection_unavailable");

    expect(() =>
      deletedDescriptorTargetWritesState({
        descriptorMount: targetMounts[1],
        inspectorMountNamespaceIdentity: fakeMountNamespaceIdentity("1", 1n),
        nlink: 0n,
        readerMountEntries: readerMounts,
        stateFilesystemDevice: "0:42",
        stateFilesystemRoot: "/state",
        target: "/reader-alias/#12345 (deleted)",
        taskMountNamespaceIdentity: fakeMountNamespaceIdentity("2", 2n),
      }),
    ).toThrowError("alias_inspection_unavailable");
  });

  it.each([
    ["missing inspector mount object", "1 0 0:42 / / rw - tmpfs fixture rw\n"],
    [
      "different filesystem root",
      "1 0 0:42 / / rw - tmpfs fixture rw\n2 1 0:42 /other /reader-alias rw - tmpfs fixture rw\n",
    ],
    [
      "different filesystem type",
      "1 0 0:42 / / rw - tmpfs fixture rw\n2 1 0:42 /state /reader-alias rw - ext4 fixture rw\n",
    ],
    [
      "read-only mount object",
      "1 0 0:42 / / rw - tmpfs fixture rw\n2 1 0:42 /state /reader-alias ro - tmpfs fixture ro\n",
    ],
  ])("rejects a deleted descriptor with %s", (_label, readerMountinfo) => {
    const descriptorMount = parseMountinfo(
      "1 0 0:42 / / rw - tmpfs fixture rw\n" +
        "2 1 0:42 /state /target-alias rw - tmpfs fixture rw\n",
    )[1];

    expect(() =>
      deletedDescriptorTargetWritesState({
        ...sameMountNamespaceArguments(),
        descriptorMount,
        nlink: 0n,
        readerMountEntries: parseMountinfo(readerMountinfo),
        stateFilesystemDevice: "0:42",
        stateFilesystemRoot: "/state",
        target: "/reader-alias/#12345 (deleted)",
      }),
    ).toThrowError("alias_inspection_unavailable");
  });

  it.each([
    [
      "has no reader mount candidate",
      "20 0 0:42 /state /reader-only rw - tmpfs fixture rw\n",
    ],
    ["resolves to another device", "20 0 0:43 / / rw - tmpfs other rw\n"],
  ])("fails closed when deleted descriptor text %s", (_label, readerMountinfo) => {
    const targetMount = parseMountinfo(
      "20 0 0:42 /state /target-root rw - tmpfs fixture rw\n",
    )[0];

    expect(() =>
      deletedDescriptorTargetWritesState({
        ...sameMountNamespaceArguments(),
        descriptorMount: targetMount,
        nlink: 0n,
        readerMountEntries: parseMountinfo(readerMountinfo),
        stateFilesystemDevice: "0:42",
        stateFilesystemRoot: "/state",
        target: "/unseen/#12345 (deleted)",
      }),
    ).toThrowError("alias_inspection_unavailable");
  });

  it.each(["child-before-cover", "cover-before-child"])(
    "rejects hidden descendant mounts beneath a stacked ancestor (%s)",
    (order) => {
      const child = "2 1 0:42 /state /mnt/state rw - tmpfs fixture rw\n";
      const cover = "3 1 0:42 /cover /mnt rw - tmpfs fixture rw\n";
      const readerMounts = parseMountinfo(
        `1 0 0:42 / / rw - tmpfs fixture rw\n${
          order === "child-before-cover" ? `${child}${cover}` : `${cover}${child}`
        }`,
      );

      expect(() =>
        deletedDescriptorTargetWritesState({
          ...sameMountNamespaceArguments(),
          descriptorMount: readerMounts.find(({ mountId }) => mountId === "2"),
          nlink: 0n,
          readerMountEntries: readerMounts,
          stateFilesystemDevice: "0:42",
          stateFilesystemRoot: "/state",
          target: "/mnt/state/#12345 (deleted)",
        }),
      ).toThrowError("alias_inspection_unavailable");
    },
  );

  it("accepts a descendant mounted below the currently visible parent", () => {
    const mounts = parseMountinfo(
      "1 0 0:42 / / rw - tmpfs fixture rw\n" +
        "3 1 0:42 /cover /mnt rw - tmpfs fixture rw\n" +
        "2 3 0:42 /state /mnt/state rw - tmpfs fixture rw\n",
    );

    expect(
      deletedDescriptorTargetWritesState({
        ...sameMountNamespaceArguments(),
        descriptorMount: mounts[2],
        nlink: 0n,
        readerMountEntries: mounts,
        stateFilesystemDevice: "0:42",
        stateFilesystemRoot: "/state",
        target: "/mnt/state/#12345 (deleted)",
      }),
    ).toBe(true);
  });

  it.each([
    [
      "missing parent",
      "1 0 0:42 / / rw - tmpfs fixture rw\n2 9 0:42 /state /mnt/state rw - tmpfs fixture rw\n",
    ],
    [
      "parent cycle",
      "1 0 0:42 / / rw - tmpfs fixture rw\n2 3 0:42 /cover /mnt rw - tmpfs fixture rw\n3 2 0:42 /state /mnt/state rw - tmpfs fixture rw\n",
    ],
    [
      "non-ancestor parent",
      "1 0 0:42 / / rw - tmpfs fixture rw\n4 1 0:42 /other /elsewhere rw - tmpfs fixture rw\n2 4 0:42 /state /mnt/state rw - tmpfs fixture rw\n",
    ],
  ])("rejects a mount graph with %s", (_label, contents) => {
    const mounts = parseMountinfo(contents);
    expect(() =>
      deletedDescriptorTargetWritesState({
        ...sameMountNamespaceArguments(),
        descriptorMount: mounts.find(({ mountId }) => mountId === "2"),
        nlink: 0n,
        readerMountEntries: mounts,
        stateFilesystemDevice: "0:42",
        stateFilesystemRoot: "/state",
        target: "/mnt/state/#12345 (deleted)",
      }),
    ).toThrowError("alias_inspection_unavailable");
  });
});

describe("Hub state observable-reference CLI", () => {
  it.each([
    ["read-only ext4", "ext4", "ro"],
    ["xfs", "xfs", "rw"],
    ["overlay", "overlay", "rw"],
    ["nfs", "nfs4", "rw"],
    ["fuse", "fuse.sshfs", "rw"],
    ["tmpfs", "tmpfs", "rw"],
  ])("rejects a %s state-root filesystem", (_label, filesystemType, access) => {
    const fixture = makeFixture();
    privateFile(
      join(fixture.proc, fixture.inspectorPid, "task", fixture.inspectorPid, "mountinfo"),
      `1 0 0:42 / ${fixture.root} ${access} - ${filesystemType} fixture ${access}\n`,
    );

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrowError("state_root_filesystem_unsupported");
  });

  it("ignores an opaque root on an unrelated nsfs mount", () => {
    const fixture = makeFixture();
    privateFile(
      join(fixture.proc, fixture.inspectorPid, "task", fixture.inspectorPid, "mountinfo"),
      mountinfo(
        fixture,
        "260 1 0:4 mnt:[4026532223] /run/snapd/ns/lxd.mnt rw - nsfs nsfs rw\n",
      ),
    );

    const result = run(fixture);
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual(expectedJson(false));
  });

  it("fails closed when an opaque mount root is needed for the state mapping", () => {
    const fixture = makeFixture();
    privateFile(
      join(fixture.proc, fixture.inspectorPid, "task", fixture.inspectorPid, "mountinfo"),
      `1 0 0:42 mnt:[4026532223] ${fixture.root} rw - ext4 /dev/vda2 rw\n`,
    );

    expectInspectionUnavailable(run(fixture), fixture, {
      aliasInspectionComplete: false,
      reason: "mount alias inspection unavailable",
    });
  });

  it("uses the locked state-chain leaf for production stat-device proof", () => {
    const fixture = makeFixture();
    const stateDevice = linuxDeviceIdentity(
      lstatSync(fixture.state, { bigint: true }).dev,
    );
    privateFile(
      join(fixture.proc, fixture.inspectorPid, "task", fixture.inspectorPid, "mountinfo"),
      `1 1 ${stateDevice} / ${fixture.root} rw - ext4 /dev/fixture rw\n`,
    );

    const result = inspectStateOpenFiles({
      cgroupRoot: fixture.cgroup,
      forbiddenCgroup: fixture.forbiddenCgroup,
      inspectorPid: fixture.inspectorPid,
      procRoot: fixture.proc,
      serviceUid: fixture.serviceUid,
      stateRoot: fixture.state,
      testOverride: false,
    });
    expect(result).toMatchObject({ inspectionComplete: true, ok: true, scanCount: 2 });
  });

  it("requires one bounded numeric service UID", () => {
    const missing = makeFixture();
    expectInspectionUnavailable(
      run(missing, {
        envOverrides: { AGENT_OS_SERVICE_UID: missing.serviceUid.toString() },
        serviceUid: null,
      }),
      missing,
    );

    const root = makeFixture();
    expectInspectionUnavailable(run(root, { serviceUid: "0" }), root);

    const overflow = makeFixture();
    expectInspectionUnavailable(run(overflow, { serviceUid: "4294967296" }), overflow);
  });

  it("passes read-only state descriptors after exactly two scans", () => {
    const fixture = makeFixture();
    addDescriptor(fixture, { flags: "0100000" });
    addDescriptor(fixture, {
      descriptor: "8",
      flags: "0100001",
      target: join(fixture.root, "outside.jsonl"),
    });

    const result = run(fixture);
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual(expectedJson(false));
    expect(result.stdout).not.toContain(fixture.root);
    expect(result.stdout).not.toContain("101");
  });

  it("accepts a stable empty mount projection for an unrelated task", () => {
    const fixture = makeFixture();
    ensureProcess(fixture);
    privateFile(join(fixture.proc, "101", "task", "101", "mountinfo"), "");

    const result = run(fixture);
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual(expectedJson(false));
  });

  it("still detects a live state descriptor with an empty task mount projection", () => {
    const fixture = makeFixture();
    const stateDevice = linuxDeviceIdentity(
      lstatSync(fixture.state, { bigint: true }).dev,
    );
    privateFile(
      join(fixture.proc, fixture.inspectorPid, "task", fixture.inspectorPid, "mountinfo"),
      `1 0 ${stateDevice} / ${fixture.root} rw - ext4 /dev/fixture rw\n`,
    );
    addDescriptor(fixture, { flags: "0100002" });
    privateFile(join(fixture.proc, "101", "task", "101", "mountinfo"), "");

    const result = run(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Hub state observable-reference gate failed: writable descriptor detected\n",
    );
    expect(JSON.parse(result.stdout.toString())).toEqual(expectedJson(true));
  });

  it("accepts a live external descriptor whose stale mount object is absent", () => {
    const fixture = makeFixture();
    const outside = join(fixture.root, "outside-stale-mount.jsonl");
    addDescriptor(fixture, {
      flags: "0100001",
      mountId: "999",
      target: outside,
    });

    const result = run(fixture);
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual(expectedJson(false));
  });

  it.each([
    ["write-only", "0100001", ""],
    ["read-write", "0100002", ""],
    ["deleted", "0100001", " (deleted)"],
  ])("rejects a %s descriptor without disclosing evidence", (_label, flags, suffix) => {
    const fixture = makeFixture();
    addDescriptor(fixture, {
      flags,
      target: `${join(fixture.state, "events.jsonl")}${suffix}`,
    });

    const result = run(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Hub state observable-reference gate failed: writable descriptor detected\n",
    );
    expect(JSON.parse(result.stdout.toString())).toEqual(expectedJson(true));
    expect(result.stdout).not.toContain(fixture.root);
    expect(result.stderr).not.toContain(fixture.root);
    expect(result.stdout).not.toContain("101");
    expect(result.stderr).not.toContain("101");
  });

  it.each([
    ["read-only directory", "0100000"],
    ["O_PATH", "010000000"],
  ])("rejects a %s descriptor into the protected tree", (_label, flags) => {
    const fixture = makeFixture();
    addDescriptor(fixture, { flags, target: fixture.state });

    const result = run(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Hub state observable-reference gate failed: state directory descriptor detected\n",
    );
    expect(JSON.parse(result.stdout.toString())).toEqual(
      expectedJson(false, false, false, { directoryDescriptorDetected: true }),
    );
  });

  it("detects a writable live bind-mount alias by device and inode", () => {
    const fixture = makeFixture();
    const liveInode = lstatSync(join(fixture.state, "events.jsonl")).ino;
    const alias = join(fixture.root, "alias");
    privateDirectory(alias);
    addDescriptor(fixture, {
      flags: "0100001",
      inode: liveInode,
      mountId: "2",
      mountinfoExtra: `2 1 0:42 /state ${alias} rw - tmpfs fixture rw\n`,
      target: join(alias, "events.jsonl"),
    });

    const result = run(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Hub state observable-reference gate failed: writable descriptor detected\n",
    );
    expect(JSON.parse(result.stdout.toString())).toEqual(expectedJson(true));
  });

  it("detects MAP_SHARED plus PROT_WRITE after the backing fd is closed", () => {
    const fixture = makeFixture();
    const inode = lstatSync(join(fixture.state, "events.jsonl")).ino;
    const mapping =
      `1000-2000 rw-s 00000000 00:2a ${inode} ` + `${fixture.state}/events.jsonl\n`;
    ensureProcess(fixture, {
      maps: mapping,
      smaps: `${mapping}Size: 4 kB\nVmFlags: rd wr sh mr mw me ms\n`,
    });

    const result = run(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Hub state observable-reference gate failed: shared writable mapping detected\n",
    );
    expect(JSON.parse(result.stdout.toString())).toEqual(
      expectedJson(false, false, false, { sharedWritableMappingDetected: true }),
    );
  });

  it.each(["r--s", "---s"])(
    "rejects a %s shared mapping that retains VmFlags may-write",
    (permissions) => {
      const fixture = makeFixture();
      const inode = lstatSync(join(fixture.state, "events.jsonl")).ino;
      const mapping =
        `1000-2000 ${permissions} 00000000 00:2a ${inode} ` +
        `${fixture.state}/events.jsonl\n`;
      ensureProcess(fixture, {
        maps: mapping,
        smaps: `${mapping}Size: 4 kB\nVmFlags: rd sh mr mw me ms\n`,
      });

      const result = run(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(
        "Hub state observable-reference gate failed: shared writable mapping detected\n",
      );
      expect(JSON.parse(result.stdout.toString())).toEqual(
        expectedJson(false, false, false, {
          sharedWritableMappingDetected: true,
        }),
      );
    },
  );

  it("requires both an empty v2 cgroup and no service-UID process", () => {
    const populated = makeFixture();
    privateFile(
      join(populated.cgroup, "system.slice", "agent-os-hub.service", "cgroup.events"),
      "populated 1\nfrozen 0\n",
    );
    const populatedResult = run(populated);
    expect(populatedResult.status).toBe(1);
    expect(populatedResult.stderr).toBe(
      "Hub state observable-reference gate failed: service cgroup is populated\n",
    );
    expect(JSON.parse(populatedResult.stdout.toString())).toEqual(
      expectedJson(false, false, false, { cgroupPopulatedDetected: true }),
    );

    const residual = makeFixture();
    ensureProcess(residual, { uid: residual.serviceUid });
    const residualResult = run(residual);
    expect(residualResult.status).toBe(1);
    expect(residualResult.stderr).toBe(
      "Hub state observable-reference gate failed: service uid process detected\n",
    );
    expect(JSON.parse(residualResult.stdout.toString())).toEqual(
      expectedJson(false, false, false, { serviceUidProcessDetected: true }),
    );
  });

  it("skips only a stable unrelated zombie whose task capabilities vanished", () => {
    const fixture = makeFixture();
    ensureProcess(fixture, { state: "Z" });
    const taskRoot = join(fixture.proc, "101", "task", "101");
    for (const name of ["fd", "fdinfo", "cwd", "root", "mountinfo", "maps", "smaps"]) {
      rmSync(join(taskRoot, name), { force: true, recursive: true });
    }

    const result = run(fixture);
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual(expectedJson(false));
  });

  it("still rejects a service-UID zombie without reading unavailable task links", () => {
    const fixture = makeFixture();
    ensureProcess(fixture, { state: "Z", uid: fixture.serviceUid });
    const taskRoot = join(fixture.proc, "101", "task", "101");
    for (const name of ["fd", "fdinfo", "cwd", "root", "mountinfo", "maps", "smaps"]) {
      rmSync(join(taskRoot, name), { force: true, recursive: true });
    }

    const result = run(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Hub state observable-reference gate failed: service uid process detected\n",
    );
    expect(JSON.parse(result.stdout.toString())).toEqual(
      expectedJson(false, false, false, { serviceUidProcessDetected: true }),
    );
  });

  it("fails closed when a zombie leader still has live worker TIDs", () => {
    const fixture = makeFixture();
    ensureProcess(fixture, { state: "Z" });
    const leaderTask = join(fixture.proc, "101", "task", "101");
    for (const name of ["fd", "fdinfo", "cwd", "root", "mountinfo", "maps", "smaps"]) {
      rmSync(join(leaderTask, name), { force: true, recursive: true });
    }
    addDescriptor(fixture, {
      flags: "0100001",
      pid: "101",
      tid: "102",
    });

    expectInspectionUnavailable(run(fixture), fixture);
  });

  it("fails closed when a zombie leader's task view is missing or inconsistent", () => {
    const missing = makeFixture();
    ensureProcess(missing, { state: "Z" });
    rmSync(join(missing.proc, "101", "task"), { recursive: true });
    expectInspectionUnavailable(run(missing), missing);

    const inconsistent = makeFixture();
    ensureProcess(inconsistent, { state: "Z" });
    privateFile(
      join(inconsistent.proc, "101", "task", "101", "stat"),
      procStat("101", "1000", "S"),
    );
    expectInspectionUnavailable(run(inconsistent), inconsistent);

    const leaderMissing = makeFixture();
    ensureProcess(leaderMissing);
    ensureThread(leaderMissing, { tid: "102" });
    rmSync(join(leaderMissing.proc, "101", "task", "101"), { recursive: true });
    expectInspectionUnavailable(run(leaderMissing), leaderMissing);
  });

  it("fails closed for a live task whose fd/cwd capability view is unavailable", () => {
    const fixture = makeFixture();
    ensureProcess(fixture);
    rmSync(join(fixture.proc, "101", "task", "101", "cwd"));
    expectInspectionUnavailable(run(fixture), fixture);
  });

  it("accepts a reclaimed service cgroup only with the fixed inactive proof", () => {
    const missingProof = makeFixture();
    rmSync(join(missingProof.cgroup, "system.slice", "agent-os-hub.service"), {
      recursive: true,
    });
    expectInspectionUnavailable(
      run(missingProof, {
        envOverrides: {
          AGENT_OS_UNIT_INACTIVE_PROOF: "inactive-mainpid0",
        },
      }),
      missingProof,
    );

    const proved = makeFixture();
    rmSync(join(proved.cgroup, "system.slice", "agent-os-hub.service"), {
      recursive: true,
    });
    const passed = run(proved, {
      unitInactiveProof: "inactive-mainpid0",
    });
    expect(passed.status, passed.stderr.toString()).toBe(0);
    expect(JSON.parse(passed.stdout.toString())).toEqual(
      expectedJson(false, false, true, { cgroupDirectoryAbsent: true }),
    );

    const invalid = makeFixture();
    expectInspectionUnavailable(run(invalid, { unitInactiveProof: "inactive" }), invalid);
  });

  it("rejects state cwd, process root, and immediate-parent dirfd aliases", () => {
    const cwdFixture = makeFixture();
    ensureProcess(cwdFixture);
    const cwdLink = join(cwdFixture.proc, "101", "task", "101", "cwd");
    unlinkSync(cwdLink);
    symlinkSync(cwdFixture.state, cwdLink);
    const cwdResult = run(cwdFixture);
    expect(cwdResult.status).toBe(1);
    expect(cwdResult.stderr).toBe(
      "Hub state observable-reference gate failed: working directory intersects state\n",
    );
    expect(JSON.parse(cwdResult.stdout.toString())).toEqual(
      expectedJson(false, false, false, { workingDirectoryDetected: true }),
    );

    const rootFixture = makeFixture();
    ensureProcess(rootFixture);
    const rootLink = join(rootFixture.proc, "101", "task", "101", "root");
    unlinkSync(rootLink);
    symlinkSync(rootFixture.state, rootLink);
    const rootResult = run(rootFixture);
    expect(rootResult.status).toBe(1);
    expect(rootResult.stderr).toBe(
      "Hub state observable-reference gate failed: process root intersects state\n",
    );
    expect(JSON.parse(rootResult.stdout.toString())).toEqual(
      expectedJson(false, false, false, { processRootDetected: true }),
    );

    const parentFixture = makeFixture();
    addDescriptor(parentFixture, {
      flags: "0100000",
      target: dirname(parentFixture.state),
    });
    const parentResult = run(parentFixture);
    expect(parentResult.status).toBe(1);
    expect(parentResult.stderr).toBe(
      "Hub state observable-reference gate failed: state directory descriptor detected\n",
    );
    expect(JSON.parse(parentResult.stdout.toString())).toEqual(
      expectedJson(false, false, false, { directoryDescriptorDetected: true }),
    );

    const parentCwdFixture = makeFixture();
    ensureProcess(parentCwdFixture);
    const parentCwdLink = join(parentCwdFixture.proc, "101", "task", "101", "cwd");
    unlinkSync(parentCwdLink);
    symlinkSync(dirname(parentCwdFixture.state), parentCwdLink);
    const parentCwdResult = run(parentCwdFixture);
    expect(parentCwdResult.status).toBe(1);
    expect(JSON.parse(parentCwdResult.stdout.toString())).toEqual(
      expectedJson(false, false, false, { workingDirectoryDetected: true }),
    );

    const parentRootFixture = makeFixture();
    ensureProcess(parentRootFixture);
    const parentRootLink = join(parentRootFixture.proc, "101", "task", "101", "root");
    unlinkSync(parentRootLink);
    symlinkSync(dirname(parentRootFixture.state), parentRootLink);
    const parentRootResult = run(parentRootFixture);
    expect(parentRootResult.status).toBe(1);
    expect(JSON.parse(parentRootResult.stdout.toString())).toEqual(
      expectedJson(false, false, false, { processRootDetected: true }),
    );
  });

  it("checks dangerous descriptors inherited by the inspector", () => {
    const fixture = makeFixture();
    addDescriptor(fixture, {
      flags: "0100001",
      pid: fixture.inspectorPid,
    });

    const result = run(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Hub state observable-reference gate failed: writable descriptor detected\n",
    );
    expect(JSON.parse(result.stdout.toString())).toEqual(expectedJson(true));
  });

  it("fails closed instead of claiming hard-link alias coverage", () => {
    const fixture = makeFixture();
    linkSync(
      join(fixture.state, "events.jsonl"),
      join(fixture.root, "events-hardlink.jsonl"),
    );

    expectInspectionUnavailable(run(fixture), fixture, {
      aliasInspectionComplete: false,
      reason: "mount alias inspection unavailable",
    });
  });

  it("fails closed for an ambiguous stacked mount over the state path", () => {
    const fixture = makeFixture();
    privateFile(
      join(fixture.proc, fixture.inspectorPid, "task", fixture.inspectorPid, "mountinfo"),
      `${mountinfo(fixture)}2 1 0:43 / ${fixture.root} rw - tmpfs stacked rw\n`,
    );

    expectInspectionUnavailable(run(fixture), fixture, {
      aliasInspectionComplete: false,
      reason: "mount alias inspection unavailable",
    });
  });

  it("fails closed when mount or mapping evidence is malformed", () => {
    const cases = [
      (fixture: Fixture) =>
        privateFile(
          join(
            fixture.proc,
            fixture.inspectorPid,
            "task",
            fixture.inspectorPid,
            "mountinfo",
          ),
          "not mountinfo\n",
        ),
      (fixture: Fixture) => {
        ensureProcess(fixture);
        privateFile(
          join(fixture.proc, "101", "task", "101", "mountinfo"),
          "not mountinfo\n",
        );
      },
      (fixture: Fixture) => {
        ensureProcess(fixture);
        privateFile(join(fixture.proc, "101", "task", "101", "maps"), "not maps\n");
      },
      (fixture: Fixture) => {
        const inode = lstatSync(join(fixture.state, "events.jsonl")).ino;
        ensureProcess(fixture, {
          maps:
            `1000-2000 r--s 00000000 00:2a ${inode} ` + `${fixture.state}/events.jsonl\n`,
          smaps: "",
        });
      },
    ];

    for (const corruptEvidence of cases) {
      const fixture = makeFixture();
      corruptEvidence(fixture);
      expectInspectionUnavailable(run(fixture), fixture, {
        aliasInspectionComplete: false,
        reason: "mount alias inspection unavailable",
      });
    }
  });

  it.each([
    ["exact", "/system.slice/agent-os-hub.service"],
    ["descendant", "/system.slice/agent-os-hub.service/worker.scope"],
  ])("rejects an %s forbidden-cgroup member without disclosing it", (_label, path) => {
    const fixture = makeFixture();
    addDescriptor(fixture, { flags: "0100000" });
    addCgroup(fixture, `0::${path}\n`);

    const result = run(fixture, {
      forbiddenCgroup: "/system.slice/agent-os-hub.service",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Hub state observable-reference gate failed: forbidden cgroup member detected\n",
    );
    expect(JSON.parse(result.stdout.toString())).toEqual(expectedJson(false, true));
    expect(result.stdout).not.toContain(fixture.root);
    expect(result.stderr).not.toContain(fixture.root);
    expect(result.stdout).not.toContain("101");
    expect(result.stderr).not.toContain("101");
    expect(result.stdout).not.toContain("system.slice");
    expect(result.stderr).not.toContain("system.slice");
  });

  it("passes an unrelated cgroup and fails closed for malformed membership", () => {
    const unrelated = makeFixture();
    addDescriptor(unrelated, { flags: "0100000" });
    addCgroup(unrelated, "0::/system.slice/unrelated.service\n");
    const passed = run(unrelated, {
      forbiddenCgroup: "/system.slice/agent-os-hub.service",
    });
    expect(passed.status, passed.stderr.toString()).toBe(0);
    expect(JSON.parse(passed.stdout.toString())).toEqual(expectedJson(false));

    const malformed = makeFixture();
    addDescriptor(malformed, { flags: "0100000" });
    addCgroup(malformed, "not-a-cgroup-record\n");
    expectInspectionUnavailable(
      run(malformed, {
        forbiddenCgroup: "/system.slice/agent-os-hub.service",
      }),
      malformed,
    );
  });

  it("fails closed for malformed fdinfo and inaccessible descriptor metadata", () => {
    const malformed = makeFixture();
    addDescriptor(malformed, { flags: "0100008" });
    expectInspectionUnavailable(run(malformed), malformed);

    const inaccessible = makeFixture();
    const descriptor = addDescriptor(inaccessible);
    chmodSync(descriptor.fdinfo, 0o000);
    expectInspectionUnavailable(run(inaccessible), inaccessible);

    const invalidTarget = makeFixture();
    const invalidDescriptor = addDescriptor(invalidTarget);
    unlinkSync(invalidDescriptor.link);
    symlinkSync(
      Buffer.concat([
        Buffer.from(`${invalidTarget.state}/invalid-`, "utf8"),
        Buffer.from([0xff]),
      ]),
      invalidDescriptor.link,
    );
    expectInspectionUnavailable(run(invalidTarget), invalidTarget);
  });

  it("rejects symbolic state and proc roots", () => {
    const stateFixture = makeFixture();
    const linkedState = join(stateFixture.root, "linked-state");
    symlinkSync(stateFixture.state, linkedState);
    expectInspectionUnavailable(run(stateFixture, { state: linkedState }), stateFixture);

    const procFixture = makeFixture();
    const linkedProc = join(procFixture.root, "linked-proc");
    symlinkSync(procFixture.proc, linkedProc);
    expectInspectionUnavailable(run(procFixture, { proc: linkedProc }), procFixture);
  });

  it("allows --proc-root only below a nonce-bound canonical test root", () => {
    const fixture = makeFixture();
    addDescriptor(fixture);

    expectInspectionUnavailable(
      run(fixture, { envOverrides: { AGENT_OS_DEPLOY_TEST_MODE: undefined } }),
      fixture,
    );

    chmodSync(join(fixture.root, ".agent-os-deploy-test-root"), 0o644);
    expectInspectionUnavailable(run(fixture), fixture);

    const outside = makeFixture();
    expectInspectionUnavailable(run(fixture, { state: outside.state }), fixture);
  });

  it("proves the excluded inspector is neither the service UID nor cgroup", () => {
    const serviceIdentity = makeFixture();
    ensureProcess(serviceIdentity, {
      pid: serviceIdentity.inspectorPid,
      uid: serviceIdentity.serviceUid,
    });
    expectInspectionUnavailable(run(serviceIdentity), serviceIdentity);

    const serviceCgroup = makeFixture();
    ensureProcess(serviceCgroup, {
      cgroup: serviceCgroup.forbiddenCgroup,
      pid: serviceCgroup.inspectorPid,
      uid: 0n,
    });
    expectInspectionUnavailable(run(serviceCgroup), serviceCgroup);
  });
});

describe("Hub state observable-reference race closure", () => {
  it.each(["f0", "t0", "f1", "t1"])(
    "rejects descriptor-number replacement after the internal %s observation",
    (faultStage) => {
      const fixture = makeFixture();
      const descriptor = addDescriptor(fixture, { flags: "0100002" });
      const outside = join(fixture.root, `outside-${faultStage}.jsonl`);
      privateFile(outside, "outside\n");
      const outsideInode = lstatSync(outside).ino;
      let replaced = false;

      expect(() =>
        withDeployTestEnvironment(fixture.root, () =>
          inspectStateOpenFiles({
            cgroupRoot: fixture.cgroup,
            forbiddenCgroup: fixture.forbiddenCgroup,
            inspectorPid: fixture.inspectorPid,
            onDescriptorEvidenceStage: (
              pid: string,
              tid: string,
              descriptorName: string,
              stage: string,
            ) => {
              if (
                pid !== "101" ||
                tid !== "101" ||
                descriptorName !== "7" ||
                stage !== faultStage ||
                replaced
              ) {
                return;
              }
              replaced = true;
              if (faultStage === "f0" || faultStage === "t0" || faultStage === "t1") {
                privateFile(
                  descriptor.fdinfo,
                  `pos:\t0\nflags:\t0100000\nmnt_id:\t1\nino:\t${
                    faultStage === "f0"
                      ? outsideInode
                      : lstatSync(join(fixture.state, "events.jsonl")).ino
                  }\n`,
                );
              }
              if (faultStage === "f0" || faultStage === "f1") {
                unlinkSync(descriptor.link);
                symlinkSync(outside, descriptor.link);
              }
            },
            procRoot: fixture.proc,
            serviceUid: fixture.serviceUid,
            stateRoot: fixture.state,
            testOverride: true,
          }),
        ),
      ).toThrowError("proc_unavailable");
      expect(replaced).toBe(true);
    },
  );

  it("rejects an observed descriptor ABA even when fdinfo returns to A", () => {
    const fixture = makeFixture();
    const descriptor = addDescriptor(fixture, { flags: "0100002" });
    const stateTarget = join(fixture.state, "events.jsonl");
    const outside = join(fixture.root, "outside-aba.jsonl");
    privateFile(outside, "outside\n");
    let swapped = false;
    let restored = false;

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          onDescriptorEvidenceStage: (
            pid: string,
            tid: string,
            descriptorName: string,
            stage: string,
          ) => {
            if (pid !== "101" || tid !== "101" || descriptorName !== "7") return;
            if (stage === "f0" && !swapped) {
              swapped = true;
              unlinkSync(descriptor.link);
              symlinkSync(outside, descriptor.link);
            } else if (stage === "t0" && swapped && !restored) {
              restored = true;
              unlinkSync(descriptor.link);
              symlinkSync(stateTarget, descriptor.link);
            }
          },
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrowError("proc_unavailable");
    expect(swapped).toBe(true);
    expect(restored).toBe(true);
  });

  it("rejects cross-device same-inode fdinfo and followed-target evidence", () => {
    const fixture = makeFixture();
    const descriptor = addDescriptor(fixture, { flags: "0100000" });
    const taskMountinfo = join(fixture.proc, "101", "task", "101", "mountinfo");
    const actualDevice = linuxDeviceIdentity(
      lstatSync(join(fixture.state, "events.jsonl"), { bigint: true }).dev,
    );
    const foreignDevice = actualDevice === "0:424242" ? "0:424243" : "0:424242";
    privateFile(
      taskMountinfo,
      `1 0 ${foreignDevice} / ${fixture.root} rw - ext4 /dev/foreign rw\n`,
    );

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
          verifyDescriptorTargetIdentity: true,
        }),
      ),
    ).toThrowError("proc_unavailable");
    expect(lstatSync(descriptor.link).isSymbolicLink()).toBe(true);
  });

  it("ignores unrelated PID churn and fd offsets, including the inspector", () => {
    const fixture = makeFixture();
    const outside = join(fixture.root, "outside.jsonl");
    const unrelatedDescriptor = addDescriptor(fixture, {
      flags: "0100000",
      target: outside,
    });
    const inspectorDescriptor = addDescriptor(fixture, {
      flags: "0100000",
      pid: fixture.inspectorPid,
      target: outside,
    });
    const outsideInode = lstatSync(outside).ino;

    const result = withDeployTestEnvironment(fixture.root, () =>
      inspectStateOpenFiles({
        cgroupRoot: fixture.cgroup,
        forbiddenCgroup: fixture.forbiddenCgroup,
        inspectorPid: fixture.inspectorPid,
        onBetweenScans: () => {
          rmSync(join(fixture.proc, "101"), { recursive: true });
          ensureProcess(fixture, { pid: "102" });
        },
        onDescriptorRead: (pid: string) => {
          const info =
            pid === fixture.inspectorPid
              ? inspectorDescriptor.fdinfo
              : pid === "101"
                ? unrelatedDescriptor.fdinfo
                : null;
          if (info === null) return;
          privateFile(
            info,
            `pos:\t1\nflags:\t0100000\nmnt_id:\t1\nino:\t${outsideInode}\n`,
          );
        },
        procRoot: fixture.proc,
        serviceUid: fixture.serviceUid,
        stateRoot: fixture.state,
        testOverride: true,
      }),
    );

    expect(result).toEqual(expectedJson(false));
  });

  it("compares only security projections when a related task's proc text changes", () => {
    const fixture = makeFixture();
    let changed = false;

    const result = withDeployTestEnvironment(fixture.root, () =>
      inspectStateOpenFiles({
        cgroupRoot: fixture.cgroup,
        forbiddenCgroup: fixture.forbiddenCgroup,
        inspectorPid: fixture.inspectorPid,
        onDescriptorRead: (pid: string, tid: string) => {
          if (pid !== fixture.inspectorPid || tid !== fixture.inspectorPid || changed) {
            return;
          }
          changed = true;
          const taskRoot = join(fixture.proc, pid, "task", tid);
          privateFile(join(taskRoot, "status"), "Name:\tchanged\nUid:\t0\t0\t0\t0\n");
          privateFile(
            join(taskRoot, "cgroup"),
            "0::/system.slice/still-unrelated.service\n",
          );
          privateFile(
            join(taskRoot, "mountinfo"),
            `1 0 0:42 / ${fixture.root} rw shared:7 - ext4 /dev/vda2 rw\n`,
          );
        },
        procRoot: fixture.proc,
        serviceUid: fixture.serviceUid,
        stateRoot: fixture.state,
        testOverride: true,
      }),
    );

    expect(changed).toBe(true);
    expect(result).toEqual(expectedJson(false));
  });

  it("allows an unrelated process to exit while its evidence is inspected", () => {
    const fixture = makeFixture();
    addDescriptor(fixture, {
      flags: "0100000",
      target: join(fixture.root, "outside.jsonl"),
    });
    let exited = false;

    const result = withDeployTestEnvironment(fixture.root, () =>
      inspectStateOpenFiles({
        cgroupRoot: fixture.cgroup,
        forbiddenCgroup: fixture.forbiddenCgroup,
        inspectorPid: fixture.inspectorPid,
        onDescriptorRead: (pid: string) => {
          if (pid !== "101" || exited) return;
          exited = true;
          rmSync(join(fixture.proc, pid), { recursive: true });
        },
        procRoot: fixture.proc,
        serviceUid: fixture.serviceUid,
        stateRoot: fixture.state,
        testOverride: true,
      }),
    );

    expect(exited).toBe(true);
    expect(result).toEqual(expectedJson(false));
  });

  it("does not treat a candidate descriptor offset as file-identity drift", () => {
    const fixture = makeFixture();
    const descriptor = addDescriptor(fixture, { flags: "0100000" });
    const inode = lstatSync(join(fixture.state, "events.jsonl")).ino;

    const result = withDeployTestEnvironment(fixture.root, () =>
      inspectStateOpenFiles({
        cgroupRoot: fixture.cgroup,
        forbiddenCgroup: fixture.forbiddenCgroup,
        inspectorPid: fixture.inspectorPid,
        onDescriptorRead: (pid: string) => {
          if (pid !== "101") return;
          privateFile(
            descriptor.fdinfo,
            `pos:\t99\nflags:\t0100000\nmnt_id:\t1\nino:\t${inode}\n`,
          );
        },
        procRoot: fixture.proc,
        serviceUid: fixture.serviceUid,
        stateRoot: fixture.state,
        testOverride: true,
      }),
    );

    expect(result).toEqual(expectedJson(false));
  });

  it("ignores non-security fd flags while retaining related descriptor identity", () => {
    const fixture = makeFixture();
    const descriptor = addDescriptor(fixture, { flags: "0100000" });
    const inode = lstatSync(join(fixture.state, "events.jsonl")).ino;
    let changed = false;

    const result = withDeployTestEnvironment(fixture.root, () =>
      inspectStateOpenFiles({
        cgroupRoot: fixture.cgroup,
        forbiddenCgroup: fixture.forbiddenCgroup,
        inspectorPid: fixture.inspectorPid,
        onDescriptorRead: (pid: string) => {
          if (pid !== "101" || changed) return;
          changed = true;
          privateFile(
            descriptor.fdinfo,
            `pos:\t0\nflags:\t02106000\nmnt_id:\t1\nino:\t${inode}\n`,
          );
        },
        procRoot: fixture.proc,
        serviceUid: fixture.serviceUid,
        stateRoot: fixture.state,
        testOverride: true,
      }),
    );

    expect(changed).toBe(true);
    expect(result).toEqual(expectedJson(false));
  });

  it.each([
    ["access mode", "0100001"],
    ["O_PATH", "010000000"],
  ])("fails closed when a related descriptor changes %s", (_label, flags) => {
    const fixture = makeFixture();
    const descriptor = addDescriptor(fixture, { flags: "0100000" });
    const inode = lstatSync(join(fixture.state, "events.jsonl")).ino;
    let changed = false;

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          onDescriptorRead: (pid: string) => {
            if (pid !== "101" || changed) return;
            changed = true;
            privateFile(
              descriptor.fdinfo,
              `pos:\t0\nflags:\t${flags}\nmnt_id:\t1\nino:\t${inode}\n`,
            );
          },
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrowError("proc_unavailable");

    expect(changed).toBe(true);
  });

  it.each([
    ["private", "r--p", "r-xp", "rd mr mw me", "rd ex mr mw me"],
    ["shared without may-write", "r--s", "r-xs", "rd sh mr me ms", "rd ex sh mr me ms"],
  ])(
    "ignores harmless %s mapping permission churn",
    (_label, initialPermissions, finalPermissions, initialVmFlags, finalVmFlags) => {
      const fixture = makeFixture();
      const inode = lstatSync(join(fixture.state, "events.jsonl")).ino;
      const initialMapping =
        `1000-2000 ${initialPermissions} 00000000 00:2a ${inode} ` +
        `${fixture.state}/events.jsonl\n`;
      ensureProcess(fixture, {
        maps: initialMapping,
        smaps: `${initialMapping}Size: 4 kB\nVmFlags: ${initialVmFlags}\n`,
      });
      let changed = false;

      const result = withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          onMappingEvidenceStored: (pid: string, tid: string) => {
            if (pid !== "101" || tid !== "101" || changed) return;
            changed = true;
            const finalMapping =
              `1000-2000 ${finalPermissions} 00000000 00:2a ${inode} ` +
              `${fixture.state}/events.jsonl\n`;
            privateFile(join(fixture.proc, pid, "task", tid, "maps"), finalMapping);
            privateFile(
              join(fixture.proc, pid, "task", tid, "smaps"),
              `${finalMapping}Size: 4 kB\nVmFlags: ${finalVmFlags}\n`,
            );
          },
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      );

      expect(changed).toBe(true);
      expect(result).toEqual(expectedJson(false));
    },
  );

  it("fails closed when a shared state mapping gains VM_MAYWRITE", () => {
    const fixture = makeFixture();
    const inode = lstatSync(join(fixture.state, "events.jsonl")).ino;
    const mapping = `1000-2000 r--s 00000000 00:2a ${inode} ${fixture.state}/events.jsonl\n`;
    ensureProcess(fixture, {
      maps: mapping,
      smaps: `${mapping}Size: 4 kB\nVmFlags: rd sh mr me ms\n`,
    });
    let changed = false;

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          onMappingEvidenceStored: (pid: string, tid: string) => {
            if (pid !== "101" || tid !== "101" || changed) return;
            changed = true;
            privateFile(
              join(fixture.proc, pid, "task", tid, "smaps"),
              `${mapping}Size: 4 kB\nVmFlags: rd sh mr mw me ms\n`,
            );
          },
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrowError("proc_unavailable");

    expect(changed).toBe(true);
  });

  it("fails closed when a checked ancestor is exchanged between scans", () => {
    const fixture = makeFixture({ nested: true });
    addDescriptor(fixture, { flags: "0100000" });

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          onBetweenScans: () => {
            renameSync(fixture.scope, `${fixture.scope}-old`);
            privateDirectory(fixture.scope);
            privateDirectory(fixture.state);
            privateDirectory(fixture.proc);
          },
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrow();
  });

  it("rejects same-tick task-directory ABA for a previously related TID", () => {
    const fixture = makeFixture();
    addDescriptor(fixture, {
      flags: "0100000",
      pid: "101",
      tid: "102",
    });
    const workerTask = join(fixture.proc, "101", "task", "102");
    const retiredTask = join(fixture.root, "outer-scan-retired-task-102");
    const originalInode = lstatSync(workerTask).ino;
    let replaced = false;

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          onBetweenScans: () => {
            replaced = true;
            renameSync(workerTask, retiredTask);
            ensureThread(fixture, {
              pid: "101",
              starttime: "1000",
              tid: "102",
            });
            expect(lstatSync(workerTask).ino).not.toBe(originalInode);
          },
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrowError("proc_unavailable");

    expect(replaced).toBe(true);
  });

  it.each([
    ["changes namespace", "2", "stable"],
    ["reuses the namespace label", "1", "replacement"],
  ])("rejects a related task that %s between scans", (_label, namespace, generation) => {
    const fixture = makeFixture();
    addDescriptor(fixture, { flags: "0100000" });
    const taskDirectory = join(fixture.proc, "101", "task", "101");
    let changed = false;

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          onBetweenScans: () => {
            changed = true;
            installTaskMountNamespace(fixture, taskDirectory, namespace, generation);
          },
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrowError("proc_unavailable");

    expect(changed).toBe(true);
  });

  it.each(["missing", "inaccessible"])(
    "fails closed when a related task mount namespace is %s",
    (condition) => {
      const fixture = makeFixture();
      addDescriptor(fixture, { flags: "0100000" });
      const namespaceDirectory = join(fixture.proc, "101", "task", "101", "ns");
      if (condition === "missing") {
        unlinkSync(join(namespaceDirectory, "mnt"));
      } else {
        chmodSync(namespaceDirectory, 0o300);
      }

      expect(() =>
        withDeployTestEnvironment(fixture.root, () =>
          inspectStateOpenFiles({
            cgroupRoot: fixture.cgroup,
            forbiddenCgroup: fixture.forbiddenCgroup,
            inspectorPid: fixture.inspectorPid,
            procRoot: fixture.proc,
            serviceUid: fixture.serviceUid,
            stateRoot: fixture.state,
            testOverride: true,
          }),
        ),
      ).toThrowError("alias_inspection_unavailable");
      if (condition === "inaccessible") chmodSync(namespaceDirectory, 0o700);
    },
  );

  it("rejects related task mount-object churn between scans", () => {
    const fixture = makeFixture();
    addDescriptor(fixture, { flags: "0100000" });
    let changed = false;

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          onBetweenScans: () => {
            changed = true;
            privateFile(
              join(fixture.proc, "101", "task", "101", "mountinfo"),
              `1 0 0:42 /changed ${fixture.root} rw - ext4 /dev/vda2 rw\n`,
            );
          },
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrowError("proc_unavailable");

    expect(changed).toBe(true);
  });

  it("rescans UID evidence when proc directory display metadata changes", () => {
    const fixture = makeFixture();
    addDescriptor(fixture, { flags: "0100000" });
    const processDirectory = join(fixture.proc, "101");
    const taskRoot = join(processDirectory, "task");
    const taskDirectory = join(taskRoot, "101");
    const originalProcessInode = lstatSync(processDirectory).ino;
    const originalTaskInode = lstatSync(taskDirectory).ino;
    let changed = false;

    const result = withDeployTestEnvironment(fixture.root, () =>
      inspectStateOpenFiles({
        cgroupRoot: fixture.cgroup,
        forbiddenCgroup: fixture.forbiddenCgroup,
        inspectorPid: fixture.inspectorPid,
        onBetweenScans: () => {
          changed = true;
          chmodSync(processDirectory, 0o750);
          chmodSync(taskRoot, 0o710);
          chmodSync(taskDirectory, 0o750);
          privateFile(
            join(taskDirectory, "status"),
            `Name:\tfixture\nUid:\t${fixture.serviceUid}\t${fixture.serviceUid}\t${fixture.serviceUid}\t${fixture.serviceUid}\n`,
          );
          expect(lstatSync(processDirectory).ino).toBe(originalProcessInode);
          expect(lstatSync(taskDirectory).ino).toBe(originalTaskInode);
        },
        procRoot: fixture.proc,
        serviceUid: fixture.serviceUid,
        stateRoot: fixture.state,
        testOverride: true,
      }),
    );

    expect(changed).toBe(true);
    expect(result).toEqual(
      expectedJson(false, false, false, { serviceUidProcessDetected: true }),
    );
  });

  it("rejects PID reuse by comparing starttime across scans", () => {
    const fixture = makeFixture();
    addDescriptor(fixture, { flags: "0100000" });

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          onBetweenScans: () => {
            privateFile(join(fixture.proc, "101", "stat"), procStat("101", "2000"));
            privateFile(
              join(fixture.proc, "101", "task", "101", "stat"),
              procStat("101", "2000"),
            );
          },
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrow();
  });

  it("rejects thread-group leader reuse during a process scan", () => {
    const fixture = makeFixture();
    addDescriptor(fixture, { flags: "0100000" });
    let exchanged = false;

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          onDescriptorRead: (pid: string) => {
            if (pid !== "101" || exchanged) return;
            exchanged = true;
            privateFile(join(fixture.proc, pid, "stat"), procStat(pid, "2000"));
          },
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrow();
    expect(exchanged).toBe(true);
  });

  it("retries a bounded task round when a worker TID is reused mid-scan", () => {
    const fixture = makeFixture();
    addDescriptor(fixture, {
      flags: "0100000",
      pid: "101",
      tid: "102",
    });
    let exchanged = false;
    let leaderScans = 0;

    const result = withDeployTestEnvironment(fixture.root, () =>
      inspectStateOpenFiles({
        cgroupRoot: fixture.cgroup,
        forbiddenCgroup: fixture.forbiddenCgroup,
        inspectorPid: fixture.inspectorPid,
        onDescriptorRead: (pid: string, tid: string) => {
          if (pid === "101" && tid === "101") leaderScans += 1;
          if (pid !== "101" || tid !== "102" || exchanged) return;
          exchanged = true;
          privateFile(
            join(fixture.proc, pid, "task", tid, "stat"),
            procStat(tid, "2000"),
          );
        },
        procRoot: fixture.proc,
        serviceUid: fixture.serviceUid,
        stateRoot: fixture.state,
        testOverride: true,
      }),
    );

    expect(exchanged).toBe(true);
    expect(leaderScans).toBeGreaterThanOrEqual(3);
    expect(result).toEqual(expectedJson(false));
  });

  it("discards every task's evidence when a later TID restarts the scan", () => {
    const fixture = makeFixture();
    ensureProcess(fixture);
    addDescriptor(fixture, {
      flags: "0100000",
      pid: "101",
      target: join(fixture.root, "outside.jsonl"),
      tid: "102",
    });
    let churned = false;
    let leaderScans = 0;

    const result = withDeployTestEnvironment(fixture.root, () =>
      inspectStateOpenFiles({
        cgroupRoot: fixture.cgroup,
        forbiddenCgroup: fixture.forbiddenCgroup,
        inspectorPid: fixture.inspectorPid,
        onDescriptorRead: (pid: string, tid: string) => {
          if (pid === "101" && tid === "101") leaderScans += 1;
          if (pid !== "101" || tid !== "102" || churned) return;
          churned = true;
          addDescriptor(fixture, {
            descriptor: "8",
            flags: "0100001",
            pid,
            tid: "101",
          });
          privateFile(
            join(fixture.proc, pid, "task", tid, "stat"),
            procStat(tid, "2000"),
          );
        },
        procRoot: fixture.proc,
        serviceUid: fixture.serviceUid,
        stateRoot: fixture.state,
        testOverride: true,
      }),
    );

    expect(churned).toBe(true);
    expect(leaderScans).toBeGreaterThanOrEqual(3);
    expect(result).toEqual(expectedJson(true));
  });

  it("restarts final identity after a returned TID is replaced at the same tick", () => {
    const fixture = makeFixture();
    ensureThread(fixture, { pid: "101", tid: "102" });
    ensureThread(fixture, { pid: "101", tid: "103" });
    const workerTask = join(fixture.proc, "101", "task", "102");
    const retiredTask = join(fixture.root, "retired-task-102");
    const originalInode = lstatSync(workerTask).ino;
    let finalIdentityReached = false;
    let hookSawStoredEvidence = false;
    let leaderScans = 0;
    let replaced = false;
    let taskEvidenceStored = false;

    const result = withDeployTestEnvironment(fixture.root, () =>
      inspectStateOpenFiles({
        cgroupRoot: fixture.cgroup,
        forbiddenCgroup: fixture.forbiddenCgroup,
        inspectorPid: fixture.inspectorPid,
        onDescriptorRead: (pid: string, tid: string) => {
          if (pid === "101" && tid === "101") leaderScans += 1;
          if (pid !== "101" || tid !== "103" || replaced) return;
          hookSawStoredEvidence = taskEvidenceStored;
          replaced = true;
          renameSync(workerTask, retiredTask);
          addDescriptor(fixture, {
            flags: "0100001",
            pid,
            tid: "102",
          });
          expect(lstatSync(workerTask).ino).not.toBe(originalInode);
        },
        onTaskEvidenceStored: (pid: string, tid: string) => {
          if (pid === "101" && tid === "102") taskEvidenceStored = true;
        },
        onTaskFinalIdentity: (pid: string, tid: string) => {
          if (pid === "101" && tid === "102" && replaced) {
            finalIdentityReached = true;
          }
        },
        procRoot: fixture.proc,
        serviceUid: fixture.serviceUid,
        stateRoot: fixture.state,
        testOverride: true,
      }),
    );

    expect(replaced).toBe(true);
    expect(hookSawStoredEvidence).toBe(true);
    expect(finalIdentityReached).toBe(true);
    expect(leaderScans).toBeGreaterThanOrEqual(3);
    expect(result).toEqual(expectedJson(true));
  });

  it("fails closed after a clean same-tick TID replacement is fully rescanned", () => {
    const fixture = makeFixture();
    ensureThread(fixture, { pid: "101", tid: "102" });
    ensureThread(fixture, { pid: "101", tid: "103" });
    const workerTask = join(fixture.proc, "101", "task", "102");
    const retiredTask = join(fixture.root, "retired-clean-task-102");
    let finalIdentityReached = false;
    let leaderScans = 0;
    let replaced = false;
    let taskEvidenceStored = false;

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          onDescriptorRead: (pid: string, tid: string) => {
            if (pid === "101" && tid === "101") leaderScans += 1;
            if (pid !== "101" || tid !== "103" || replaced) return;
            expect(taskEvidenceStored).toBe(true);
            replaced = true;
            renameSync(workerTask, retiredTask);
            ensureThread(fixture, { pid, starttime: "1000", tid: "102" });
          },
          onTaskEvidenceStored: (pid: string, tid: string) => {
            if (pid === "101" && tid === "102") taskEvidenceStored = true;
          },
          onTaskFinalIdentity: (pid: string, tid: string) => {
            if (pid === "101" && tid === "102" && replaced) {
              finalIdentityReached = true;
            }
          },
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrow();

    expect(replaced).toBe(true);
    expect(finalIdentityReached).toBe(true);
    expect(leaderScans).toBeGreaterThanOrEqual(2);
  });

  it("retries when a listed worker TID exits before its identity stabilizes", () => {
    const fixture = makeFixture();
    addDescriptor(fixture, {
      flags: "0100000",
      pid: "101",
      target: join(fixture.root, "outside.jsonl"),
      tid: "102",
    });
    let exited = false;

    const result = withDeployTestEnvironment(fixture.root, () =>
      inspectStateOpenFiles({
        cgroupRoot: fixture.cgroup,
        forbiddenCgroup: fixture.forbiddenCgroup,
        inspectorPid: fixture.inspectorPid,
        onDescriptorRead: (pid: string, tid: string) => {
          if (pid !== "101" || tid !== "102" || exited) return;
          exited = true;
          rmSync(join(fixture.proc, pid, "task", tid), { recursive: true });
        },
        procRoot: fixture.proc,
        serviceUid: fixture.serviceUid,
        stateRoot: fixture.state,
        testOverride: true,
      }),
    );

    expect(exited).toBe(true);
    expect(result).toEqual(expectedJson(false));
  });

  it("rescans a newly created worker TID and catches its state capability", () => {
    const fixture = makeFixture();
    ensureProcess(fixture);
    let created = false;

    const result = withDeployTestEnvironment(fixture.root, () =>
      inspectStateOpenFiles({
        cgroupRoot: fixture.cgroup,
        forbiddenCgroup: fixture.forbiddenCgroup,
        inspectorPid: fixture.inspectorPid,
        onDescriptorRead: (pid: string, tid: string) => {
          if (pid !== "101" || tid !== "101" || created) return;
          created = true;
          addDescriptor(fixture, {
            flags: "0100001",
            pid,
            tid: "102",
          });
        },
        procRoot: fixture.proc,
        serviceUid: fixture.serviceUid,
        stateRoot: fixture.state,
        testOverride: true,
      }),
    );

    expect(created).toBe(true);
    expect(result).toEqual(expectedJson(true));
  });

  it("rejects descriptor-number reuse inside a scan", () => {
    const fixture = makeFixture();
    const descriptor = addDescriptor(fixture, { flags: "0100000" });
    const outside = join(fixture.root, "outside.jsonl");
    privateFile(outside, "outside\n");
    let exchanged = false;

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          onDescriptorRead: (pid: string) => {
            if (pid !== "101" || exchanged) return;
            exchanged = true;
            unlinkSync(descriptor.link);
            symlinkSync(outside, descriptor.link);
          },
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrow();
    expect(exchanged).toBe(true);
  });

  it("rejects inspector mount-namespace drift between scans", () => {
    const fixture = makeFixture();
    ensureProcess(fixture);

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          onBetweenScans: () => {
            privateFile(
              join(
                fixture.proc,
                fixture.inspectorPid,
                "task",
                fixture.inspectorPid,
                "mountinfo",
              ),
              `${mountinfo(fixture)}2 1 0:43 / /new-mount rw - tmpfs fixture rw\n`,
            );
          },
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrow();
  });

  it("rejects mount parent-graph drift between scans", () => {
    const fixture = makeFixture();
    ensureProcess(fixture);

    expect(() =>
      withDeployTestEnvironment(fixture.root, () =>
        inspectStateOpenFiles({
          cgroupRoot: fixture.cgroup,
          forbiddenCgroup: fixture.forbiddenCgroup,
          inspectorPid: fixture.inspectorPid,
          onBetweenScans: () => {
            privateFile(
              join(
                fixture.proc,
                fixture.inspectorPid,
                "task",
                fixture.inspectorPid,
                "mountinfo",
              ),
              `1 9 0:42 / ${fixture.root} rw - ext4 /dev/vda2 rw\n`,
            );
          },
          procRoot: fixture.proc,
          serviceUid: fixture.serviceUid,
          stateRoot: fixture.state,
          testOverride: true,
        }),
      ),
    ).toThrowError("alias_inspection_unavailable");
  });
});
