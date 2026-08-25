#requires -Version 7.4
param(
  [string]$TaskName = 'AgentOS Worker',
  [Parameter(Mandatory)][string]$WorkerAccount,
  [Parameter(Mandatory)][string]$PowerShellPath,
  [Parameter(Mandatory)][string]$HostPath,
  [Parameter(Mandatory)][string]$ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'AgentOS.Windows.psm1') -Force

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  $null = Assert-AgentOSWorkerTask -TaskName $TaskName -WorkerAccount $WorkerAccount `
    -PowerShellPath $PowerShellPath -HostPath $HostPath -ConfigPath $ConfigPath
  & (Join-Path $PSScriptRoot 'stop-worker.ps1') -TaskName $TaskName `
    -WorkerAccount $WorkerAccount -PowerShellPath $PowerShellPath `
    -HostPath $HostPath -ConfigPath $ConfigPath
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  throw 'Agent OS Worker scheduled task still exists after uninstall'
}
Write-Output '{"component":"agent-os-worker","uninstalled":true,"dataPreserved":true}'
