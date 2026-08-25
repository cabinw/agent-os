#requires -Version 7.4
param(
  [Parameter(Mandatory)][string]$WorkerAccount,
  [Parameter(Mandatory)][PSCredential]$WorkerCredential,
  [Parameter(Mandatory)][string]$PowerShellPath,
  [Parameter(Mandatory)][string]$SecretConfigSource,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedAdminSha256,
  [Parameter(Mandatory)][string]$WorkerReleaseSource,
  [Parameter(Mandatory)][string[]]$WorkerReleaseFiles,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedWorkerReleaseSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'AgentOS.Windows.psm1') -Force

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Agent OS Worker installation requires an elevated administrator token'
}
$workerSid = Assert-AgentOSWorkerAccount -WorkerAccount $WorkerAccount
if ($WorkerCredential.UserName -cne $WorkerAccount) {
  throw 'Worker credential identity does not match WorkerAccount'
}

$null = Assert-AgentOSTrustedExecutable -Path $PowerShellPath -WorkerSid $workerSid
$null = Assert-AgentOSFixedPath -Path $SecretConfigSource -Kind File
$sourceConfig = try {
  Get-Content -LiteralPath $SecretConfigSource -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  throw 'Worker secret configuration is invalid'
}
$nodePath = [string]$sourceConfig.nodePath
$grokPath = [string]$sourceConfig.environment.AGENT_OS_GROK_BIN
$configuredPowerShellPath = [string]$sourceConfig.environment.AGENT_OS_PWSH_BIN
if ($configuredPowerShellPath -cne $PowerShellPath) {
  throw 'Worker PowerShell path does not match the fixed task executable'
}
foreach ($executable in @($nodePath, $grokPath, $configuredPowerShellPath)) {
  $null = Assert-AgentOSTrustedExecutable -Path $executable -WorkerSid $workerSid
}
Assert-AgentOSRuntimeArchitecture `
  -DeclaredHostMachine ([string]$sourceConfig.hostArchitecture) `
  -DeclaredWorkerMachine ([string]$sourceConfig.workerArchitecture) `
  -AssetPaths @($configuredPowerShellPath, $nodePath, $grokPath)
$null = Assert-AgentOSFixedPath -Path $WorkerReleaseSource -Kind Directory
Assert-AgentOSAdminTree -Path $WorkerReleaseSource
$workerReleaseManifest = @(Get-AgentOSCanonicalReleaseManifest -Files $WorkerReleaseFiles)
$workerReleaseDigest = Get-AgentOSExactTreeDigest `
  -Root $WorkerReleaseSource -Files $workerReleaseManifest
