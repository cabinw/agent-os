import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MODULE = "deploy/windows/AgentOS.Windows.psm1";
const ARCHITECTURE = "deploy/windows/AgentOS.Architecture.ps1";
const HOST = "deploy/windows/worker-host.ps1";
const INSTALL = "deploy/windows/install-worker.ps1";
const START = "deploy/windows/start-worker.ps1";
const STOP = "deploy/windows/stop-worker.ps1";
const HEALTH = "deploy/windows/health-worker.ps1";
const UNINSTALL = "deploy/windows/uninstall-worker.ps1";
const UPGRADE = "deploy/windows/upgrade-worker-admin.ps1";
const BOOTSTRAP = "deploy/windows/bootstrap-powershell.ps1";
const WORKER_RUNTIME_MANIFEST = "deploy/windows/worker-runtime.manifest";
const WORKER_RUNTIME_SOURCES = "deploy/windows/worker-runtime.sources";
const BUILD_WORKER_RUNTIME = "scripts/build-windows-worker-release.mjs";
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
    expect(bootstrap).toContain("[IO.Path]::GetDirectoryName($cursor)");
    expect(bootstrap).not.toContain("Split-Path -LiteralPath $cursor -Parent");
    expect(bootstrap).toContain("AgentOSBootstrap");
    expect(bootstrap).toContain("Assert-ApprovedMsi -Path $stagePath");
    expect(bootstrap).toContain("Assert-BootstrapAcl -Path $stagePath");
    expect(bootstrap).toContain("'/i', $stagePath");
    expect(bootstrap).toContain("outside the audited 7.4 release line");
    expect(bootstrap).toContain("ExpectedHostMachine");
    expect(bootstrap).toContain("ExpectedWorkerMachine");
    expect(bootstrap).toContain("ExpectedArchitectureHelperSha256");
    expect(bootstrap).toContain("Assert-BootstrapFile -Path $architectureHelper");
    expect(bootstrap).toContain("Assert-BootstrapAdminOnlyAcl -Path $PSScriptRoot");
    expect(bootstrap).toContain("Assert-BootstrapAdminOnlyAcl -Path $architectureHelper");
    expect(bootstrap).toContain("Assert-AgentOSBootstrapArchitecture");
    expect(bootstrap).toContain("Assert-AgentOSPEMachine -Path $fixedPwsh");
    expect(bootstrap.indexOf(". $architectureHelper")).toBeLessThan(
      bootstrap.indexOf("$stageRoot ="),
    );
    const architectureLoad = bootstrap.indexOf(". $architectureHelper");
    for (const trustCheck of [
      "Assert-BootstrapFile -Path $architectureHelper",
      "Assert-BootstrapAdminOnlyAcl -Path $PSScriptRoot",
      "Assert-BootstrapAdminOnlyAcl -Path $architectureHelper",
      "Get-FileHash -LiteralPath $architectureHelper",
    ]) {
      expect(bootstrap.indexOf(trustCheck)).toBeLessThan(architectureLoad);
    }
    expect(bootstrap).toContain("ADD_PATH=0");
    expect(bootstrap).not.toContain("Invoke-WebRequest");
  });

  it("binds bootstrap, install and runtime to one machine contract", async () => {
    const [architecture, module, install, upgrade, host] = await Promise.all(
      [ARCHITECTURE, MODULE, INSTALL, UPGRADE, HOST].map((path) =>
        readFile(path, "utf8"),
      ),
    );
    expect(architecture).toContain("IsWow64Process2");
    expect(architecture).toContain("GetMachineTypeAttributes");
    expect(architecture).toContain("private const uint USER_ENABLED = 0x00000001;");
    expect(architecture).toContain("var empty = new StringBuilder(1);");
    expect(architecture).toContain("out fileTime, empty, ref length");
    expect(architecture).not.toContain("out fileTime, null, ref length");
    expect(architecture).toContain("Process.GetCurrentProcess().MainModule.FileName");
    expect(architecture).toContain("return PEMachine(executable)");
    expect(architecture).not.toContain("processMachine == 0 ? nativeMachine");
    expect(architecture).toContain("MsiGetSummaryInformation");
    expect(architecture).toContain("PID_TEMPLATE = 7");
    expect(architecture).toContain("public static ushort PEMachine");
    expect(architecture).toContain('return "machine_unknown"');
    expect(architecture).toContain('return "amd64_emulation_unavailable"');
    expect(architecture).toContain('return "process_machine_mismatch"');
    expect(architecture).toContain('return "asset_machine_mismatch"');
    expect(module).toContain(". (Join-Path $PSScriptRoot 'AgentOS.Architecture.ps1')");
    expect(module).toContain("Assert-AgentOSRuntimeArchitecture");
    const workerTask = module.indexOf("function Assert-AgentOSWorkerTask");
    const taskConfigRead = module.indexOf(
      "$config = Get-Content -LiteralPath $ConfigPath",
      workerTask,
    );
    expect(
      module.indexOf("Assert-AgentOSWorkerReadAcl -Path $ConfigPath", workerTask),
    ).toBeLessThan(taskConfigRead);
    for (const source of [install, upgrade]) {
      expect(source).toContain("'AgentOS.Architecture.ps1'");
      expect(source).toContain("Assert-AgentOSRuntimeArchitecture");
      expect(source).toContain("$configuredPowerShellPath, $nodePath, $grokPath");
    }
    expect(install.indexOf("Assert-AgentOSRuntimeArchitecture")).toBeLessThan(
      install.indexOf("New-Item -ItemType Directory -Path $root"),
    );
    expect(host).toContain("Assert-AgentOSRuntimeArchitecture");
    expect(host).toContain("AGENT_OS_ENABLED_ADAPTERS");
    expect(host).toContain("$enabledAdapters = @($adapterExecutables.Keys)");
    expect(host).toContain("$name = $adapterExecutables[$adapter]");
    expect(host).not.toContain("foreach ($name in @('AGENT_OS_CLAUDE_BIN'");
    expect(host).toContain("$start.Environment['AGENT_OS_PWSH_BIN']");
    expect(host).toContain("$start.Environment['AGENT_OS_GROK_BIN']");
    expect(host).not.toMatch(/-AssetPaths[^\n]*(?:workerEntry|\.ps1|\.mjs)/u);
    expect(host).toContain("[Environment+SpecialFolder]::UserProfile");
    expect(host).toContain("[Environment+SpecialFolder]::ApplicationData");
    expect(host).toContain("[Environment+SpecialFolder]::LocalApplicationData");
    expect(host).toContain("USERPROFILE = $userProfile");
    expect(host).toContain("HOME = $userProfile");
    expect(host).toContain("Worker profile environment escapes USERPROFILE");
    expect(host.indexOf("$vendorProfileEnvironment")).toBeLessThan(
      host.indexOf("$start.Environment['AGENT_OS_JOB_ASSIGNMENT_GATE']"),
    );
  });

  it.runIf(Boolean(CSC && MONO))(
    "executes the production ARM64-host AMD64-worker decision table",
    async () => {
      const architecture = await readFile(ARCHITECTURE, "utf8");
      const typeDefinition = architecture.match(
        /Add-Type -TypeDefinition @'\n([\s\S]*?)\n'@/u,
      )?.[1];
      expect(typeDefinition).toBeTruthy();
      const probe = `${typeDefinition}
public static class Probe {
  public static void Main() {
    ushort A = AgentOS.Windows.Machine.AMD64;
    ushort R = AgentOS.Windows.Machine.ARM64;
    System.Console.WriteLine(AgentOS.Windows.Machine.ContractCode(A, A, A, false, A, new ushort[]{A, A, A}));
    System.Console.WriteLine(AgentOS.Windows.Machine.ContractCode(R, A, R, true, A, new ushort[]{A, A, A}));
    System.Console.WriteLine(AgentOS.Windows.Machine.ContractCode(R, A, R, false, A, new ushort[]{A}));
    System.Console.WriteLine(AgentOS.Windows.Machine.ContractCode(R, A, R, true, R, new ushort[]{A}));
    System.Console.WriteLine(AgentOS.Windows.Machine.ContractCode(R, A, R, true, A, new ushort[]{R}));
    System.Console.WriteLine(AgentOS.Windows.Machine.ContractCode(R, A, 0, true, A, new ushort[]{A}));
    System.Console.WriteLine(AgentOS.Windows.Machine.ContractCode(R, A, R, true, A, new ushort[]{0}));
    System.Console.WriteLine(AgentOS.Windows.Machine.ContractCode(0, A, R, true, A, new ushort[]{A}));
    System.Console.WriteLine(AgentOS.Windows.Machine.ContractCode(A, A, R, true, A, new ushort[]{A}));
    System.Console.WriteLine(AgentOS.Windows.Machine.Name(AgentOS.Windows.Machine.ParseMsiTemplate("x64;1033")));
    System.Console.WriteLine(AgentOS.Windows.Machine.Name(AgentOS.Windows.Machine.ParseMsiTemplate("Arm64;1033")));
    System.Console.WriteLine(AgentOS.Windows.Machine.Name(AgentOS.Windows.Machine.ParseMsiTemplate("Intel;1033")));
  }
}
`;
      const root = mkdtempSync(join(tmpdir(), "agent-os-machine-probe-"));
      try {
        const source = join(root, "machine.cs");
        const executable = join(root, "machine.exe");
        writeFileSync(source, probe, { encoding: "utf8", mode: 0o600 });
        const compile = spawnSync(CSC, ["/nologo", `/out:${executable}`, source], {
          encoding: "utf8",
        });
        expect(compile.status, compile.stderr || compile.stdout).toBe(0);
        const result = spawnSync(MONO, [executable], { encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim().split(/\r?\n/u)).toEqual([
          "ok",
          "ok",
          "amd64_emulation_unavailable",
          "process_machine_mismatch",
          "asset_machine_mismatch",
          "machine_unknown",
          "machine_unknown",
          "machine_unknown",
          "host_machine_mismatch",
          "AMD64",
          "ARM64",
          "unknown",
        ]);
      } finally {
        rmSync(root, { recursive: true });
      }
    },
  );
  it("pins a non-admin account and proves private ProgramData ACLs", async () => {
    const [module, install] = await Promise.all([
      readFile(MODULE, "utf8"),
      readFile(INSTALL, "utf8"),
    ]);
    expect(module).toContain("AreAccessRulesProtected");
    expect(module).toContain("S-1-5-18");
    expect(module).toContain("S-1-5-32-544");
    expect(module).toContain("AgentOS.Windows.FileIdentity");
    expect(module).toContain("GetFileInformationByHandle");
    expect(module).toContain("FileIdentity]::LinkCount");
    expect(module).not.toContain("[IO.File]::GetLinkCount");
    expect(module).toContain("ReparsePoint");
    expect(module).toContain("function Set-AgentOSAdminAcl");
    expect(module).toContain("function Assert-AgentOSAdminAcl");
    expect(module).toContain("function Set-AgentOSWorkerReadAcl");
    expect(module).toContain("function Assert-AgentOSWorkerReadAcl");
    const privateAcl = module.slice(
      module.indexOf("function Assert-AgentOSPrivateAcl"),
      module.indexOf("function Assert-AgentOSWorkerReadAcl"),
    );
    expect(privateAcl).toContain("$acl.GetOwner(");
    expect(privateAcl).toContain("$acl.GetAccessRules(");
    expect(privateAcl).toContain("$acl.SetOwner(");
    expect(privateAcl).not.toContain("-Kind (\n    if");
    expect(module).toContain("function Assert-AgentOSWorkerAccount");
    expect(module).toContain("Get-LocalGroupMember -Group 'Administrators'");
    expect(module).toContain("must not be an administrator");
    expect(module).toContain("function Assert-AgentOSReleaseTree");
    expect(module).toContain("release ACL is missing a required principal");
    expect(module).toContain("release grants unsafe Worker rights");
    expect(module).toContain("release omits administrator control");
    expect(module).toContain("$rule.IsInherited");
    expect(module).toContain("admin tree ancestry can replace the protected root");
    expect(module).toContain("DeleteSubdirectoriesAndFiles");
    expect(module).toContain("PropagationFlags]::InheritOnly");
    expect(module).toContain("$checkedDirectParent");
    const trustedExecutable = module.slice(
      module.indexOf("function Assert-AgentOSTrustedExecutable"),
      module.indexOf("function Get-AgentOSWorkerProcesses"),
    );
    expect(trustedExecutable).toContain("FileSystemRights]::WriteData");
    expect(trustedExecutable).toContain("FileSystemRights]::AppendData");
    expect(trustedExecutable).toContain("$acl.GetAccessRules(");
    expect(trustedExecutable).toContain("[Security.Principal.SecurityIdentifier]");
    expect(trustedExecutable).not.toContain("'Write, Modify, FullControl");
    expect(module).toContain("function Get-AgentOSCanonicalReleaseManifest");
    expect(module).toContain("function Get-AgentOSExactTreeDigest");
    expect(module).toContain("function Assert-AgentOSConfiguredWorkerRelease");
    expect(install).toContain(
      "Assert-AgentOSWorkerAccount -WorkerAccount $WorkerAccount",
    );
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
    expect(install).toContain("worker-runtime-$ExpectedWorkerReleaseSha256");
    expect(install).toContain("workerReleaseSha256 = $ExpectedWorkerReleaseSha256");
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
    expect(upgrade).toContain("Assert-AgentOSConfiguredWorkerRelease");
    expect(upgrade).toContain("workerReleaseSha256 = $ExpectedWorkerReleaseSha256");
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
    expect(upgrade).toContain("Set-AgentOSWorkerExecutableAcl -Path $executable");
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
    const [install, windowsModule, host] = await Promise.all([
      readFile(INSTALL, "utf8"),
      readFile(MODULE, "utf8"),
      readFile(HOST, "utf8"),
    ]);
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
    expect(install).toContain("$journalNeedsIntentRebind");
    expect(install).toContain("$journal.phase -cne 'intent'");
    expect(install).toContain("$unexpectedIntentEntries.Count -ne 0");
    expect(install).toContain("Write-InstallJournal -Phase intent");
    expect(install).toContain("-AllowStartIfOnBatteries");
    expect(install).toContain("-DontStopIfGoingOnBatteries");
    expect(install).toContain("Set-AgentOSBatchLogonRight -WorkerSid $workerSid");
    expect(install).toContain("'job-assigned.gate'");
    expect(install).toContain("Set-AgentOSPrivateAcl -Path $jobGate");
    expect(install).toContain("'worker-host-status.json'");
    expect(install).toContain("Set-AgentOSPrivateAcl -Path $hostStatus");
    expect(windowsModule).toContain("SeBatchLogonRight");
    expect(windowsModule).toContain("LsaAddAccountRights");
    expect(install).toContain("Set-AgentOSWorkerExecutableAcl -Path $executable");
    expect(windowsModule).toContain(
      "'Traverse, ReadAttributes, ReadExtendedAttributes, ReadPermissions'",
    );
    expect(windowsModule).toContain(
      "Assert-AgentOSWorkerExecutableAcl -Path $executable",
    );
    expect(windowsModule).toContain(
      "Assert-AgentOSBatchLogonRight -WorkerSid $workerSid",
    );
    expect(windowsModule).toContain("$_.ExecutablePath.Equals($powerShellPath");
    expect(windowsModule).toContain("$_.CommandLine.EndsWith($expectedHostArguments");
    expect(windowsModule).toContain("$_.ExecutablePath.Equals($nodePath");
    expect(host).not.toContain("Remove-Item -LiteralPath $gate");
    expect(host).toContain("Assert-AgentOSPrivateAcl -Path $gate");
    expect(host).toContain("WriteAllText($gate, 'pending'");
    expect(host).toContain("WriteAllText($gate, 'assigned'");
    expect(host).toContain("WriteAllText($gate, 'closed'");
    expect(host).toContain("Write-WorkerHostStatus -Phase 'host_error'");
    expect(host).toContain("Write-WorkerHostStatus -Phase 'child_exit'");
    expect(host).toContain("$script:lastHostPhase = 'bootstrap'");
    expect(host).toContain("$script:lastHostPhase = 'checking_node'");
    expect(host).toContain("$script:lastHostPhase = 'entry_verified'");
    expect(host).toContain("$script:lastHostPhase = 'preflight_verified'");
    expect(host.indexOf("trap {")).toBeLessThan(host.indexOf("Import-Module"));
    expect(host).toContain("[Action[string]]{");
    expect(install.indexOf("if ($journalNeedsIntentRebind)")).toBeLessThan(
      install.indexOf("$journal -and $journal.phase -eq 'committed'"),
    );
    expect(install).toContain(".installing");
    expect(install).not.toContain(".stage-$PID");
    for (const phase of [
      "intent",
      "layout",
      "release",
      "runtime",
      "config",
      "task",
      "committed",
    ]) {
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

  it("publishes an exact application runtime before config and Task mutation", async () => {
    const [install, module, host, health, uninstall] = await Promise.all([
      readFile(INSTALL, "utf8"),
      readFile(MODULE, "utf8"),
      readFile(HOST, "utf8"),
      readFile(HEALTH, "utf8"),
      readFile(UNINSTALL, "utf8"),
    ]);
    const firstRootWrite = install.indexOf("New-Item -ItemType Directory -Path $root");
    expect(
      install.indexOf("Assert-AgentOSAdminTree -Path $WorkerReleaseSource"),
    ).toBeLessThan(firstRootWrite);
    expect(
      install.indexOf("Get-AgentOSExactTreeDigest `\n  -Root $WorkerReleaseSource"),
    ).toBeLessThan(firstRootWrite);
    expect(install).toContain("Windows Worker runtime source digest does not match");
    expect(install).toContain("staged runtime file changed during retry");
    expect(install).toContain("runtime file changed after candidate copy");
    expect(install).toContain("both installed and staged runtime releases");
    expect(install.indexOf("[IO.Directory]::Move($workerRuntimeStage")).toBeLessThan(
      install.indexOf("Register-ScheduledTask"),
    );
    expect(install.indexOf("Advance-InstallJournal -Phase runtime")).toBeLessThan(
      install.indexOf("Advance-InstallJournal -Phase config"),
    );
    expect(module).toContain("StringComparer]::OrdinalIgnoreCase");
    expect(module).toContain("StringComparer.OrdinalIgnoreCase");
    expect(module).toContain("manifest_case_collision");
    expect(module).toContain("manifest_segment_unsafe");
    expect(module).toContain("extra directory");
    expect(module).toContain("Assert-AgentOSAdminAcl -Path $entry.FullName");
    expect(module).toContain("Agent OS regular file must have exactly one link");
    expect(health.indexOf("Assert-AgentOSWorkerTask")).toBeLessThan(
      health.indexOf("Get-AgentOSWorkerProcesses"),
    );
    expect(host).toContain("Assert-AgentOSConfiguredWorkerRelease -Config $config");
    expect(health).toContain("Assert-AgentOSWorkerTask");
    expect(uninstall).toContain("Assert-AgentOSWorkerTask");
    expect(module).toContain('segment == ".."');
    expect(module).toContain('segment.EndsWith("."');
    expect(module).toContain('segment.EndsWith(" "');
    expect(module).toContain('"<>:\\"/\\\\|?*"');
    expect(module).toContain("CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]");
  });

  it("freezes a dependency-complete bundle from every canonical Worker source", async () => {
    const [manifestText, sourcesText, sourceEntries, install, upgrade] =
      await Promise.all([
        readFile(WORKER_RUNTIME_MANIFEST, "utf8"),
        readFile(WORKER_RUNTIME_SOURCES, "utf8"),
        readdir("apps/chat-spike/src", { recursive: true }),
        readFile(INSTALL, "utf8"),
        readFile(UPGRADE, "utf8"),
      ]);
    const manifest = manifestText.trim().split(/\r?\n/u);
    const sources = sourcesText.trim().split(/\r?\n/u);
    const expected = sourceEntries
      .filter((relative) => relative.endsWith(".mjs"))
      .map((relative) => `apps\\chat-spike\\src\\${relative.replaceAll("/", "\\")}`)
      .sort();
    expect(sources).toEqual(expected);
    expect(sources).toHaveLength(29);
    expect(manifest).toEqual(["runner-worker.bundle.mjs"]);
    for (const source of [install, upgrade]) {
      expect(source).toContain("'worker-runtime.manifest'");
    }
  });

  it("builds the same self-contained Worker release twice", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-os-worker-bundle-"));
    try {
      const first = join(root, "first");
      const second = join(root, "second");
      for (const output of [first, second]) {
        const result = spawnSync(process.execPath, [BUILD_WORKER_RUNTIME, output], {
          cwd: process.cwd(),
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ files: 1, sources: 29 });
      }
      const firstBundle = await readFile(join(first, "runner-worker.bundle.mjs"));
      const secondBundle = await readFile(join(second, "runner-worker.bundle.mjs"));
      expect(firstBundle.equals(secondBundle)).toBe(true);
      expect(firstBundle.length).toBeGreaterThan(100_000);
      expect(firstBundle.length).toBeLessThan(2_000_000);
      expect(firstBundle.toString("utf8")).not.toContain("/private/tmp/");

      const probe = spawnSync(
        process.execPath,
        [join(first, "runner-worker.bundle.mjs")],
        { encoding: "utf8", env: {} },
      );
      expect(probe.status).not.toBe(0);
      expect(`${probe.stdout}${probe.stderr}`).toContain("AGENT_OS_URL is required");
      expect(`${probe.stdout}${probe.stderr}`).not.toContain("ERR_MODULE_NOT_FOUND");

      const bridgeProbe = spawnSync(
        process.execPath,
        [join(first, "runner-worker.bundle.mjs"), "--agent-os-mcp-bridge"],
        {
          encoding: "utf8",
          env: {},
          input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
        },
      );
      expect(bridgeProbe.status, bridgeProbe.stderr).toBe(0);
      expect(JSON.parse(bridgeProbe.stdout)).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { serverInfo: { name: "agent-os" } },
      });
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it.runIf(Boolean(CSC && MONO))(
    "executes the production Windows release-manifest rejection table",
    async () => {
      const module = await readFile(MODULE, "utf8");
      const typeDefinition = module.match(
        /'AgentOS\.Windows\.ReleaseManifest'[\s\S]*?Add-Type -TypeDefinition @'\n([\s\S]*?)\n'@/u,
      )?.[1];
      expect(typeDefinition).toBeTruthy();
      const probe = `${typeDefinition}
public static class Probe {
  static void Try(string label, string[] files) {
    try {
      System.Console.WriteLine(label + "=" + string.Join(",", AgentOS.Windows.ReleaseManifest.Canonicalize(files)));
    } catch (System.IO.InvalidDataException error) {
      System.Console.WriteLine(label + "=" + error.Message);
    }
  }
  public static void Main() {
    Try("valid", new[]{@"lib\\b.mjs", @"apps\\a.mjs"});
    Try("case", new[]{@"Foo\\entry.mjs", @"foo\\entry.mjs"});
    Try("ads", new[]{@"entry.mjs:stream"});
    Try("dot", new[]{@"dir.\\entry.mjs"});
    Try("space", new[]{@"dir \\entry.mjs"});
    Try("parent", new[]{@"..\\entry.mjs"});
    Try("reserved", new[]{@"CON\\entry.mjs"});
  }
}
`;
      const root = mkdtempSync(join(tmpdir(), "agent-os-release-manifest-"));
      try {
        const source = join(root, "manifest.cs");
        const executable = join(root, "manifest.exe");
        writeFileSync(source, probe, { encoding: "utf8", mode: 0o600 });
        const compile = spawnSync(CSC, ["/nologo", `/out:${executable}`, source], {
          encoding: "utf8",
        });
        expect(compile.status, compile.stderr || compile.stdout).toBe(0);
        const result = spawnSync(MONO, [executable], { encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim().split(/\r?\n/u)).toEqual([
          "valid=apps\\a.mjs,lib\\b.mjs",
          "case=manifest_case_collision",
          "ads=manifest_segment_unsafe",
          "dot=manifest_segment_unsafe",
          "space=manifest_segment_unsafe",
          "parent=manifest_segment_unsafe",
          "reserved=manifest_segment_unsafe",
        ]);
      } finally {
        rmSync(root, { recursive: true });
      }
    },
  );

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
    expect(host.indexOf("WriteAllText($gate, 'pending'")).toBeLessThan(
      host.indexOf("$job.StartSuspended("),
    );
    expect(host.indexOf("$job.StartSuspended(")).toBeLessThan(
      host.indexOf("WriteAllText($gate, 'assigned'"),
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
    const lifecyclePaths = [
      START,
      STOP,
      HEALTH,
      UNINSTALL,
      HOST,
      INSTALL,
      UPGRADE,
      MODULE,
      BOOTSTRAP,
    ];
    const [start, stop, health, uninstall, ...allOtherSources] = await Promise.all(
      lifecyclePaths.map((path) => readFile(path, "utf8")),
    );
    for (const source of [start, stop, health, uninstall, ...allOtherSources]) {
      expect(source).not.toContain("Split-Path -LiteralPath");
    }
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
