import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MODULE = "deploy/windows/AgentOS.Windows.psm1";
const HOST = "deploy/windows/worker-host.ps1";
const INSTALL = "deploy/windows/install-worker.ps1";
const START = "deploy/windows/start-worker.ps1";
const STOP = "deploy/windows/stop-worker.ps1";
const HEALTH = "deploy/windows/health-worker.ps1";
const UNINSTALL = "deploy/windows/uninstall-worker.ps1";
const UPGRADE = "deploy/windows/upgrade-worker-admin.ps1";
const BOOTSTRAP = "deploy/windows/bootstrap-powershell.ps1";
const CSC = [
  "/Library/Frameworks/Mono.framework/Versions/Current/Commands/csc",
  "/usr/bin/csc",
].find((path) => existsSync(path));
const MONO = [
  "/Library/Frameworks/Mono.framework/Versions/Current/Commands/mono",
  "/usr/bin/mono",
].find((path) => existsSync(path));

describe("Windows Worker deployment contract", () => {
  it("uses Windows PowerShell 5.1 only to bootstrap a pinned Microsoft 7.4 runtime", async () => {
    const bootstrap = await readFile(BOOTSTRAP, "utf8");
    expect(bootstrap).toContain("#requires -Version 5.1");
    expect(bootstrap).toContain("ExpectedMsiSha256");
    expect(bootstrap).toContain("ExpectedPwshSha256");
    expect(bootstrap).toContain("ExpectedSignerThumbprint");
    expect(bootstrap).toContain("Get-AuthenticodeSignature");
    expect(bootstrap).toContain("SignerCertificate.Thumbprint");
    expect(bootstrap).toContain("BootstrapFile]::LinkCount");
    expect(bootstrap).toContain("path ancestry contains a reparse point");
    expect(bootstrap).toContain("AgentOSBootstrap");
    expect(bootstrap).toContain("Assert-ApprovedMsi -Path $stagePath");
    expect(bootstrap).toContain("Assert-BootstrapAcl -Path $stagePath");
    expect(bootstrap).toContain("'/i', $stagePath");
    expect(bootstrap).toContain("outside the audited 7.4 release line");
    expect(bootstrap).toContain("ADD_PATH=0");
    expect(bootstrap).not.toContain("Invoke-WebRequest");
  });
  it("pins a non-admin account and proves private ProgramData ACLs", async () => {
    const [module, install] = await Promise.all([
      readFile(MODULE, "utf8"),
      readFile(INSTALL, "utf8"),
    ]);
    expect(module).toContain("AreAccessRulesProtected");
    expect(module).toContain("S-1-5-18");
    expect(module).toContain("S-1-5-32-544");
    expect(module).toContain("GetLinkCount");
    expect(module).toContain("ReparsePoint");
    expect(module).toContain("function Set-AgentOSAdminAcl");
    expect(module).toContain("function Assert-AgentOSAdminAcl");
    expect(module).toContain("function Set-AgentOSWorkerReadAcl");
    expect(module).toContain("function Assert-AgentOSWorkerReadAcl");
    expect(install).toContain("must not be an administrator");
    expect(install).toContain("RunLevel Limited");
    expect(install).toContain("Assert-AgentOSWorkerReadAcl -Path $configPath");
    expect(install).toContain("Set-AgentOSAdminAcl -Path $configCandidate");
    expect(install).toContain("Set-AgentOSWorkerReadAcl -Path $configPath");
    expect(install).toContain("Assert-AgentOSAdminAcl -Path $journalPath");
    expect(install).toContain("Set-AgentOSAdminAcl -Path $journalCandidate");
    expect(install).toContain("Set-AgentOSAdminAcl -Path $stage");
    expect(install.indexOf("changed after candidate copy")).toBeLessThan(
      install.indexOf("-CandidatePath $configCandidate -TargetPath $configPath"),
    );
    expect(install.indexOf("Set-AgentOSWorkerReadAcl -Path $configPath")).toBeLessThan(
      install.indexOf("changed after publication"),
    );
    expect(install).toContain("Get-AgentOSTreeDigest");
    expect(install).toContain("worker-admin-$ExpectedAdminSha256");
    expect(install).not.toContain("Join-Path $PSScriptRoot 'worker-host.ps1'");
    expect(install).not.toContain("ConvertFrom-SecureString");
    expect(install).toContain("Assert-AgentOSReleaseTree");
  });

  it("switches an immutable admin release only while the task is stopped", async () => {
    const upgrade = await readFile(UPGRADE, "utf8");
    expect(upgrade).toContain("requires a stopped task");
    expect(upgrade).toContain("requires zero related processes");
    expect(upgrade).toContain("Get-AgentOSTreeDigest");
    expect(upgrade).toContain("Assert-AgentOSReleaseTree");
    expect(upgrade).toContain("Register-ScheduledTask");
    expect(upgrade).toContain(
      ".upgrade-worker-admin-$ExpectedAdminSha256.json.candidate",
    );
    expect(upgrade).toContain("Set-AgentOSAdminAcl -Path $journalCandidate");
    expect(upgrade).toContain(".upgrade-worker-admin-$ExpectedAdminSha256.json");
    expect(upgrade).toContain("Read-UpgradeJournalRecord -Path $journalCandidate");
    expect(upgrade).toContain("$candidateIndex -notin");
    expect(upgrade).toContain(
      "another Windows Worker admin upgrade journal is unfinished",
    );
    expect(upgrade).toContain(
      "another Windows Worker admin upgrade journal candidate exists",
    );
    expect(upgrade).toContain("taskUsesNewRelease");
    for (const phase of ["prepared", "task_switched", "verified", "committed"]) {
      expect(upgrade).toContain(`'${phase}'`);
    }
    const committedRetry = upgrade.indexOf(
      "$journal -and $journal.phase -eq 'committed'",
    );
    expect(committedRetry).toBeGreaterThan(0);
    expect(committedRetry).toBeLessThan(
      upgrade.indexOf("Write-UpgradeJournal -Phase prepared"),
    );
    expect(upgrade.indexOf("if (-not $taskUsesNewRelease)")).toBeLessThan(
      upgrade.indexOf("Advance-UpgradeJournal -Phase task_switched"),
    );
    expect(
      upgrade.indexOf("Read-UpgradeJournalRecord -Path $journalCandidate"),
    ).toBeLessThan(upgrade.indexOf("Get-ScheduledTask -TaskName $TaskName"));
    expect(upgrade).toContain("$history.phase -cne 'committed'");
  });

  it("preflights before mutation and exposes an adoptable install fault matrix", async () => {
    const install = await readFile(INSTALL, "utf8");
    const firstRootWrite = install.indexOf("New-Item -ItemType Directory -Path $root");
    expect(install.indexOf("Get-AgentOSTreeDigest -Root $PSScriptRoot")).toBeLessThan(
      firstRootWrite,
    );
    expect(install.indexOf("Get-ScheduledTask -TaskName 'AgentOS Worker'")).toBeLessThan(
      firstRootWrite,
    );
    expect(install.indexOf("Get-FileHash -LiteralPath $SecretConfigSource")).toBeLessThan(
      firstRootWrite,
    );
    expect(install).toContain(".install-worker.json.candidate");
    expect(install).toContain(".installing");
    expect(install).not.toContain(".stage-$PID");
    for (const phase of ["intent", "layout", "release", "config", "task", "committed"]) {
      expect(install).toContain(`'${phase}'`);
    }
    for (const boundary of [
      "staged admin file changed during retry",
      "both installed and staged admin releases",
      "staged secret configuration changed during retry",
      "Assert-AgentOSWorkerTask",
      "already installed",
    ]) {
      expect(install).toContain(boundary);
    }
  });

  it("clears ambient env and binds the Worker tree to kill-on-close Job Object", async () => {
    const host = await readFile(HOST, "utf8");
    expect(host).toContain("0x00002000; // KILL_ON_JOB_CLOSE");
    expect(host).toContain("CREATE_SUSPENDED");
    expect(host).toContain("CREATE_UNICODE_ENVIRONMENT");
    expect(host).toContain('observe?.Invoke("created-suspended")');
    expect(host).toContain('observe?.Invoke("assigned")');
    expect(host).toContain('observe?.Invoke("resumed")');
    expect(host).toContain("AssignProcessToJobObject");
    expect(host.indexOf('observe?.Invoke("created-suspended")')).toBeLessThan(
      host.indexOf("AssignProcessToJobObject(handle, created.process)"),
    );
    expect(
      host.indexOf("AssignProcessToJobObject(handle, created.process)"),
    ).toBeLessThan(host.indexOf("ResumeThread(created.thread)"));
    expect(host).not.toContain("$process.Start()");
    expect(host).toContain("$start.Environment.Clear()");
    expect(host).not.toContain("'PATH'");
    expect(host.indexOf("$job.StartSuspended(")).toBeLessThan(
      host.indexOf("[IO.File]::WriteAllText($gate"),
    );
    expect(host).toContain("Assert-AgentOSWorkerReadAcl -Path $ConfigPath");
    expect(host).toContain("$job.Dispose()");
    expect(host).toContain("AGENT_OS_JOB_ASSIGNMENT_GATE");
    expect(host).toContain("Assert-AgentOSTrustedExecutable -Path $nodePath");
    expect(host).toContain(
      "Worker working directory is outside a protected Agent OS release",
    );
    expect(host).toContain("AGENT_OS_CREDENTIAL_ROOT");
  });

  it.runIf(Boolean(CSC && MONO))(
    "executes the production Windows argument quoting table",
    async () => {
      const host = await readFile(HOST, "utf8");
      const typeDefinition = host.match(
        /Add-Type -TypeDefinition @'\n([\s\S]*?)\n'@/u,
      )?.[1];
      expect(typeDefinition).toBeTruthy();
      const probe = `${typeDefinition}\npublic static class Probe { public static void Main() { AgentOS.Windows.Job.AssertQuotingContract(); System.Console.WriteLine(AgentOS.Windows.Job.QuoteArgument(@"C:\\Program Files\\Agent OS\\worker.mjs")); } }\n`;
      const root = mkdtempSync(join(tmpdir(), "agent-os-csharp-probe-"));
      try {
        const source = join(root, "quote.cs");
        const executable = join(root, "quote.exe");
        writeFileSync(source, probe, { encoding: "utf8", mode: 0o600 });
        const compile = spawnSync(CSC, ["/nologo", `/out:${executable}`, source], {
          encoding: "utf8",
        });
        expect(compile.status, compile.stderr || compile.stdout).toBe(0);
        const result = spawnSync(MONO, [executable], { encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe('"C:\\Program Files\\Agent OS\\worker.mjs"');
      } finally {
        rmSync(root, { recursive: true });
      }
    },
  );

  it("provides idempotent start, stop, health and uninstall entrypoints", async () => {
    const [start, stop, health, uninstall] = await Promise.all(
      [START, STOP, HEALTH, UNINSTALL].map((path) => readFile(path, "utf8")),
    );
    expect(start).toContain("Assert-AgentOSWorkerTask");
    expect(start).toContain("health-worker.ps1");
    expect(stop).toContain("Get-AgentOSWorkerProcesses");
    expect(stop).toContain("Assert-AgentOSWorkerTask");
    expect(stop).toContain('"processes":0');
    expect(health).toContain("task.State -ne 'Running'");
    expect(health).toContain("processes.Count -lt 2");
    expect(uninstall).toContain("Unregister-ScheduledTask");
    expect(uninstall).toContain("Assert-AgentOSWorkerTask");
    expect(uninstall).toContain('"dataPreserved":true');
    expect(uninstall).not.toMatch(/Remove-Item.*(?:state|config)/u);
  });
});
