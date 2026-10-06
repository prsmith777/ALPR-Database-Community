#requires -Version 5.1
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Setup-Helpers.ps1')
. (Join-Path $PSScriptRoot 'Network-Helpers.ps1')
$root = Assert-SetupDirectory "$env:ProgramFiles\ALPR Community"
$data = Assert-SetupDirectory "$env:ProgramData\ALPR Community"
$file = Join-Path $root 'installation.json'
if (-not (Test-Path -LiteralPath $file)) { throw 'ALPR installation metadata is missing; preserve files and contact the maintainer' }
$installation = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
if ($installation.installRoot -ne $root -or $installation.dataRoot -ne $data -or $installation.profile -ne 'windows-native' -or
    $installation.pgBin -ne (Join-Path $root 'prerequisites\postgresql\bin')) { throw 'This uninstaller does not own the recorded installation' }
[void](Assert-SetupDirectory $installation.pgBin)
$services = @()
foreach ($name in @('ALPRCommunityApp','ALPRCommunityDatabase')) {
    $service = Get-CimInstance Win32_Service -Filter "Name='$name'"
    if (-not $service) { continue }
    if ($name -eq 'ALPRCommunityApp') { $expected = Join-Path $root 'services\ALPRCommunityApp.exe' }
    else { $expected = Join-Path $installation.pgBin 'pg_ctl.exe' }
    if ($service.PathName -notmatch ('^(?:"' + [regex]::Escape($expected) + '"|' + [regex]::Escape($expected) + ')(?:\s|$)')) {
        throw 'An ALPR service points to a different installation; no services were changed'
    }
    if ($name -eq 'ALPRCommunityDatabase' -and $service.PathName -notmatch [regex]::Escape((Join-Path $data 'management\postgres'))) {
        throw 'The database service belongs to a different data directory'
    }
    $services += $name
}
[void](Get-AlprNetworkRule ([int]$installation.environment.PORT))
if ($CheckOnly) { Write-Output 'ALPR uninstall ownership checks passed.'; exit 0 }
foreach ($name in $services) {
    Write-Output "ALPR_SETUP_PROGRESS:Stopping and removing $name..."
    $service = Get-Service -Name $name
    if ($service.Status -ne 'Stopped') {
        Stop-Service -InputObject $service
        $service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(90))
    }
    & "$env:SystemRoot\System32\sc.exe" delete $name
    if ($LASTEXITCODE -ne 0) { throw 'An ALPR service could not be removed; application files were preserved' }
}
Remove-AlprNetworkRule ([int]$installation.environment.PORT)
# Preserve the protected metadata for a later guided reinstall/recovery. The
# Inno uninstaller deletes only the verified code root; all ProgramData stays.
Copy-Item -LiteralPath $file -Destination (Join-Path $data 'management\uninstalled-installation.json') -Force
Write-Output 'ALPR_SETUP_PROGRESS:Services removed. Removing program files; your data is preserved...'
