#requires -Version 7.4
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-AgentOSFixedPath {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][ValidateSet('File', 'Directory')][string]$Kind
  )

  if (-not [IO.Path]::IsPathFullyQualified($Path) -or
      [IO.Path]::GetFullPath($Path) -cne $Path) {
    throw "Agent OS path must be canonical and absolute: $Path"
  }
  $cursor = $Path
  while ($cursor) {
    $ancestor = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Agent OS path ancestry must not contain a reparse point: $Path"
    }
    $parent = Split-Path -LiteralPath $cursor -Parent
    if (-not $parent -or $parent -ceq $cursor) { break }
    $cursor = $parent
  }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Agent OS path must not be a reparse point: $Path"
  }
  if ($Kind -eq 'File' -and -not ($item -is [IO.FileInfo])) {
    throw "Agent OS expected a regular file: $Path"
  }
  if ($Kind -eq 'File' -and [IO.File]::GetLinkCount($Path) -ne 1) {
    throw "Agent OS regular file must have exactly one link: $Path"
  }
  if ($Kind -eq 'Directory' -and -not ($item -is [IO.DirectoryInfo])) {
    throw "Agent OS expected a directory: $Path"
  }
  return $item
}

function Assert-AgentOSPrivateAcl {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][Security.Principal.SecurityIdentifier]$WorkerSid
  )

  $null = Assert-AgentOSFixedPath -Path $Path -Kind (
    if (Test-Path -LiteralPath $Path -PathType Container) { 'Directory' } else { 'File' }
  )
  $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
  if (-not $acl.AreAccessRulesProtected) {
    throw "Agent OS private ACL must disable inheritance: $Path"
  }
  $allowed = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  $null = $allowed.Add($WorkerSid.Value)
  $null = $allowed.Add('S-1-5-18')
  $null = $allowed.Add('S-1-5-32-544')
  $seen = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
    if ($rule.AccessControlType -ne 'Allow' -or -not $allowed.Contains($sid)) {
      throw "Agent OS private ACL contains an unauthorized principal: $Path"
    }
    if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
        [Security.AccessControl.FileSystemRights]::FullControl) {
      throw "Agent OS private ACL does not grant the required control: $Path"
    }
    $null = $seen.Add($sid)
  }
  foreach ($sid in $allowed) {
    if (-not $seen.Contains($sid)) {
      throw "Agent OS private ACL is missing a required principal: $Path"
    }
  }
}

function Set-AgentOSPrivateAcl {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][Security.Principal.SecurityIdentifier]$WorkerSid
  )

  $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { $null = $acl.RemoveAccessRuleAll($rule) }
  foreach ($sid in @($WorkerSid, 'S-1-5-18', 'S-1-5-32-544')) {
    $identity = [Security.Principal.SecurityIdentifier]::new([string]$sid)
    $rights = [Security.AccessControl.FileSystemRights]::FullControl
    $inheritance = if (Test-Path -LiteralPath $Path -PathType Container) {
      [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
      [Security.AccessControl.InheritanceFlags]::None
    }
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $identity,
      $rights,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
  Assert-AgentOSPrivateAcl -Path $Path -WorkerSid $WorkerSid
}

function Assert-AgentOSWorkerReadAcl {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][Security.Principal.SecurityIdentifier]$WorkerSid
  )
  $kind = if (Test-Path -LiteralPath $Path -PathType Container) { 'Directory' } else { 'File' }
  $null = Assert-AgentOSFixedPath -Path $Path -Kind $kind
  $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
  if (-not $acl.AreAccessRulesProtected) {
    throw "Agent OS Worker-read ACL must disable inheritance: $Path"
  }
  $ownerSid = ([Security.Principal.NTAccount]$acl.Owner).Translate(
    [Security.Principal.SecurityIdentifier]
  ).Value
  if ($ownerSid -ne 'S-1-5-32-544') {
    throw "Agent OS Worker-read owner changed: $Path"
  }
  $allowed = @($WorkerSid.Value, 'S-1-5-18', 'S-1-5-32-544')
  $seen = @{}
  $writeMask = [Security.AccessControl.FileSystemRights](
    [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  )
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
    if ($rule.AccessControlType -ne 'Allow' -or $sid -notin $allowed) {
      throw "Agent OS Worker-read ACL contains an unauthorized rule: $Path"
    }
    if ($sid -eq $WorkerSid.Value) {
      if (($rule.FileSystemRights -band $writeMask) -ne 0 -or
          ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -ne
            [Security.AccessControl.FileSystemRights]::ReadAndExecute) {
        throw "Agent OS Worker-read ACL grants unsafe Worker rights: $Path"
      }
    } elseif (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
              [Security.AccessControl.FileSystemRights]::FullControl) {
      throw "Agent OS Worker-read ACL omits administrator control: $Path"
    }
    $seen[$sid] = $true
  }
  foreach ($sid in $allowed) {
    if (-not $seen.ContainsKey($sid)) {
      throw "Agent OS Worker-read ACL is missing a required principal: $Path"
    }
  }
}

