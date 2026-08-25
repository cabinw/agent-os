#requires -Version 7.4
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'AgentOS.Architecture.ps1')

if (-not ('AgentOS.Windows.ReleaseManifest' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace AgentOS.Windows {
  public static class ReleaseManifest {
    private static readonly Regex Reserved = new Regex(
      @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)",
      RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    );
    public static string[] Canonicalize(string[] files) {
      if (files == null || files.Length == 0) throw new InvalidDataException("manifest_empty");
      var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      var result = new List<string>();
      foreach (string relative in files) {
        if (string.IsNullOrEmpty(relative) || Path.IsPathRooted(relative) ||
            relative.IndexOf('/') >= 0 || relative[0] == '\\') {
          throw new InvalidDataException("manifest_path_unsafe");
        }
        string[] segments = relative.Split('\\');
        foreach (string segment in segments) {
          if (string.IsNullOrEmpty(segment) || segment == "." || segment == ".." ||
              segment.EndsWith(".", StringComparison.Ordinal) ||
              segment.EndsWith(" ", StringComparison.Ordinal) || Reserved.IsMatch(segment)) {
            throw new InvalidDataException("manifest_segment_unsafe");
          }
          foreach (char value in segment) {
            if (value < 0x20 || "<>:\"/\\|?*".IndexOf(value) >= 0) {
              throw new InvalidDataException("manifest_segment_unsafe");
            }
          }
        }
        string canonical = string.Join("\\", segments);
        if (!seen.Add(canonical)) throw new InvalidDataException("manifest_case_collision");
        result.Add(canonical);
      }
      result.Sort(StringComparer.Ordinal);
      return result.ToArray();
    }
  }
}
'@
}

