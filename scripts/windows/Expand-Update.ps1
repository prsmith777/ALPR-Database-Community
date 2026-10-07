#requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Setup-Helpers.ps1')
$root=Assert-SetupDirectory $Destination
$archivePath=Assert-SetupDirectory $Archive
if ((Split-Path -Parent $root) -ne (Split-Path -Parent $archivePath) -or (Split-Path -Leaf $root) -ne 'package' -or (Split-Path -Leaf $archivePath) -ne 'update.zip') { throw 'Unexpected update extraction workspace' }
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($archivePath)
try {
 $bytes=[long]0
 $seen=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
 if($zip.Entries.Count -gt 100000){throw 'Too many update archive entries'}
 foreach($entry in $zip.Entries){
  $name=$entry.FullName.Replace('\','/');$parts=$name.TrimEnd('/').Split('/')
  if(!$name -or $name.StartsWith('/') -or !$seen.Add($name.TrimEnd('/')) -or @($parts | Where-Object {!$_ -or $_ -in @('.','..') -or $_ -match '[\x00-\x1f<>:"|?*]' -or $_ -match '[. ]$' -or $_ -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)'}).Count){throw 'Unsafe update archive path'}
  if(($entry.ExternalAttributes -band 1024) -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw 'Update archive links are forbidden'}
  $bytes+=$entry.Length
  if($bytes -gt 4GB){throw 'Expanded update exceeds its size limit'}
 }
} finally {$zip.Dispose()}
Expand-SetupArchive $archivePath $root 'community'
