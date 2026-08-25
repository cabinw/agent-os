# Windows PowerShell 5.1 bootstrap only. All operational scripts require 7.4.
#requires -Version 5.1
param(
  [Parameter(Mandatory)][string]$MsiPath,
  [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedMsiSha256,
  [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedPwshSha256,
  [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$ExpectedSignerThumbprint
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$fixedPwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'

if (-not ('AgentOS.Windows.BootstrapFile' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace AgentOS.Windows {
  public static class BootstrapFile {
    [StructLayout(LayoutKind.Sequential)]
    private struct Info {
      public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, AccessTime, WriteTime;
      public uint VolumeSerial, SizeHigh, SizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    public static uint LinkCount(string path) {
      using (var handle = CreateFile(path, 0x80, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Win32Exception();
        Info info; if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception();
        return info.NumberOfLinks;
      }
    }
  }
}
'@
}

function Assert-BootstrapFile {
  param([Parameter(Mandatory)][string]$Path)
  if (-not [IO.Path]::IsPathRooted($Path) -or [IO.Path]::GetFullPath($Path) -cne $Path) {
    throw 'PowerShell bootstrap path must be canonical and absolute'
  }
  $cursor = $Path
  while ($cursor) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'PowerShell bootstrap path ancestry contains a reparse point'
    }
    $parent = Split-Path -LiteralPath $cursor -Parent
    if (-not $parent -or $parent -ceq $cursor) { break }
    $cursor = $parent
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or
      [AgentOS.Windows.BootstrapFile]::LinkCount($Path) -ne 1) {
    throw 'PowerShell bootstrap file must be a single-link regular file'
  }
}

function Assert-ApprovedMsi {
  param([Parameter(Mandatory)][string]$Path)
  Assert-BootstrapFile -Path $Path
  if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -cne $ExpectedMsiSha256.ToUpperInvariant()) {
    throw 'PowerShell MSI digest does not match the approved package'
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne 'Valid' -or
      $signature.SignerCertificate.Thumbprint -cne $ExpectedSignerThumbprint.ToUpperInvariant()) {
    throw 'PowerShell MSI does not have the approved Authenticode signer'
  }
}

function Set-BootstrapAcl {
  param([Parameter(Mandatory)][string]$Path)
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { $null = $acl.RemoveAccessRuleAll($rule) }
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $identity = New-Object -TypeName Security.Principal.SecurityIdentifier -ArgumentList $sid
    $inheritance = if (Test-Path -LiteralPath $Path -PathType Container) {
      [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else { [Security.AccessControl.InheritanceFlags]::None }
    $rule = New-Object -TypeName Security.AccessControl.FileSystemAccessRule -ArgumentList @(
      $identity,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-BootstrapAcl {
  param([Parameter(Mandatory)][string]$Path)
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) { throw 'PowerShell bootstrap ACL inheritance is enabled' }
  $expected = @('S-1-5-18', 'S-1-5-32-544')
  $actual = @($acl.Access | ForEach-Object {
    if ($_.AccessControlType -ne 'Allow' -or
        ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
          [Security.AccessControl.FileSystemRights]::FullControl) {
      throw 'PowerShell bootstrap ACL is not full-control allow-only'
    }
    $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  } | Sort-Object -Unique)
  if (($actual -join ',') -cne (($expected | Sort-Object) -join ',')) {
    throw 'PowerShell bootstrap ACL contains an unauthorized principal'
  }
}

function Assert-FixedPwsh {
  if (-not (Test-Path -LiteralPath $fixedPwsh -PathType Leaf)) {
    throw 'fixed PowerShell 7.4 executable is not installed'
  }
  Assert-BootstrapFile -Path $fixedPwsh
  $hash = (Get-FileHash -LiteralPath $fixedPwsh -Algorithm SHA256).Hash
  if ($hash -cne $ExpectedPwshSha256.ToUpperInvariant()) {
    throw 'fixed PowerShell executable digest changed'
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $fixedPwsh
  if ($signature.Status -ne 'Valid' -or
      $signature.SignerCertificate.Thumbprint -cne $ExpectedSignerThumbprint.ToUpperInvariant()) {
    throw 'fixed PowerShell executable signer changed'
  }
  $version = & $fixedPwsh -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()'
  if ([Version]$version -lt [Version]'7.4.0' -or [Version]$version -ge [Version]'8.0.0') {
    throw 'fixed PowerShell executable is outside the audited 7.4 release line'
  }
}

if (Test-Path -LiteralPath $fixedPwsh) {
  Assert-FixedPwsh
  Write-Output 'agent-os powershell bootstrap already satisfied'
  exit 0
}
Assert-ApprovedMsi -Path $MsiPath
$stageRoot = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'AgentOSBootstrap'
if (-not (Test-Path -LiteralPath $stageRoot)) { $null = New-Item -ItemType Directory -Path $stageRoot }
Set-BootstrapAcl -Path $stageRoot
Assert-BootstrapAcl -Path $stageRoot
$stagePath = Join-Path $stageRoot ("PowerShell-$($ExpectedMsiSha256.ToLowerInvariant()).msi")
if (Test-Path -LiteralPath $stagePath) {
  Assert-ApprovedMsi -Path $stagePath
} else {
  $candidate = "$stagePath.copying"
  if (Test-Path -LiteralPath $candidate) {
    Assert-BootstrapFile -Path $candidate
    Remove-Item -LiteralPath $candidate -Force
  }
  Copy-Item -LiteralPath $MsiPath -Destination $candidate
  Set-BootstrapAcl -Path $candidate
  Assert-BootstrapAcl -Path $candidate
  Assert-ApprovedMsi -Path $candidate
  [IO.File]::Move($candidate, $stagePath)
  Assert-ApprovedMsi -Path $stagePath
}
Assert-BootstrapAcl -Path $stagePath
$process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -Wait -PassThru `
  -ArgumentList @('/i', $stagePath, '/qn', '/norestart', 'ADD_PATH=0', 'ENABLE_PSREMOTING=0', 'USE_MU=0', 'ENABLE_MU=0')
if ($process.ExitCode -notin @(0, 3010)) { throw 'PowerShell MSI installation failed' }
Assert-ApprovedMsi -Path $stagePath
Assert-FixedPwsh
Write-Output 'agent-os powershell bootstrap installed audited 7.4 runtime'