if (-not ('AgentOS.Windows.FileIdentity' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AgentOS.Windows {
  public static class FileIdentity {
    [StructLayout(LayoutKind.Sequential)]
    private struct Info {
      public uint Attributes;
      public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, AccessTime, WriteTime;
      public uint VolumeSerial, SizeHigh, SizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFile(
      string path, uint access, uint share, IntPtr security,
      uint creation, uint flags, IntPtr template
    );
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    public static uint LinkCount(string path) {
      using (var handle = CreateFile(path, 0x80, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Win32Exception();
        Info info;
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception();
        return info.NumberOfLinks;
      }
    }
  }
}
'@
}

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
    $parent = [IO.Path]::GetDirectoryName($cursor)
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
  if ($Kind -eq 'File' -and [AgentOS.Windows.FileIdentity]::LinkCount($Path) -ne 1) {
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
  $ownerSid = ([Security.Principal.NTAccount]$acl.Owner).Translate(
    [Security.Principal.SecurityIdentifier]
  ).Value
  if ($ownerSid -ne 'S-1-5-32-544') {
    throw "Agent OS admin ACL owner changed: $Path"
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

function Assert-AgentOSWorkerAccount {
  param([Parameter(Mandatory)][string]$WorkerAccount)

  $account = Get-LocalUser -Name $WorkerAccount -ErrorAction Stop
  if (-not $account.Enabled) {
    throw 'Agent OS Worker account must be enabled'
  }
  $administrators = Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop
  if ($administrators.SID.Value -contains $account.Sid.Value) {
    throw 'Agent OS Worker account must not be an administrator'
  }
  return $account.Sid
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

function Get-AgentOSCanonicalReleaseManifest {
  param([Parameter(Mandatory)][string[]]$Files)
  try {
    return [AgentOS.Windows.ReleaseManifest]::Canonicalize($Files)
  } catch {
    throw 'Agent OS release manifest is not a canonical Windows file list'
  }
}

function Get-AgentOSExactTreeDigest {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string[]]$Files
  )
  $null = Assert-AgentOSFixedPath -Path $Root -Kind Directory
  $normalized = @(Get-AgentOSCanonicalReleaseManifest -Files $Files)
  foreach ($relative in $normalized) {
    $full = [IO.Path]::GetFullPath((Join-Path $Root $relative))
    if (-not (Test-AgentOSContainedPath -Root $Root -Path $full)) {
      throw 'Agent OS release manifest escapes its root'
    }
    if ([IO.Path]::GetRelativePath($Root, $full) -cne $relative) {
      throw 'Agent OS release manifest path is not canonical'
    }
  }
  $actualFiles = @(Get-ChildItem -LiteralPath $Root -Force -Recurse -File |
    ForEach-Object { [IO.Path]::GetRelativePath($Root, $_.FullName) } |
    Sort-Object -CaseSensitive)
  if (($actualFiles -join "`n") -cne ($normalized -join "`n")) {
    throw 'Agent OS release tree differs from its exact file manifest'
  }
  $allowedDirectories = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::Ordinal
  )
  foreach ($relative in $normalized) {
    $parent = Split-Path -Path $relative -Parent
    while ($parent) {
      $null = $allowedDirectories.Add($parent)
      $parent = Split-Path -Path $parent -Parent
    }
  }
  foreach ($directory in @(Get-ChildItem -LiteralPath $Root -Force -Recurse -Directory)) {
    $relative = [IO.Path]::GetRelativePath($Root, $directory.FullName)
    if (-not $allowedDirectories.Contains($relative)) {
      throw 'Agent OS release tree contains an extra directory'
    }
    $null = Assert-AgentOSFixedPath -Path $directory.FullName -Kind Directory
  }
  return Get-AgentOSTreeDigest -Root $Root -Files $normalized
}

function Assert-AgentOSAdminTree {
  param([Parameter(Mandatory)][string]$Path)
  $null = Assert-AgentOSFixedPath -Path $Path -Kind Directory
  Assert-AgentOSAdminAcl -Path $Path
  foreach ($entry in @(Get-ChildItem -LiteralPath $Path -Force -Recurse)) {
    Assert-AgentOSAdminAcl -Path $entry.FullName
  }
  $untrusted = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
  $destructiveMask = [Security.AccessControl.FileSystemRights](
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  )
  $cursor = [IO.Path]::GetDirectoryName($Path)
  while ($cursor) {
    foreach ($rule in (Get-Acl -LiteralPath $cursor -ErrorAction Stop).Access) {
      $sid = $rule.IdentityReference.Translate(
        [Security.Principal.SecurityIdentifier]
      ).Value
      if ($rule.AccessControlType -eq 'Allow' -and $sid -in $untrusted -and
          ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
          ($rule.FileSystemRights -band $destructiveMask) -ne 0) {
        throw "Agent OS admin tree ancestry can replace the protected root: $cursor"
      }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if (-not $parent -or $parent -ceq $cursor) { break }
    $cursor = $parent
  }
}

function Assert-AgentOSConfiguredWorkerRelease {
  param(
    [Parameter(Mandatory)]$Config,
    [Parameter(Mandatory)][Security.Principal.SecurityIdentifier]$WorkerSid
  )
  $digest = [string]$Config.workerReleaseSha256
  $files = @(Get-AgentOSCanonicalReleaseManifest -Files @(
    $Config.workerReleaseFiles | ForEach-Object { [string]$_ }
  ))
  if ($digest -notmatch '^[a-f0-9]{64}$' -or $files.Count -eq 0) {
    throw 'Worker runtime release declaration is invalid'
  }
  $root = Join-Path (Join-Path (Get-AgentOSRoot) 'releases') "worker-runtime-$digest"
  if ((Get-AgentOSExactTreeDigest -Root $root -Files $files) -cne $digest) {
    throw 'Worker runtime release digest changed'
  }
  Assert-AgentOSReleaseTree -Path $root -WorkerSid $WorkerSid
  $entry = [string]$Config.workerEntry
  $working = [string]$Config.workingDirectory
  if (-not [IO.Path]::IsPathFullyQualified($entry) -or
      [IO.Path]::GetFullPath($entry) -cne $entry -or
      -not (Test-AgentOSContainedPath -Root $root -Path $entry) -or
      [IO.Path]::GetRelativePath($root, $entry) -cnotin $files) {
    throw 'Worker entry is not bound to the declared runtime release'
  }
  if (-not [IO.Path]::IsPathFullyQualified($working) -or
      [IO.Path]::GetFullPath($working) -cne $working -or
      ($working -cne $root -and -not (Test-AgentOSContainedPath -Root $root -Path $working))) {
    throw 'Worker working directory is not bound to the declared runtime release'
  }
  $null = Assert-AgentOSFixedPath -Path $entry -Kind File
  $null = Assert-AgentOSFixedPath -Path $working -Kind Directory
  return $root
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
    $allowed = @($WorkerSid.Value, 'S-1-5-18', 'S-1-5-32-544')
    $seen = [Collections.Generic.HashSet[string]]::new(
      [StringComparer]::OrdinalIgnoreCase
    )
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
    $expectedInheritance = if ($kind -eq 'Directory') {
      [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($rule in $acl.Access) {
      $sid = $rule.IdentityReference.Translate(
        [Security.Principal.SecurityIdentifier]
      ).Value
      if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or
          $sid -notin $allowed -or -not $seen.Add($sid) -or
          $rule.InheritanceFlags -ne $expectedInheritance -or
          $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
        throw "Agent OS release ACL contains an unauthorized rule: $target"
      }
      if ($sid -eq $WorkerSid.Value) {
        if (($rule.FileSystemRights -band $writeMask) -ne 0 -or
            ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -ne
              [Security.AccessControl.FileSystemRights]::ReadAndExecute) {
          throw "Agent OS release grants unsafe Worker rights: $target"
        }
      } elseif (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
                [Security.AccessControl.FileSystemRights]::FullControl) {
        throw "Agent OS release omits administrator control: $target"
      }
    }
    foreach ($sid in $allowed) {
      if (-not $seen.Contains($sid)) {
        throw "Agent OS release ACL is missing a required principal: $target"
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
  $destructiveMask = [Security.AccessControl.FileSystemRights](
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  )
  $cursor = $Path
  $checkedDirectParent = $false
  while ($cursor) {
    $acl = Get-Acl -LiteralPath $cursor
    $effectiveMask = if ($checkedDirectParent) { $destructiveMask } else { $writeMask }
    foreach ($rule in $acl.Access) {
      $sid = $rule.IdentityReference.Translate(
        [Security.Principal.SecurityIdentifier]
      ).Value
      if ($rule.AccessControlType -eq 'Allow' -and $sid -in $untrusted -and
          ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
          ($rule.FileSystemRights -band $effectiveMask) -ne 0) {
        throw "Agent OS executable ancestry is writable by an untrusted principal: $Path"
      }
    }
    if ($cursor -cne $Path) { $checkedDirectParent = $true }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    $grandparent = if ($parent) { [IO.Path]::GetDirectoryName($parent) } else { $null }
    if (-not $parent -or $parent -ceq $cursor -or -not $grandparent) { break }
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
  $workerSid = Assert-AgentOSWorkerAccount -WorkerAccount $WorkerAccount
  $null = Assert-AgentOSFixedPath -Path $ConfigPath -Kind File
  Assert-AgentOSWorkerReadAcl `
    -Path ([IO.Path]::GetDirectoryName($ConfigPath)) `
    -WorkerSid $workerSid
  Assert-AgentOSWorkerReadAcl -Path $ConfigPath -WorkerSid $workerSid
  $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $null = Assert-AgentOSConfiguredWorkerRelease -Config $config -WorkerSid $workerSid
  foreach ($executable in @(
    $PowerShellPath,
    [string]$config.nodePath,
    [string]$config.environment.AGENT_OS_GROK_BIN
  )) {
    $null = Assert-AgentOSTrustedExecutable -Path $executable -WorkerSid $workerSid
  }
  Assert-AgentOSRuntimeArchitecture `
    -DeclaredHostMachine ([string]$config.hostArchitecture) `
    -DeclaredWorkerMachine ([string]$config.workerArchitecture) `
    -AssetPaths @(
      $PowerShellPath,
      [string]$config.nodePath,
      [string]$config.environment.AGENT_OS_GROK_BIN
    )
  if ($task.Principal.UserId -cne $WorkerAccount -and
      $task.Principal.UserId -cne $workerSid.Value) {
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

Export-ModuleMember -Function Assert-AgentOSAdminAcl, Assert-AgentOSAdminTree, Assert-AgentOSConfiguredWorkerRelease, Assert-AgentOSFixedPath, Assert-AgentOSPrivateAcl, Assert-AgentOSReleaseTree, Assert-AgentOSRuntimeArchitecture, Assert-AgentOSTrustedExecutable, Assert-AgentOSWorkerAccount, Assert-AgentOSWorkerReadAcl, Assert-AgentOSWorkerTask, Get-AgentOSCanonicalReleaseManifest, Get-AgentOSExactTreeDigest, Get-AgentOSRoot, Get-AgentOSTreeDigest, Get-AgentOSWorkerProcesses, Set-AgentOSAdminAcl, Set-AgentOSPrivateAcl, Set-AgentOSReleaseAcl, Set-AgentOSWorkerReadAcl, Test-AgentOSContainedPath