function Set-AgentOSWorkerReadAcl {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][Security.Principal.SecurityIdentifier]$WorkerSid
  )
  $kind = if (Test-Path -LiteralPath $Path -PathType Container) { 'Directory' } else { 'File' }
  $null = Assert-AgentOSFixedPath -Path $Path -Kind $kind
  $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach ($rule in @($acl.Access)) { $null = $acl.RemoveAccessRuleAll($rule) }
  foreach ($entry in @(
    [PSCustomObject]@{ Sid = $WorkerSid; Rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute },
    [PSCustomObject]@{ Sid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18'); Rights = [Security.AccessControl.FileSystemRights]::FullControl },
    [PSCustomObject]@{ Sid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'); Rights = [Security.AccessControl.FileSystemRights]::FullControl }
  )) {
    $inheritance = if ($kind -eq 'Directory') {
      [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else { [Security.AccessControl.InheritanceFlags]::None }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $entry.Sid, $entry.Rights, $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    ))
  }
  Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
  Assert-AgentOSWorkerReadAcl -Path $Path -WorkerSid $WorkerSid
}

function Set-AgentOSAdminAcl {
  param([Parameter(Mandatory)][string]$Path)
  $kind = if (Test-Path -LiteralPath $Path -PathType Container) { 'Directory' } else { 'File' }
  $null = Assert-AgentOSFixedPath -Path $Path -Kind $kind
  $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach ($rule in @($acl.Access)) { $null = $acl.RemoveAccessRuleAll($rule) }
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $inheritance = if ($kind -eq 'Directory') {
      [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else { [Security.AccessControl.InheritanceFlags]::None }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new($sid),
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    ))
  }
  Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
  Assert-AgentOSAdminAcl -Path $Path
}

function Assert-AgentOSAdminAcl {
  param([Parameter(Mandatory)][string]$Path)
  $kind = if (Test-Path -LiteralPath $Path -PathType Container) { 'Directory' } else { 'File' }
  $null = Assert-AgentOSFixedPath -Path $Path -Kind $kind
  $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
  if (-not $acl.AreAccessRulesProtected) {
    throw "Agent OS admin ACL must disable inheritance: $Path"
  }
  $allowed = @('S-1-5-18', 'S-1-5-32-544')
  $seen = @($acl.Access | ForEach-Object {
    $sid = $_.IdentityReference.Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
    if ($_.AccessControlType -ne 'Allow' -or $sid -notin $allowed -or
        ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
          [Security.AccessControl.FileSystemRights]::FullControl) {
      throw "Agent OS admin ACL contains an unauthorized rule: $Path"
    }
    $sid
  } | Sort-Object -Unique)
  if (($seen -join ',') -cne (($allowed | Sort-Object) -join ',')) {
    throw "Agent OS admin ACL is missing a required principal: $Path"
  }
}

function Get-AgentOSRoot {
  return Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'AgentOS'
}

function Test-AgentOSContainedPath {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Path
  )
  $prefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  return $Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Get-AgentOSTreeDigest {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string[]]$Files
  )
  $frames = foreach ($relative in $Files | Sort-Object -CaseSensitive) {
    if ([IO.Path]::IsPathFullyQualified($relative) -or $relative.Contains('..')) {
      throw 'Agent OS release manifest contains an unsafe relative path'
    }
    $path = Join-Path $Root $relative
    $null = Assert-AgentOSFixedPath -Path $path -Kind File
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    "$relative`0$hash`n"
  }
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($frames -join ''))
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Set-AgentOSReleaseAcl {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][Security.Principal.SecurityIdentifier]$WorkerSid
  )
  $entries = @(
    [PSCustomObject]@{ Sid = $WorkerSid; Rights = [Security.AccessControl.FileSystemRights]'ReadAndExecute' },
    [PSCustomObject]@{ Sid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18'); Rights = [Security.AccessControl.FileSystemRights]::FullControl },
    [PSCustomObject]@{ Sid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'); Rights = [Security.AccessControl.FileSystemRights]::FullControl }
  )
  $targets = @($Path)
  if (Test-Path -LiteralPath $Path -PathType Container) {
    $targets += @(Get-ChildItem -LiteralPath $Path -Force -Recurse | ForEach-Object FullName)
  }
  foreach ($target in $targets) {
    $kind = if (Test-Path -LiteralPath $target -PathType Container) { 'Directory' } else { 'File' }
    $null = Assert-AgentOSFixedPath -Path $target -Kind $kind
    $acl = Get-Acl -LiteralPath $target -ErrorAction Stop
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($rule in @($acl.Access)) { $null = $acl.RemoveAccessRuleAll($rule) }
    foreach ($entry in $entries) {
      $inheritance = if ($kind -eq 'Directory') {
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
      } else { [Security.AccessControl.InheritanceFlags]::None }
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $entry.Sid, $entry.Rights, $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
      ))
    }
    Set-Acl -LiteralPath $target -AclObject $acl -ErrorAction Stop
  }
}

