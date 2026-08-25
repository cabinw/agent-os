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

$null = Assert-AgentOSFixedPath -Path $PowerShellPath -Kind File
$null = Assert-AgentOSFixedPath -Path $HostPath -Kind File
$null = Assert-AgentOSFixedPath -Path $ConfigPath -Kind File
$workerSid = ([Security.Principal.NTAccount]$WorkerAccount).Translate(
  [Security.Principal.SecurityIdentifier]
)
Assert-AgentOSWorkerReadAcl -Path ([IO.Path]::GetDirectoryName($ConfigPath)) -WorkerSid $workerSid
Assert-AgentOSWorkerReadAcl -Path $ConfigPath -WorkerSid $workerSid
$task = Assert-AgentOSWorkerTask -TaskName $TaskName -WorkerAccount $WorkerAccount `
  -PowerShellPath $PowerShellPath -HostPath $HostPath -ConfigPath $ConfigPath
if ($task.State -ne 'Running') { throw 'Agent OS Worker task is not running' }
$processes = @(Get-AgentOSWorkerProcesses -ConfigPath $ConfigPath)
if ($processes.Count -lt 2) {
  throw 'Agent OS Worker host and Node process were not both observed'
}
Write-Output '{"component":"agent-os-worker","ok":true}'
