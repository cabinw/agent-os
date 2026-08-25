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
if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  $task = Assert-AgentOSWorkerTask -TaskName $TaskName -WorkerAccount $WorkerAccount `
    -PowerShellPath $PowerShellPath -HostPath $HostPath -ConfigPath $ConfigPath
  $processes = @(Get-AgentOSWorkerProcesses -ConfigPath $ConfigPath)
  if ($task.State -ne 'Running' -and $processes.Count -eq 0) {
    Write-Output '{"component":"agent-os-worker","stopped":true,"processes":0}'
    exit 0
  }
  if ([DateTime]::UtcNow -ge $deadline) {
    throw 'Agent OS Worker did not stop its complete process tree'
  }
  Start-Sleep -Milliseconds 250
} while ($true)