function Assert-AgentOSReleaseTree {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][Security.Principal.SecurityIdentifier]$WorkerSid
  )
  $targets = @($Path)
  if (Test-Path -LiteralPath $Path -PathType Container) {
    $targets += @(Get-ChildItem -LiteralPath $Path -Force -Recurse | ForEach-Object FullName)
  }
  foreach ($target in $targets) {
    $kind = if (Test-Path -LiteralPath $target -PathType Container) { 'Directory' } else { 'File' }
    $null = Assert-AgentOSFixedPath -Path $target -Kind $kind
    $acl = Get-Acl -LiteralPath $target -ErrorAction Stop
    if (-not $acl.AreAccessRulesProtected) {
      throw "Agent OS release ACL inheritance is enabled: $target"
    }
    $ownerSid = ([Security.Principal.NTAccount]$acl.Owner).Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
    if ($ownerSid -ne 'S-1-5-32-544') { throw "Agent OS release owner changed: $target" }
    foreach ($rule in $acl.Access) {
      $sid = $rule.IdentityReference.Translate(
        [Security.Principal.SecurityIdentifier]
      ).Value
      if ($sid -notin @($WorkerSid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        throw "Agent OS release ACL contains an unauthorized principal: $target"
      }
      if ($sid -eq $WorkerSid.Value -and
          ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]'Write, Modify, FullControl, ChangePermissions, TakeOwnership') -ne 0) {
        throw "Agent OS release is writable by the Worker: $target"
      }
    }
  }
}

function Assert-AgentOSTrustedExecutable {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][Security.Principal.SecurityIdentifier]$WorkerSid
  )
  $item = Assert-AgentOSFixedPath -Path $Path -Kind File
  $owner = (Get-Acl -LiteralPath $Path).Owner
  $ownerSid = ([Security.Principal.NTAccount]$owner).Translate(
    [Security.Principal.SecurityIdentifier]
  ).Value
  if ($ownerSid -notin @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) {
    throw "Agent OS executable owner is not trusted: $Path"
  }
  $untrusted = @($WorkerSid.Value, 'S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
  $writeMask = [Security.AccessControl.FileSystemRights]'Write, Modify, FullControl, ChangePermissions, TakeOwnership'
  $cursor = $Path
  while ($cursor) {
    foreach ($rule in (Get-Acl -LiteralPath $cursor).Access) {
      $sid = $rule.IdentityReference.Translate(
        [Security.Principal.SecurityIdentifier]
      ).Value
      if ($rule.AccessControlType -eq 'Allow' -and $sid -in $untrusted -and
          ($rule.FileSystemRights -band $writeMask) -ne 0) {
        throw "Agent OS executable ancestry is writable by an untrusted principal: $Path"
      }
    }
    $parent = Split-Path -LiteralPath $cursor -Parent
    if (-not $parent -or $parent -ceq $cursor -or -not (Split-Path -LiteralPath $parent -Parent)) { break }
    $cursor = $parent
  }
  return $item
}

function Get-AgentOSWorkerProcesses {
  param([Parameter(Mandatory)][string]$ConfigPath)
  $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $workerEntry = [string]$config.workerEntry
  return @(
    Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
      $_.CommandLine -and
      ($_.CommandLine.Contains($ConfigPath, [StringComparison]::OrdinalIgnoreCase) -or
       $_.CommandLine.Contains($workerEntry, [StringComparison]::OrdinalIgnoreCase))
    }
  )
}

function Assert-AgentOSWorkerTask {
  param(
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$WorkerAccount,
    [Parameter(Mandatory)][string]$PowerShellPath,
    [Parameter(Mandatory)][string]$HostPath,
    [Parameter(Mandatory)][string]$ConfigPath
  )
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ($task.Principal.UserId -cne $WorkerAccount -and
      $task.Principal.UserId -cne ([Security.Principal.NTAccount]$WorkerAccount).Translate(
        [Security.Principal.SecurityIdentifier]
      ).Value) {
    throw 'Agent OS Worker task identity changed'
  }
  if ($task.Principal.RunLevel -ne 'Limited') {
    throw 'Agent OS Worker task must use limited run level'
  }
  if ($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -cne $PowerShellPath) {
    throw 'Agent OS Worker task executable changed'
  }
  $expectedArguments = '-NoLogo -NoProfile -NonInteractive -File "{0}" -ConfigPath "{1}"' -f $HostPath, $ConfigPath
  if ($task.Actions[0].Arguments -cne $expectedArguments) {
    throw 'Agent OS Worker task arguments changed'
  }
  return $task
}

Export-ModuleMember -Function Assert-AgentOSAdminAcl, Assert-AgentOSFixedPath, Assert-AgentOSPrivateAcl, Assert-AgentOSReleaseTree, Assert-AgentOSTrustedExecutable, Assert-AgentOSWorkerReadAcl, Assert-AgentOSWorkerTask, Get-AgentOSRoot, Get-AgentOSTreeDigest, Get-AgentOSWorkerProcesses, Set-AgentOSAdminAcl, Set-AgentOSPrivateAcl, Set-AgentOSReleaseAcl, Set-AgentOSWorkerReadAcl, Test-AgentOSContainedPath
