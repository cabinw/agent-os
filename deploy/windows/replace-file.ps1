#requires -Version 7.4
param(
  [Parameter(Mandatory)][string]$CandidatePath,
  [Parameter(Mandatory)][string]$TargetPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'AgentOS.Windows.psm1') -Force

$candidate = Assert-AgentOSFixedPath -Path $CandidatePath -Kind File
if ([IO.Path]::GetDirectoryName($CandidatePath) -cne [IO.Path]::GetDirectoryName($TargetPath)) {
  throw 'Windows durable candidate and target must share one directory'
}
if (Test-Path -LiteralPath $TargetPath) {
  $null = Assert-AgentOSFixedPath -Path $TargetPath -Kind File
}
if (-not ('AgentOS.Windows.DurableReplace' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace AgentOS.Windows {
  public static class DurableReplace {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool ReplaceFile(string replaced, string replacement, string backup, uint flags, IntPtr exclude, IntPtr reserved);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool MoveFileEx(string existing, string destination, uint flags);
    public static void Publish(string candidate, string target, bool exists) {
      bool ok = exists
        ? ReplaceFile(target, candidate, null, 0x00000001, IntPtr.Zero, IntPtr.Zero)
        : MoveFileEx(candidate, target, 0x00000001 | 0x00000008);
      if (!ok) throw new Win32Exception();
    }
  }
}
'@
}
[AgentOS.Windows.DurableReplace]::Publish(
  $CandidatePath,
  $TargetPath,
  (Test-Path -LiteralPath $TargetPath)
)
$null = Assert-AgentOSFixedPath -Path $TargetPath -Kind File
if (Test-Path -LiteralPath $CandidatePath) {
  throw 'Windows durable candidate remained after publication'
}
