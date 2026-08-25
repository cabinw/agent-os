#requires -Version 5.1
Set-StrictMode -Version Latest

if (-not ('AgentOS.Windows.Machine' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentOS.Windows {
  public static class Machine {
    public const ushort AMD64 = 0x8664;
    public const ushort ARM64 = 0xaa64;
    private const uint USER_ENABLED = 0x00000001;
    private const uint PID_TEMPLATE = 7;
    private const uint ERROR_MORE_DATA = 234;

    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool IsWow64Process2(
      IntPtr process, out ushort processMachine, out ushort nativeMachine
    );
    [DllImport("kernel32.dll")]
    private static extern int GetMachineTypeAttributes(
      ushort machine, out uint attributes
    );
    [DllImport("msi.dll", CharSet=CharSet.Unicode)]
    private static extern uint MsiGetSummaryInformation(
      IntPtr database, string databasePath, uint updateCount,
      out IntPtr summaryInformation
    );
    [DllImport("msi.dll", CharSet=CharSet.Unicode)]
    private static extern uint MsiSummaryInfoGetProperty(
      IntPtr summaryInformation, uint property, out uint dataType,
      out int integerValue, out System.Runtime.InteropServices.ComTypes.FILETIME fileTime,
      StringBuilder value, ref uint valueLength
    );
    [DllImport("msi.dll")]
    private static extern uint MsiCloseHandle(IntPtr handle);

    public static string Name(ushort machine) {
      if (machine == AMD64) return "AMD64";
      if (machine == ARM64) return "ARM64";
      return "unknown";
    }

    public static ushort ParseName(string machine) {
      if (string.Equals(machine, "AMD64", StringComparison.Ordinal)) return AMD64;
      if (string.Equals(machine, "ARM64", StringComparison.Ordinal)) return ARM64;
      return 0;
    }

    public static ushort PEMachine(string path) {
      using (var stream = new FileStream(
        path, FileMode.Open, FileAccess.Read, FileShare.Read
      )) {
        var header = new byte[4096];
        int count = stream.Read(header, 0, header.Length);
        if (count < 256 || header[0] != 0x4d || header[1] != 0x5a) return 0;
        int offset = BitConverter.ToInt32(header, 0x3c);
        if (offset < 0 || offset + 6 > count ||
            header[offset] != 0x50 || header[offset + 1] != 0x45 ||
            header[offset + 2] != 0 || header[offset + 3] != 0) return 0;
        return BitConverter.ToUInt16(header, offset + 4);
      }
    }

    public static ushort CurrentProcessMachine() {
      string executable = Process.GetCurrentProcess().MainModule.FileName;
      if (string.IsNullOrEmpty(executable)) return 0;
      return PEMachine(executable);
    }

    public static ushort NativeMachine() {
      ushort processMachine;
      ushort nativeMachine;
      if (!IsWow64Process2(
        Process.GetCurrentProcess().Handle, out processMachine, out nativeMachine
      )) throw new Win32Exception();
      return nativeMachine;
    }

    public static bool Amd64UserEmulationEnabled() {
      uint attributes;
      int result = GetMachineTypeAttributes(AMD64, out attributes);
      if (result != 0) throw new Win32Exception(result);
      return (attributes & USER_ENABLED) != 0;
    }

    public static ushort MsiMachine(string path) {
      IntPtr summary;
      uint result = MsiGetSummaryInformation(IntPtr.Zero, path, 0, out summary);
      if (result != 0 || summary == IntPtr.Zero) return 0;
      try {
        uint dataType;
        int integerValue;
        System.Runtime.InteropServices.ComTypes.FILETIME fileTime;
        // MsiSummaryInfoGetPropertyW explicitly forbids a null value buffer
        // when querying the required string length. A non-null empty buffer
        // returns ERROR_MORE_DATA and the required length (excluding NUL).
        var empty = new StringBuilder(1);
        uint length = 0;
        result = MsiSummaryInfoGetProperty(
          summary, PID_TEMPLATE, out dataType, out integerValue,
          out fileTime, empty, ref length
        );
        if (result != ERROR_MORE_DATA || length == 0) return 0;
        var value = new StringBuilder((int)length + 1);
        uint capacity = (uint)value.Capacity;
        result = MsiSummaryInfoGetProperty(
          summary, PID_TEMPLATE, out dataType, out integerValue,
          out fileTime, value, ref capacity
        );
        if (result != 0) return 0;
        return ParseMsiTemplate(value.ToString());
      } finally {
        MsiCloseHandle(summary);
      }
    }

    public static ushort ParseMsiTemplate(string template) {
      if (string.IsNullOrEmpty(template)) return 0;
      string platform = template.Split(';')[0];
      if (string.Equals(platform, "x64", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(platform, "Intel64", StringComparison.OrdinalIgnoreCase)) {
        return AMD64;
      }
      if (string.Equals(platform, "Arm64", StringComparison.OrdinalIgnoreCase)) {
        return ARM64;
      }
      return 0;
    }

    public static string ContractCode(
      ushort declaredHost, ushort declaredWorker, ushort nativeMachine,
      bool amd64Emulation, ushort processMachine, ushort[] assetMachines
    ) {
      if ((declaredHost != AMD64 && declaredHost != ARM64) ||
          declaredWorker != AMD64 || nativeMachine == 0 || processMachine == 0) {
        return "machine_unknown";
      }
      if (nativeMachine != declaredHost) return "host_machine_mismatch";
      if (nativeMachine == ARM64 && !amd64Emulation) return "amd64_emulation_unavailable";
      if (nativeMachine != AMD64 && nativeMachine != ARM64) return "host_machine_unsupported";
      if (processMachine != declaredWorker) return "process_machine_mismatch";
      if (assetMachines == null || assetMachines.Length == 0) return "machine_unknown";
      foreach (ushort assetMachine in assetMachines) {
        if (assetMachine == 0) return "machine_unknown";
        if (assetMachine != declaredWorker) return "asset_machine_mismatch";
      }
      return "ok";
    }
  }
}
'@
}

function Assert-AgentOSRuntimeArchitecture {
  param(
    [Parameter(Mandatory)][ValidateSet('AMD64', 'ARM64')][string]$DeclaredHostMachine,
    [Parameter(Mandatory)][ValidateSet('AMD64')][string]$DeclaredWorkerMachine,
    [Parameter(Mandatory)][string[]]$AssetPaths
  )

  try {
    $declaredHost = [AgentOS.Windows.Machine]::ParseName($DeclaredHostMachine)
    $declaredWorker = [AgentOS.Windows.Machine]::ParseName($DeclaredWorkerMachine)
    $nativeMachine = [AgentOS.Windows.Machine]::NativeMachine()
    $processMachine = [AgentOS.Windows.Machine]::CurrentProcessMachine()
    $emulation = if ($nativeMachine -eq [AgentOS.Windows.Machine]::ARM64) {
      [AgentOS.Windows.Machine]::Amd64UserEmulationEnabled()
    } else { $false }
    $assets = @($AssetPaths | ForEach-Object {
      [AgentOS.Windows.Machine]::PEMachine($_)
    })
    $code = [AgentOS.Windows.Machine]::ContractCode(
      $declaredHost, $declaredWorker, $nativeMachine,
      $emulation, $processMachine, $assets
    )
  } catch {
    throw 'Agent OS Windows architecture inspection failed'
  }
  if ($code -cne 'ok') {
    throw "Agent OS Windows architecture contract failed: $code"
  }
}

function Assert-AgentOSBootstrapArchitecture {
  param(
    [Parameter(Mandatory)][ValidateSet('AMD64', 'ARM64')][string]$DeclaredHostMachine,
    [Parameter(Mandatory)][ValidateSet('AMD64')][string]$DeclaredWorkerMachine,
    [Parameter(Mandatory)][string]$MsiPath
  )

  try {
    $declaredHost = [AgentOS.Windows.Machine]::ParseName($DeclaredHostMachine)
    $declaredWorker = [AgentOS.Windows.Machine]::ParseName($DeclaredWorkerMachine)
    $nativeMachine = [AgentOS.Windows.Machine]::NativeMachine()
    $emulation = if ($nativeMachine -eq [AgentOS.Windows.Machine]::ARM64) {
      [AgentOS.Windows.Machine]::Amd64UserEmulationEnabled()
    } else { $false }
    $msiMachine = [AgentOS.Windows.Machine]::MsiMachine($MsiPath)
  } catch {
    throw 'Agent OS Windows bootstrap architecture inspection failed'
  }
  if ($declaredWorker -ne [AgentOS.Windows.Machine]::AMD64 -or
      $nativeMachine -ne $declaredHost -or
      $msiMachine -ne $declaredWorker -or
      ($nativeMachine -eq [AgentOS.Windows.Machine]::ARM64 -and -not $emulation) -or
      $nativeMachine -notin @(
        [AgentOS.Windows.Machine]::AMD64,
        [AgentOS.Windows.Machine]::ARM64
      )) {
    throw 'Agent OS Windows bootstrap architecture contract failed'
  }
}

function Assert-AgentOSHostAssetArchitecture {
  param(
    [Parameter(Mandatory)][ValidateSet('AMD64', 'ARM64')][string]$DeclaredHostMachine,
    [Parameter(Mandatory)][ValidateSet('AMD64')][string]$DeclaredWorkerMachine,
    [Parameter(Mandatory)][string[]]$AssetPaths
  )
  try {
    $declaredHost = [AgentOS.Windows.Machine]::ParseName($DeclaredHostMachine)
    $declaredWorker = [AgentOS.Windows.Machine]::ParseName($DeclaredWorkerMachine)
    $nativeMachine = [AgentOS.Windows.Machine]::NativeMachine()
    $emulation = if ($nativeMachine -eq [AgentOS.Windows.Machine]::ARM64) {
      [AgentOS.Windows.Machine]::Amd64UserEmulationEnabled()
    } else { $false }
    $assets = @($AssetPaths | ForEach-Object {
      [AgentOS.Windows.Machine]::PEMachine($_)
    })
  } catch {
    throw 'Agent OS Windows host architecture inspection failed'
  }
  if ($declaredWorker -ne [AgentOS.Windows.Machine]::AMD64 -or
      $nativeMachine -ne $declaredHost -or
      ($nativeMachine -eq [AgentOS.Windows.Machine]::ARM64 -and -not $emulation) -or
      $nativeMachine -notin @(
        [AgentOS.Windows.Machine]::AMD64,
        [AgentOS.Windows.Machine]::ARM64
      ) -or
      $assets.Count -eq 0 -or
      @($assets | Where-Object { $_ -ne $declaredWorker }).Count -ne 0) {
    throw 'Agent OS Windows host architecture contract failed'
  }
}

function Assert-AgentOSPEMachine {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][ValidateSet('AMD64')][string]$ExpectedMachine
  )
  try {
    $actual = [AgentOS.Windows.Machine]::PEMachine($Path)
    $expected = [AgentOS.Windows.Machine]::ParseName($ExpectedMachine)
  } catch {
    throw 'Agent OS Windows executable architecture inspection failed'
  }
  if ($actual -eq 0 -or $actual -ne $expected) {
    throw 'Agent OS Windows executable architecture changed'
  }
}
