#requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$InstallRoot,[Parameter(Mandatory=$true)][string]$DataRoot)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Setup-Helpers.ps1')
. (Join-Path $PSScriptRoot 'Update-Service.ps1')
Install-WindowsUpdateService $InstallRoot $DataRoot
