import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const probe = "deploy/hub/probes/state-open-files-linux.sh";
const bridge = "deploy/hub/probes/state-open-files-between-scans.mjs";
const holder = "deploy/hub/probes/state-open-files-linux-holder.c";

describe("Linux observable-reference field probes", () => {
  it("keeps the shell and between-scan bridge parseable", () => {
    const shell = spawnSync("/bin/bash", ["-n", probe], { encoding: "utf8" });
    expect(shell.status, shell.stderr).toBe(0);
    const node = spawnSync(process.execPath, ["--check", bridge], { encoding: "utf8" });
    expect(node.status, node.stderr).toBe(0);
  });

  it("uses unique owned resources and an unconditional cleanup trap", () => {
    const source = readFileSync(probe, "utf8");
    expect(source).toContain("mktemp -d /tmp/agent-os-openfd-probe.XXXXXX");
    expect(source).toContain('probe_unit="agent-os-openfd-probe-$PPID-$$.service"');
    expect(source).toContain("trap cleanup EXIT INT TERM HUP");
    expect(source).toContain('"$probe_root" == /tmp/agent-os-openfd-probe.*');
    expect(source).toContain("assert_trusted_source_file");
    expect(source).not.toContain("AGENT_OS_PROBE_NODE_BIN");
  });

  it("binds the three probes to the intended Linux primitives", () => {
    const shell = readFileSync(probe, "utf8");
    const c = readFileSync(holder, "utf8");
    const node = readFileSync(bridge, "utf8");
    expect(c).toContain("chroot(state_root)");
    expect(c).toContain("O_TMPFILE | O_RDWR | O_CLOEXEC");
    expect(c).toContain("linkat(");
    expect(node).toContain("onBetweenScans()");
    expect(shell).toContain("cgroupDirectoryAbsent!==true");
    expect(shell).toContain("cgroupPopulatedDetected!==true");
    expect(shell).toContain("wait_for_cgroup_populated");
    expect(shell).toContain("cgroup_unit_not_populated");
  });
});
