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

$task = Assert-AgentOSWorkerTask -TaskName $TaskName -WorkerAccount $WorkerAccount `
  -PowerShellPath $PowerShellPath -HostPath $HostPath -ConfigPath $ConfigPath
if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $TaskName }
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  try {
    & (Join-Path $PSScriptRoot 'health-worker.ps1') -TaskName $TaskName `
      -WorkerAccount $WorkerAccount -PowerShellPath $PowerShellPath `
      -HostPath $HostPath -ConfigPath $ConfigPath
    exit 0
  } catch {
    if ([DateTime]::UtcNow -ge $deadline) { throw }
    Start-Sleep -Milliseconds 250
  }
} while ($true)
