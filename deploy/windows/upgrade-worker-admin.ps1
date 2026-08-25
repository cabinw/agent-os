#requires -Version 7.4
param(
  [string]$TaskName = 'AgentOS Worker',
  [Parameter(Mandatory)][string]$WorkerAccount,
  [Parameter(Mandatory)][PSCredential]$WorkerCredential,
  [Parameter(Mandatory)][string]$PowerShellPath,
  [Parameter(Mandatory)][string]$CurrentHostPath,
  [Parameter(Mandatory)][string]$ConfigPath,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedAdminSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'AgentOS.Windows.psm1') -Force

$account = Get-LocalUser -Name $WorkerAccount -ErrorAction Stop
if (-not $account.Enabled) { throw 'Agent OS Worker account must be enabled' }
$workerSid = $account.Sid
if ($WorkerCredential.UserName -cne $WorkerAccount) {
  throw 'Worker credential identity does not match WorkerAccount'
}
$null = Assert-AgentOSTrustedExecutable -Path $PowerShellPath -WorkerSid $workerSid
$null = Assert-AgentOSFixedPath -Path $ConfigPath -Kind File
Assert-AgentOSWorkerReadAcl -Path (Split-Path -LiteralPath $ConfigPath -Parent) -WorkerSid $workerSid
Assert-AgentOSWorkerReadAcl -Path $ConfigPath -WorkerSid $workerSid
$runtimeConfig = try {
  Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  throw 'Worker secret configuration is invalid'
}
$nodePath = [string]$runtimeConfig.nodePath
$grokPath = [string]$runtimeConfig.environment.AGENT_OS_GROK_BIN
$configuredPowerShellPath = [string]$runtimeConfig.environment.AGENT_OS_PWSH_BIN
if ($configuredPowerShellPath -cne $PowerShellPath) {
  throw 'Worker PowerShell path does not match the fixed task executable'
}
foreach ($executable in @($nodePath, $grokPath, $configuredPowerShellPath)) {
  $null = Assert-AgentOSTrustedExecutable -Path $executable -WorkerSid $workerSid
}
Assert-AgentOSRuntimeArchitecture `
  -DeclaredHostMachine ([string]$runtimeConfig.hostArchitecture) `
  -DeclaredWorkerMachine ([string]$runtimeConfig.workerArchitecture) `
  -AssetPaths @($configuredPowerShellPath, $nodePath, $grokPath)

$adminFiles = @(
  'AgentOS.Architecture.ps1', 'AgentOS.Windows.psm1',
  'health-worker.ps1', 'start-worker.ps1',
  'replace-file.ps1', 'stop-worker.ps1', 'uninstall-worker.ps1',
  'upgrade-worker-admin.ps1', 'worker-host.ps1'
)
if ((Get-AgentOSTreeDigest -Root $PSScriptRoot -Files $adminFiles) -cne $ExpectedAdminSha256) {
  throw 'Windows Worker admin source digest does not match the approved release'
}

$root = Get-AgentOSRoot
$null = Assert-AgentOSFixedPath -Path $root -Kind Directory
$releasesRoot = Join-Path $root 'releases'
$null = Assert-AgentOSFixedPath -Path $releasesRoot -Kind Directory
$releaseRoot = Join-Path $releasesRoot "worker-admin-$ExpectedAdminSha256"
$stage = Join-Path $releasesRoot ".worker-admin-$ExpectedAdminSha256.upgrading"
$newHostPath = Join-Path $releaseRoot 'worker-host.ps1'
$journalPath = Join-Path $root ".upgrade-worker-admin-$ExpectedAdminSha256.json"
$journalCandidate = Join-Path $root ".upgrade-worker-admin-$ExpectedAdminSha256.json.candidate"
$phaseOrder = @('prepared', 'task_switched', 'verified', 'committed')

function Read-UpgradeJournalRecord {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][bool]$RequireCurrentEndpoint
  )
  $null = Assert-AgentOSFixedPath -Path $Path -Kind File
  Assert-AgentOSAdminAcl -Path $Path
  try {
    $record = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw 'Windows Worker admin upgrade journal is invalid'
  }
  $keys = @($record.PSObject.Properties.Name | Sort-Object)
  if (($keys -join ',') -cne 'configPath,kind,newAdminSha256,oldHostPath,phase,taskName,version,workerSid' -or
      $record.version -ne 1 -or $record.kind -cne 'upgrade-worker-admin' -or
      $record.taskName -cne $TaskName -or $record.workerSid -cne $workerSid.Value -or
      $record.configPath -cne $ConfigPath -or
      ([string]$record.newAdminSha256) -notmatch '^[a-f0-9]{64}$' -or
      -not [IO.Path]::IsPathFullyQualified([string]$record.oldHostPath) -or
      [IO.Path]::GetFullPath([string]$record.oldHostPath) -cne [string]$record.oldHostPath -or
      $record.phase -notin $phaseOrder) {
    throw 'Windows Worker admin upgrade journal is invalid'
  }
  if ($RequireCurrentEndpoint -and
      ($record.oldHostPath -cne $CurrentHostPath -or
       $record.newAdminSha256 -cne $ExpectedAdminSha256)) {
    throw 'existing Windows Worker admin upgrade journal does not match this transaction'
  }
  return $record
}

foreach ($historyPath in @(Get-ChildItem -LiteralPath $root -Force |
    Where-Object { $_.Name -match '^\.upgrade-worker-admin-[a-f0-9]{64}\.json$' } |
    ForEach-Object FullName)) {
  if ($historyPath -cne $journalPath) {
    $history = Read-UpgradeJournalRecord -Path $historyPath -RequireCurrentEndpoint $false
    if ($history.phase -cne 'committed' -or
        (Split-Path -Leaf $historyPath) -cne ".upgrade-worker-admin-$($history.newAdminSha256).json") {
      throw 'another Windows Worker admin upgrade journal is unfinished or misbound'
    }
    $historyRelease = Join-Path $releasesRoot "worker-admin-$($history.newAdminSha256)"
    if ((Get-AgentOSTreeDigest -Root $historyRelease -Files $adminFiles) -cne
        [string]$history.newAdminSha256) {
      throw 'historical Windows Worker admin release digest changed'
    }
    Assert-AgentOSReleaseTree -Path $historyRelease -WorkerSid $workerSid
  }
}
$foreignCandidates = @(Get-ChildItem -LiteralPath $root -Force |
  Where-Object {
    $_.Name -match '^\.upgrade-worker-admin-[a-f0-9]{64}\.json\.candidate$' -and
    $_.FullName -cne $journalCandidate
  })
if ($foreignCandidates.Count -ne 0) {
  throw 'another Windows Worker admin upgrade journal candidate exists'
}

$journal = if (Test-Path -LiteralPath $journalPath) {
  Read-UpgradeJournalRecord -Path $journalPath -RequireCurrentEndpoint $true
} else { $null }
$candidateJournal = if (Test-Path -LiteralPath $journalCandidate) {
  $null = Assert-AgentOSFixedPath -Path $journalCandidate -Kind File
  Set-AgentOSAdminAcl -Path $journalCandidate
  Read-UpgradeJournalRecord -Path $journalCandidate -RequireCurrentEndpoint $true
} else { $null }
if ($candidateJournal) {
  $candidateIndex = $phaseOrder.IndexOf([string]$candidateJournal.phase)
  $journalIndex = if ($journal) { $phaseOrder.IndexOf([string]$journal.phase) } else { -1 }
  if (($journalIndex -eq -1 -and $candidateIndex -ne 0) -or
      ($journalIndex -ge 0 -and
       $candidateIndex -notin @($journalIndex, $journalIndex + 1))) {
    throw 'Windows Worker admin upgrade journal candidate has an invalid phase transition'
  }
  & (Join-Path $PSScriptRoot 'replace-file.ps1') `
    -CandidatePath $journalCandidate -TargetPath $journalPath
  Assert-AgentOSAdminAcl -Path $journalPath
  $journal = $candidateJournal
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
if ($task.State -eq 'Running') { throw 'Windows Worker admin upgrade requires a stopped task' }
$relatedProcesses = @(Get-AgentOSWorkerProcesses -ConfigPath $ConfigPath)
if ($relatedProcesses.Count -ne 0) {
  throw 'Windows Worker admin upgrade requires zero related processes'
}