if ($workerReleaseDigest -cne $ExpectedWorkerReleaseSha256) {
  throw 'Windows Worker runtime source digest does not match the approved release'
}
$adminFiles = @(
  'AgentOS.Architecture.ps1', 'AgentOS.Windows.psm1',
  'health-worker.ps1', 'start-worker.ps1',
  'replace-file.ps1', 'stop-worker.ps1', 'uninstall-worker.ps1',
  'upgrade-worker-admin.ps1', 'worker-host.ps1', 'worker-runtime.manifest'
)
$sourceDigest = Get-AgentOSTreeDigest -Root $PSScriptRoot -Files $adminFiles
if ($sourceDigest -cne $ExpectedAdminSha256) {
  throw 'Windows Worker admin source digest does not match the approved release'
}
$secretConfigSha256 = (Get-FileHash -LiteralPath $SecretConfigSource -Algorithm SHA256).Hash.ToLowerInvariant()
$root = Get-AgentOSRoot
$releasesRoot = Join-Path $root 'releases'
$releaseRoot = Join-Path $releasesRoot "worker-admin-$ExpectedAdminSha256"
$stage = Join-Path $releasesRoot ".worker-admin-$ExpectedAdminSha256.installing"
$workerRuntimeRoot = Join-Path $releasesRoot "worker-runtime-$ExpectedWorkerReleaseSha256"
$workerRuntimeStage = Join-Path $releasesRoot ".worker-runtime-$ExpectedWorkerReleaseSha256.installing"
$expectedWorkerEntry = [string]$sourceConfig.workerEntry
$expectedWorkingDirectory = [string]$sourceConfig.workingDirectory
$configWorkerReleaseManifest = @(Get-AgentOSCanonicalReleaseManifest `
  -Files @($sourceConfig.workerReleaseFiles | ForEach-Object { [string]$_ })
)
if (-not [IO.Path]::IsPathFullyQualified($expectedWorkerEntry) -or
    [IO.Path]::GetFullPath($expectedWorkerEntry) -cne $expectedWorkerEntry -or
    -not (Test-AgentOSContainedPath -Root $workerRuntimeRoot -Path $expectedWorkerEntry) -or
    [IO.Path]::GetRelativePath($workerRuntimeRoot, $expectedWorkerEntry) -cnotin $workerReleaseManifest -or
    -not [IO.Path]::IsPathFullyQualified($expectedWorkingDirectory) -or
    [IO.Path]::GetFullPath($expectedWorkingDirectory) -cne $expectedWorkingDirectory -or
    ($expectedWorkingDirectory -cne $workerRuntimeRoot -and
     -not (Test-AgentOSContainedPath -Root $workerRuntimeRoot -Path $expectedWorkingDirectory)) -or
    [string]$sourceConfig.workerReleaseSha256 -cne $ExpectedWorkerReleaseSha256 -or
    ($configWorkerReleaseManifest -join "`n") -cne ($workerReleaseManifest -join "`n")) {
  throw 'Worker configuration is not bound to the approved runtime release'
}
$sourceWorkerEntry = Join-Path $WorkerReleaseSource ([IO.Path]::GetRelativePath(
  $workerRuntimeRoot, $expectedWorkerEntry
))
$null = Assert-AgentOSFixedPath -Path $sourceWorkerEntry -Kind File
$sourceWorkingDirectory = if ($expectedWorkingDirectory -ceq $workerRuntimeRoot) {
  $WorkerReleaseSource
} else {
  Join-Path $WorkerReleaseSource ([IO.Path]::GetRelativePath(
    $workerRuntimeRoot, $expectedWorkingDirectory
  ))
}
$null = Assert-AgentOSFixedPath -Path $sourceWorkingDirectory -Kind Directory
$configPath = Join-Path $root 'config\worker.json'
$journalPath = Join-Path $root '.install-worker.json'
$journalCandidate = Join-Path $root '.install-worker.json.candidate'
$hostPath = Join-Path $releaseRoot 'worker-host.ps1'
$existingTask = Get-ScheduledTask -TaskName 'AgentOS Worker' -ErrorAction SilentlyContinue
$journal = $null
$journalNeedsIntentRebind = $false
if (Test-Path -LiteralPath $journalPath) {
  $null = Assert-AgentOSFixedPath -Path $journalPath -Kind File
  Assert-AgentOSAdminAcl -Path $journalPath
  $journal = Get-Content -LiteralPath $journalPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $journalKeys = @($journal.PSObject.Properties.Name | Sort-Object)
  if (($journalKeys -join ',') -cne 'adminSha256,configSha256,kind,phase,taskName,version,workerReleaseSha256,workerSid' -or
      $journal.version -ne 1 -or $journal.kind -cne 'install-worker' -or
      $journal.workerReleaseSha256 -cne $ExpectedWorkerReleaseSha256 -or
      $journal.workerSid -cne $workerSid.Value -or $journal.taskName -cne 'AgentOS Worker' -or
      $journal.phase -notin @('intent', 'layout', 'release', 'runtime', 'config', 'task', 'committed')) {
    throw 'existing Windows Worker install journal does not match this transaction'
  }
  if ($journal.adminSha256 -cne $ExpectedAdminSha256 -or
      $journal.configSha256 -cne $secretConfigSha256) {
    $unexpectedIntentEntries = @(Get-ChildItem -LiteralPath $root -Force | Where-Object {
      $_.Name -notin @('.install-worker.json', '.install-worker.json.candidate', 'config', 'state')
    })
    if ($journal.phase -cne 'intent' -or $existingTask -or
        (Test-Path -LiteralPath $configPath) -or
        (Test-Path -LiteralPath $releasesRoot) -or
        $unexpectedIntentEntries.Count -ne 0) {
      throw 'existing Windows Worker install journal does not match this transaction'
    }
    $journalNeedsIntentRebind = $true
  }
} else {
  if ($existingTask) { throw 'Agent OS Worker task already exists without an install journal' }
  if (Test-Path -LiteralPath $configPath) {
    throw 'Worker secret configuration exists without an install journal'
  }
  if (Test-Path -LiteralPath $releaseRoot) {
    throw 'Worker admin release exists without an install journal'
  }
  if (Test-Path -LiteralPath $workerRuntimeRoot) {
    throw 'Worker runtime release exists without an install journal'
  }
  if (Test-Path -LiteralPath $root) {
    $null = Assert-AgentOSFixedPath -Path $root -Kind Directory
    $unexpected = @(Get-ChildItem -LiteralPath $root -Force | Where-Object {
      $_.Name -cne '.install-worker.json.candidate'
    })
    if ($unexpected.Count -ne 0) {
      throw 'Agent OS root exists without a recoverable install journal'
    }
  }
}
if ($existingTask) {
  $null = Assert-AgentOSWorkerTask -TaskName 'AgentOS Worker' -WorkerAccount $WorkerAccount `
    -PowerShellPath $PowerShellPath -HostPath $hostPath -ConfigPath $configPath
}

