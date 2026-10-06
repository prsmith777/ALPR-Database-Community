#requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$InstallRoot,[Parameter(Mandatory=$true)][string]$DataRoot,[Parameter(Mandatory=$true)][ValidateSet('start','stop')][string]$Operation)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Setup-Helpers.ps1')
$root=Assert-SetupDirectory $InstallRoot;$data=Assert-SetupDirectory $DataRoot
$record=Get-Content -LiteralPath (Join-Path $root 'installation.json') -Raw | ConvertFrom-Json
if($record.installRoot -ne $root -or $record.dataRoot -ne $data -or $record.profile -ne 'windows-native'){throw 'Unexpected updater ownership'}
$service=Get-CimInstance Win32_Service -Filter "Name='ALPRCommunityUpdater'"
if(!$service){exit 0}
if($service.PathName -ne ('"'+$root+'\services\ALPRCommunityUpdater.exe"') -or $service.StartName -ne 'LocalSystem'){throw 'Updater belongs to another installation'}
if(Test-Path -LiteralPath (Join-Path $data 'management\updates\active.json')){throw 'Wait for the current update operation to finish'}
if($Operation -eq 'stop'){
 Stop-Service -Name ALPRCommunityUpdater
 (Get-Service -Name ALPRCommunityUpdater).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(90))
} else {Start-Service -Name ALPRCommunityUpdater}