function Test-UpgradeTaskAction {
  param([Parameter(Mandatory)][string]$HostPath)
  try {
    $null = Assert-AgentOSWorkerTask -TaskName $TaskName -WorkerAccount $WorkerAccount `
      -PowerShellPath $PowerShellPath -HostPath $HostPath -ConfigPath $ConfigPath
    return $true
  } catch {
    return $false
  }
}

$taskUsesOldRelease = Test-UpgradeTaskAction -HostPath $CurrentHostPath
$taskUsesNewRelease = Test-UpgradeTaskAction -HostPath $newHostPath
if (-not $journal -and -not $taskUsesOldRelease) {
  throw 'Windows Worker admin upgrade initial task does not match the approved old release'
}
if ($journal -and -not $taskUsesOldRelease -and -not $taskUsesNewRelease) {
  throw 'Windows Worker admin upgrade task matches neither journal endpoint'
}

function Write-UpgradeJournal {
  param([Parameter(Mandatory)][string]$Phase)
  $record = [ordered]@{
    version = 1; kind = 'upgrade-worker-admin'; taskName = $TaskName
    workerSid = $workerSid.Value; oldHostPath = $CurrentHostPath
    configPath = $ConfigPath; newAdminSha256 = $ExpectedAdminSha256; phase = $Phase
  }
  if (Test-Path -LiteralPath $journalCandidate) {
    $null = Assert-AgentOSFixedPath -Path $journalCandidate -Kind File
    Assert-AgentOSAdminAcl -Path $journalCandidate
    Remove-Item -LiteralPath $journalCandidate -Force
  }
  [IO.File]::WriteAllText(
    $journalCandidate,
    (($record | ConvertTo-Json -Compress) + "`n"),
    [Text.UTF8Encoding]::new($false)
  )
  Set-AgentOSAdminAcl -Path $journalCandidate
  & (Join-Path $PSScriptRoot 'replace-file.ps1') `
    -CandidatePath $journalCandidate -TargetPath $journalPath
  Assert-AgentOSAdminAcl -Path $journalPath
  $script:journal = [PSCustomObject]$record
}

function Advance-UpgradeJournal {
  param([Parameter(Mandatory)][string]$Phase)
  if ($phaseOrder.IndexOf([string]$journal.phase) -lt $phaseOrder.IndexOf($Phase)) {
    Write-UpgradeJournal -Phase $Phase
  }
}

if ($journal -and $journal.phase -eq 'committed') {
  if (-not $taskUsesNewRelease) {
    throw 'committed Windows Worker admin upgrade task changed'
  }
  if ((Get-AgentOSTreeDigest -Root $releaseRoot -Files $adminFiles) -cne $ExpectedAdminSha256) {
    throw 'committed Windows Worker admin release changed'
  }
  Assert-AgentOSReleaseTree -Path $releaseRoot -WorkerSid $workerSid
  if ((Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $journalCandidate)) {
    throw 'committed Windows Worker admin upgrade has residual staging artifacts'
  }
  Write-Output '{"component":"agent-os-worker","adminUpgraded":true,"taskStopped":true,"alreadyCommitted":true}'
  exit 0
}

if (-not $journal) {
  Write-UpgradeJournal -Phase prepared
}

if (-not (Test-Path -LiteralPath $releaseRoot)) {
  if (-not (Test-Path -LiteralPath $stage)) {
    $null = New-Item -ItemType Directory -Path $stage
    Set-AgentOSAdminAcl -Path $stage
  } else {
    $null = Assert-AgentOSFixedPath -Path $stage -Kind Directory
    Assert-AgentOSAdminAcl -Path $stage
  }
  foreach ($relative in $adminFiles) {
    $source = Join-Path $PSScriptRoot $relative
    $destination = Join-Path $stage $relative
    if (Test-Path -LiteralPath $destination) {
      $null = Assert-AgentOSFixedPath -Path $destination -Kind File
      Assert-AgentOSAdminAcl -Path $destination
      if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -cne
          (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash) {
        throw 'Windows Worker staged upgrade file changed during retry'
      }
    } else {
      Copy-Item -LiteralPath $source -Destination $destination
      Set-AgentOSAdminAcl -Path $destination
    }
  }
  if ((Get-AgentOSTreeDigest -Root $stage -Files $adminFiles) -cne $ExpectedAdminSha256) {
    throw 'Windows Worker staged admin release digest changed'
  }
  Set-AgentOSReleaseAcl -Path $stage -WorkerSid $workerSid
  [IO.Directory]::Move($stage, $releaseRoot)
} elseif (Test-Path -LiteralPath $stage) {
  throw 'Windows Worker admin upgrade has both installed and staged releases'
}
if ((Get-AgentOSTreeDigest -Root $releaseRoot -Files $adminFiles) -cne $ExpectedAdminSha256) {
  throw 'Windows Worker installed admin release digest changed'
}
Assert-AgentOSReleaseTree -Path $releaseRoot -WorkerSid $workerSid

$newAction = New-ScheduledTaskAction -Execute $PowerShellPath -Argument (
  '-NoLogo -NoProfile -NonInteractive -File "{0}" -ConfigPath "{1}"' -f $newHostPath, $ConfigPath
)
$newTask = New-ScheduledTask -Action $newAction -Trigger $task.Triggers `
  -Settings $task.Settings -Principal $task.Principal

if (-not $taskUsesNewRelease) {
  Register-ScheduledTask -TaskName $TaskName -InputObject $newTask `
    -User $WorkerCredential.UserName `
    -Password $WorkerCredential.GetNetworkCredential().Password `
    -Force | Out-Null
}
$null = Assert-AgentOSWorkerTask -TaskName $TaskName -WorkerAccount $WorkerAccount `
  -PowerShellPath $PowerShellPath -HostPath $newHostPath -ConfigPath $ConfigPath
Advance-UpgradeJournal -Phase task_switched

$verifiedTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
if ($verifiedTask.State -eq 'Running') {
  throw 'Windows Worker admin upgrade unexpectedly started the task'
}
if (@(Get-AgentOSWorkerProcesses -ConfigPath $ConfigPath).Count -ne 0) {
  throw 'Windows Worker admin upgrade left a related process'
}
Advance-UpgradeJournal -Phase verified
Advance-UpgradeJournal -Phase committed

Write-Output '{"component":"agent-os-worker","adminUpgraded":true,"taskStopped":true}'
