#requires -Version 7.4
param(
  [Parameter(Mandatory)][string]$ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'AgentOS.Windows.psm1') -Force

if (-not ('AgentOS.Windows.Job' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentOS.Windows {
  public sealed class ChildProcess : IDisposable {
    private IntPtr handle;
    internal ChildProcess(IntPtr processHandle) { handle = processHandle; }
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    public int WaitForExit() {
      uint wait = WaitForSingleObject(handle, 0xffffffff);
      if (wait != 0) throw new Win32Exception();
      uint exitCode;
      if (!GetExitCodeProcess(handle, out exitCode)) throw new Win32Exception();
      return unchecked((int)exitCode);
    }
    public void Dispose() {
      if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
    }
  }
  public sealed class Job : IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
      public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits { public BasicLimits BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct StartupInfo {
      public uint cb;
      public string reserved, desktop, title;
      public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
      public ushort showWindow, reserved2;
      public IntPtr reservedBytes, stdInput, stdOutput, stdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation {
      public IntPtr process, thread;
      public uint processId, threadId;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool CreateProcess(
      string applicationName, StringBuilder commandLine, IntPtr processAttributes,
      IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
      IntPtr environment, string currentDirectory, ref StartupInfo startupInfo,
      out ProcessInformation processInformation
    );
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private IntPtr handle;
    public Job() {
      handle = CreateJobObject(IntPtr.Zero, null);
      if (handle == IntPtr.Zero) throw new Win32Exception();
      var limits = new ExtendedLimits();
      limits.BasicLimitInformation.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE
      int size = Marshal.SizeOf(limits);
      IntPtr ptr = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(limits, ptr, false);
        if (!SetInformationJobObject(handle, 9, ptr, (uint)size)) throw new Win32Exception();
      } finally { Marshal.FreeHGlobal(ptr); }
    }
    public static string QuoteArgument(string value) {
      if (value == null) throw new ArgumentNullException("value");
      if (value.Length == 0) return "\"\"";
      if (!value.Any(character => char.IsWhiteSpace(character) || character == '\"')) {
        return value;
      }
      var quoted = new StringBuilder("\"");
      int backslashes = 0;
      foreach (char character in value) {
        if (character == '\\') {
          backslashes++;
          continue;
        }
        if (character == '\"') {
          quoted.Append('\\', backslashes * 2 + 1);
          quoted.Append('\"');
        } else {
          quoted.Append('\\', backslashes);
          quoted.Append(character);
        }
        backslashes = 0;
      }
      quoted.Append('\\', backslashes * 2);
      quoted.Append('\"');
      return quoted.ToString();
    }
    public static void AssertQuotingContract() {
      var cases = new Dictionary<string, string> {
        { "C:\\AgentOS\\worker.mjs", "C:\\AgentOS\\worker.mjs" },
        { "C:\\Program Files\\Agent OS\\worker.mjs", "\"C:\\Program Files\\Agent OS\\worker.mjs\"" },
        { "C:\\Program Files\\Agent OS\\", "\"C:\\Program Files\\Agent OS\\\\\"" },
        { "C:\\Agent \"Blue\"\\worker.mjs", "\"C:\\Agent \\\"Blue\\\"\\worker.mjs\"" }
      };
      foreach (var item in cases) {
        if (QuoteArgument(item.Key) != item.Value) {
          throw new InvalidOperationException("Windows command-line quoting contract failed");
        }
      }
    }
    public ChildProcess StartSuspended(
      string fileName, string argument, string workingDirectory,
      IDictionary<string, string> environment, Action<string> observe
    ) {
      const uint CREATE_SUSPENDED = 0x00000004;
      const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
      var environmentBlock = string.Join("\0", environment
        .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
        .Select(pair => pair.Key + "=" + pair.Value)) + "\0\0";
      IntPtr environmentPointer = Marshal.StringToHGlobalUni(environmentBlock);
      var startup = new StartupInfo();
      startup.cb = (uint)Marshal.SizeOf(startup);
      var commandLine = new StringBuilder(
        QuoteArgument(fileName) + " " + QuoteArgument(argument)
      );
      ProcessInformation created;
      try {
        if (!CreateProcess(
          fileName, commandLine, IntPtr.Zero, IntPtr.Zero, false,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, environmentPointer,
          workingDirectory, ref startup, out created
        )) throw new Win32Exception();
      } finally {
        Marshal.FreeHGlobal(environmentPointer);
      }
      try {
        observe?.Invoke("created-suspended");
        if (!AssignProcessToJobObject(handle, created.process)) throw new Win32Exception();
        observe?.Invoke("assigned");
        if (ResumeThread(created.thread) == 0xffffffff) throw new Win32Exception();
        observe?.Invoke("resumed");
        var child = new ChildProcess(created.process);
        created.process = IntPtr.Zero;
        return child;
      } catch {
        if (created.process != IntPtr.Zero) TerminateProcess(created.process, 1);
        throw;
      } finally {
        CloseHandle(created.thread);
        if (created.process != IntPtr.Zero) CloseHandle(created.process);
      }
    }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
  }
}
'@
}

$null = Assert-AgentOSFixedPath -Path $ConfigPath -Kind File
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$workerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
Assert-AgentOSWorkerReadAcl -Path ([IO.Path]::GetDirectoryName($ConfigPath)) -WorkerSid $workerSid
Assert-AgentOSWorkerReadAcl -Path $ConfigPath -WorkerSid $workerSid
$workerReleaseRoot = Assert-AgentOSConfiguredWorkerRelease -Config $config -WorkerSid $workerSid

$agentRoot = Get-AgentOSRoot
$expectedConfig = Join-Path $agentRoot 'config\worker.json'
if ($ConfigPath -cne $expectedConfig) { throw 'Worker config is outside the fixed Agent OS root' }
$nodePath = [string]$config.nodePath
$workerEntry = [string]$config.workerEntry
$runtimeRoot = [string]$config.runtimeRoot
$workingDirectory = [string]$config.workingDirectory
$null = Assert-AgentOSTrustedExecutable -Path $nodePath -WorkerSid $workerSid
$null = Assert-AgentOSTrustedExecutable -Path $workerEntry -WorkerSid $workerSid
$null = Assert-AgentOSFixedPath -Path $runtimeRoot -Kind Directory
if (-not (Test-AgentOSContainedPath -Root $workerReleaseRoot -Path $workerEntry)) {
  throw 'Worker entry is outside a protected Agent OS release'
}
if ($runtimeRoot -cne (Join-Path $agentRoot 'run')) {
  throw 'Worker runtime root is outside the fixed Agent OS root'
}
$null = Assert-AgentOSFixedPath -Path $workingDirectory -Kind Directory
if ($workingDirectory -cne $workerReleaseRoot -and
    -not (Test-AgentOSContainedPath -Root $workerReleaseRoot -Path $workingDirectory)) {
  throw 'Worker working directory is outside a protected Agent OS release'
}
Assert-AgentOSPrivateAcl -Path $runtimeRoot -WorkerSid $workerSid

$allowedEnvironment = [Collections.Generic.HashSet[string]]::new(
  [string[]]@(
    'AGENT_CWD', 'SESSION_PATH', 'AGENT_OS_AGENT_TOKENS',
    'AGENT_OS_CLAUDE_BIN', 'AGENT_OS_CODEX_BIN', 'AGENT_OS_CREDENTIAL_ROOT',
    'AGENT_OS_ENABLED_ADAPTERS',
    'AGENT_OS_GROK_BIN', 'AGENT_OS_KIMI_BIN', 'AGENT_OS_RUNNER_ID',
    'AGENT_OS_PWSH_BIN', 'AGENT_OS_RUNNER_TOKEN', 'AGENT_OS_URL',
    'AGENT_OS_WINDOWS_REPLACE_SCRIPT'
  ),
  [StringComparer]::Ordinal
)
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $nodePath
$start.ArgumentList.Add($workerEntry)
$start.UseShellExecute = $false
$start.WorkingDirectory = $workingDirectory
$start.Environment.Clear()
foreach ($name in @('SystemRoot', 'WINDIR', 'TEMP', 'TMP')) {
  if ([Environment]::GetEnvironmentVariable($name)) {
    $start.Environment[$name] = [Environment]::GetEnvironmentVariable($name)
  }
}
foreach ($property in $config.environment.PSObject.Properties) {
  if (-not $allowedEnvironment.Contains($property.Name) -or
      -not ($property.Value -is [string]) -or [string]::IsNullOrEmpty($property.Value)) {
    throw "Worker environment contains a forbidden or empty value"
  }
  $start.Environment[$property.Name] = [string]$property.Value
}
$expectedEnvironmentPaths = @{
  AGENT_CWD = (Join-Path $agentRoot 'workspaces')
  SESSION_PATH = (Join-Path $agentRoot 'state\runner-sessions.json')
  AGENT_OS_CREDENTIAL_ROOT = (Join-Path $agentRoot 'state\credentials')
}
foreach ($pair in $expectedEnvironmentPaths.GetEnumerator()) {
  if ($start.Environment[$pair.Key] -cne $pair.Value) {
    throw "Worker environment path is outside the fixed Agent OS root: $($pair.Key)"
  }
}
$adapterExecutables = @{
  claude = 'AGENT_OS_CLAUDE_BIN'
  codex = 'AGENT_OS_CODEX_BIN'
  grok = 'AGENT_OS_GROK_BIN'
  kimi = 'AGENT_OS_KIMI_BIN'
}
$enabledAdapters = @($adapterExecutables.Keys)
if ($start.Environment.ContainsKey('AGENT_OS_ENABLED_ADAPTERS')) {
  try {
    $parsedAdapters = ConvertFrom-Json `
      -InputObject $start.Environment['AGENT_OS_ENABLED_ADAPTERS'] -NoEnumerate
  } catch {
    throw 'AGENT_OS_ENABLED_ADAPTERS must be a JSON array'
  }
  if (-not ($parsedAdapters -is [Array])) {
    throw 'AGENT_OS_ENABLED_ADAPTERS must be a JSON array'
  }
  $enabledAdapters = @($parsedAdapters)
}
if ($enabledAdapters.Count -eq 0 -or
    @($enabledAdapters | Where-Object { -not ($_ -is [string]) -or -not $adapterExecutables.ContainsKey($_) }).Count -ne 0 -or
    @($enabledAdapters | Sort-Object -Unique).Count -ne $enabledAdapters.Count) {
  throw 'AGENT_OS_ENABLED_ADAPTERS must contain unique available adapter ids'
}
foreach ($adapter in $enabledAdapters) {
  $name = $adapterExecutables[$adapter]
  $null = Assert-AgentOSTrustedExecutable -Path $start.Environment[$name] -WorkerSid $workerSid
}
$null = Assert-AgentOSTrustedExecutable -Path $start.Environment['AGENT_OS_PWSH_BIN'] -WorkerSid $workerSid
$null = Assert-AgentOSTrustedExecutable -Path $start.Environment['AGENT_OS_WINDOWS_REPLACE_SCRIPT'] -WorkerSid $workerSid
Assert-AgentOSRuntimeArchitecture `
  -DeclaredHostMachine ([string]$config.hostArchitecture) `
  -DeclaredWorkerMachine ([string]$config.workerArchitecture) `
  -AssetPaths @(
    $start.Environment['AGENT_OS_PWSH_BIN'],
    $nodePath,
    $start.Environment['AGENT_OS_GROK_BIN']
  )

$gate = Join-Path $runtimeRoot 'job-assigned.gate'
$null = Assert-AgentOSFixedPath -Path $gate -Kind File
Assert-AgentOSPrivateAcl -Path $gate -WorkerSid $workerSid
[IO.File]::WriteAllText($gate, 'pending', [Text.UTF8Encoding]::new($false))
$start.Environment['AGENT_OS_JOB_ASSIGNMENT_GATE'] = $gate
[AgentOS.Windows.Job]::AssertQuotingContract()
$job = [AgentOS.Windows.Job]::new()
$process = $null
try {
  $process = $job.StartSuspended(
    $start.FileName,
    $workerEntry,
    $start.WorkingDirectory,
    $start.Environment,
    $null
  )
  [IO.File]::WriteAllText($gate, 'assigned', [Text.UTF8Encoding]::new($false))
  $exitCode = $process.WaitForExit()
  exit $exitCode
} finally {
  if ($process) { $process.Dispose() }
  $job.Dispose()
  if (Test-Path -LiteralPath $gate) {
    [IO.File]::WriteAllText($gate, 'closed', [Text.UTF8Encoding]::new($false))
  }
}