function Write-InstallJournal {
  param([Parameter(Mandatory)][string]$Phase)
  $record = [ordered]@{
    version = 1; kind = 'install-worker'; taskName = 'AgentOS Worker'
    workerSid = $workerSid.Value; adminSha256 = $ExpectedAdminSha256
    configSha256 = $secretConfigSha256
    workerReleaseSha256 = $ExpectedWorkerReleaseSha256; phase = $Phase
  }
  if (Test-Path -LiteralPath $journalCandidate) {
    $null = Assert-AgentOSFixedPath -Path $journalCandidate -Kind File
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
  $script:journal = [PSCustomObject]$record
}

$phaseOrder = @('intent', 'layout', 'release', 'runtime', 'config', 'task', 'committed')
function Advance-InstallJournal {
  param([Parameter(Mandatory)][string]$Phase)
  if ($phaseOrder.IndexOf([string]$journal.phase) -lt $phaseOrder.IndexOf($Phase)) {
    Write-InstallJournal -Phase $Phase
  }
}

if ($journalNeedsIntentRebind) {
  Write-InstallJournal -Phase intent
}

if ($journal -and $journal.phase -eq 'committed') {
  Assert-AgentOSWorkerReadAcl -Path (Join-Path $root 'config') -WorkerSid $workerSid
  foreach ($relative in @('state', 'state\credentials', 'workspaces', 'logs', 'run')) {
    Assert-AgentOSPrivateAcl -Path (Join-Path $root $relative) -WorkerSid $workerSid
  }
  if ((Get-AgentOSTreeDigest -Root $releaseRoot -Files $adminFiles) -cne $ExpectedAdminSha256) {
    throw 'committed Windows Worker admin release changed'
  }
  Assert-AgentOSReleaseTree -Path $releaseRoot -WorkerSid $workerSid
  if ((Get-AgentOSExactTreeDigest -Root $workerRuntimeRoot -Files $workerReleaseManifest) -cne
      $ExpectedWorkerReleaseSha256) {
    throw 'committed Windows Worker runtime release changed'
  }
  Assert-AgentOSReleaseTree -Path $workerRuntimeRoot -WorkerSid $workerSid
  if ((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $secretConfigSha256) {
    throw 'committed Worker secret configuration changed'
  }
  Assert-AgentOSWorkerReadAcl -Path $configPath -WorkerSid $workerSid
  $null = Assert-AgentOSWorkerTask -TaskName 'AgentOS Worker' -WorkerAccount $WorkerAccount `
    -PowerShellPath $PowerShellPath -HostPath $hostPath -ConfigPath $configPath
  if ((Test-Path -LiteralPath $stage) -or
      (Test-Path -LiteralPath $workerRuntimeStage) -or
      (Test-Path -LiteralPath $journalCandidate)) {
    throw 'committed Windows Worker install has residual staging artifacts'
  }
  Write-Output 'agent-os windows worker already installed'
  exit 0
}

if (-not (Test-Path -LiteralPath $root)) {
  $null = New-Item -ItemType Directory -Path $root
} else {
  $null = Assert-AgentOSFixedPath -Path $root -Kind Directory
}
if (-not $journal) {
  Set-AgentOSReleaseAcl -Path $root -WorkerSid $workerSid
  Write-InstallJournal -Phase intent
}

$paths = @('config', 'state', 'state\credentials', 'workspaces', 'logs', 'run')
foreach ($relative in $paths) {
  $path = Join-Path $root $relative
  if (-not (Test-Path -LiteralPath $path)) { $null = New-Item -ItemType Directory -Path $path }
  $null = Assert-AgentOSFixedPath -Path $path -Kind Directory
  if ($relative -eq 'config') {
    Set-AgentOSWorkerReadAcl -Path $path -WorkerSid $workerSid
  } else {
    Set-AgentOSPrivateAcl -Path $path -WorkerSid $workerSid
  }
}
if (-not (Test-Path -LiteralPath $releasesRoot)) {
  $null = New-Item -ItemType Directory -Path $releasesRoot
}
Set-AgentOSReleaseAcl -Path $releasesRoot -WorkerSid $workerSid
Advance-InstallJournal -Phase layout

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
      if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -cne
          (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash) {
        throw 'Windows Worker staged admin file changed during retry'
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
  throw 'Windows Worker has both installed and staged admin releases'
}
if ((Get-AgentOSTreeDigest -Root $releaseRoot -Files $adminFiles) -cne $ExpectedAdminSha256) {
  throw 'Windows Worker installed admin release digest changed'
}
Assert-AgentOSReleaseTree -Path $releaseRoot -WorkerSid $workerSid
Advance-InstallJournal -Phase release

if (-not (Test-Path -LiteralPath $workerRuntimeRoot)) {
  if (-not (Test-Path -LiteralPath $workerRuntimeStage)) {
    $null = New-Item -ItemType Directory -Path $workerRuntimeStage
    Set-AgentOSAdminAcl -Path $workerRuntimeStage
  } else {
    $null = Assert-AgentOSFixedPath -Path $workerRuntimeStage -Kind Directory
    Assert-AgentOSAdminAcl -Path $workerRuntimeStage
  }
  foreach ($relative in $workerReleaseManifest) {
    $source = Join-Path $WorkerReleaseSource $relative
    $destination = Join-Path $workerRuntimeStage $relative
    $destinationParent = [IO.Path]::GetDirectoryName($destination)
    if (-not (Test-Path -LiteralPath $destinationParent)) {
      $null = New-Item -ItemType Directory -Path $destinationParent
      Set-AgentOSAdminAcl -Path $destinationParent
    }
    if (Test-Path -LiteralPath $destination) {
      $null = Assert-AgentOSFixedPath -Path $destination -Kind File
      Assert-AgentOSAdminAcl -Path $destination
      if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -cne
          (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash) {
        throw 'Windows Worker staged runtime file changed during retry'
      }
    } else {
      Copy-Item -LiteralPath $source -Destination $destination
      Set-AgentOSAdminAcl -Path $destination
      if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -cne
          (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash) {
        throw 'Windows Worker runtime file changed after candidate copy'
      }
    }
  }
  if ((Get-AgentOSExactTreeDigest -Root $workerRuntimeStage -Files $workerReleaseManifest) -cne
      $ExpectedWorkerReleaseSha256) {
    throw 'Windows Worker staged runtime release digest changed'
  }
  Set-AgentOSReleaseAcl -Path $workerRuntimeStage -WorkerSid $workerSid
  [IO.Directory]::Move($workerRuntimeStage, $workerRuntimeRoot)
} elseif (Test-Path -LiteralPath $workerRuntimeStage) {
  throw 'Windows Worker has both installed and staged runtime releases'
}
if ((Get-AgentOSExactTreeDigest -Root $workerRuntimeRoot -Files $workerReleaseManifest) -cne
    $ExpectedWorkerReleaseSha256) {
  throw 'Windows Worker installed runtime release digest changed'
}
Assert-AgentOSReleaseTree -Path $workerRuntimeRoot -WorkerSid $workerSid
Advance-InstallJournal -Phase runtime

if (Test-Path -LiteralPath $configPath) {
  $null = Assert-AgentOSFixedPath -Path $configPath -Kind File
  if ((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $secretConfigSha256) {
    throw 'Worker secret configuration changed during install retry'
  }
  Assert-AgentOSWorkerReadAcl -Path $configPath -WorkerSid $workerSid
} else {
  $configCandidate = Join-Path $root 'config\worker.json.installing'
  if (Test-Path -LiteralPath $configCandidate) {
    $null = Assert-AgentOSFixedPath -Path $configCandidate -Kind File
    if ((Get-FileHash -LiteralPath $configCandidate -Algorithm SHA256).Hash.ToLowerInvariant() -cne $secretConfigSha256) {
      throw 'Worker staged secret configuration changed during retry'
    }
  } else {
    Copy-Item -LiteralPath $SecretConfigSource -Destination $configCandidate
  }
  Set-AgentOSAdminAcl -Path $configCandidate
  if ((Get-FileHash -LiteralPath $configCandidate -Algorithm SHA256).Hash.ToLowerInvariant() -cne $secretConfigSha256) {
    throw 'Worker secret configuration changed after candidate copy'
  }
  & (Join-Path $PSScriptRoot 'replace-file.ps1') `
    -CandidatePath $configCandidate -TargetPath $configPath
  Set-AgentOSWorkerReadAcl -Path $configPath -WorkerSid $workerSid
  if ((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $secretConfigSha256) {
    throw 'Worker secret configuration changed after publication'
  }
}
Advance-InstallJournal -Phase config

$action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument (
  '-NoLogo -NoProfile -NonInteractive -File "{0}" -ConfigPath "{1}"' -f $hostPath, $configPath
)
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $workerSid.Value -LogonType Password -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal
if (-not (Get-ScheduledTask -TaskName 'AgentOS Worker' -ErrorAction SilentlyContinue)) {
  Register-ScheduledTask -TaskName 'AgentOS Worker' -InputObject $task `
    -User $WorkerCredential.UserName `
    -Password $WorkerCredential.GetNetworkCredential().Password | Out-Null
}
$null = Assert-AgentOSWorkerTask -TaskName 'AgentOS Worker' -WorkerAccount $WorkerAccount `
  -PowerShellPath $PowerShellPath -HostPath $hostPath -ConfigPath $configPath
Advance-InstallJournal -Phase task
Advance-InstallJournal -Phase committed

Write-Output 'agent-os windows worker installed'
