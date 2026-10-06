#requires -Version 5.1
param(
    [Parameter(Mandatory=$true)][string]$PackageRoot,
    [Parameter(Mandatory=$true)][string]$ManifestSha256,
    [Parameter(Mandatory=$true)][string]$FromCommit,
    [Parameter(Mandatory=$true)][string]$WorkRoot
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Setup-Helpers.ps1')
$work = $null
$workCreated = $false
try {
    Assert-SetupHost
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Approve the Windows administrator prompt to repair ALPR' }
    $parent = Assert-SetupDirectory "$env:ProgramData\ALPR Community Setup"
    $work = Assert-SetupDirectory $WorkRoot
    if ((Split-Path -Parent $work) -ne $parent -or (Split-Path -Leaf $work) -notmatch '^\d{14}-\d+$' -or (Test-Path -LiteralPath $work)) { throw 'Invalid or existing repair workspace' }
    Protect-SetupDirectory $parent
    Protect-SetupDirectory $work
    $workCreated = $true
    Test-SetupPayload $PackageRoot $ManifestSha256
    $payload = Join-Path $work 'payload'
    Write-Output 'ALPR_SETUP_PROGRESS:Checking and preparing the Settings repair...'
    Copy-Item -LiteralPath $PackageRoot -Destination $payload -Recurse
    Test-SetupPayload $payload $ManifestSha256
    $env:ALPR_WINDOWS_INSTALLATION = "$env:ProgramFiles\ALPR Community\installation.json"
    $env:ALPR_CODE_REPAIR = 'ALPR_CODE_REPAIR_APPROVED'
    & (Join-Path $payload 'runtime\node.exe') (Join-Path $payload 'host\windows-code-repair.mjs') $payload $ManifestSha256 $FromCommit
    if ($LASTEXITCODE -ne 0) { throw 'The repair could not complete. See the error above or contact the maintainer.' }
    # Refresh the fixed shortcut launcher from the already verified payload.
    # The actual migration code and dependencies follow the selected release.
    $installation = Get-Content -Raw -LiteralPath $env:ALPR_WINDOWS_INSTALLATION | ConvertFrom-Json
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $payload 'windows-package.json') | ConvertFrom-Json
    if ($installation.installRoot -ne "$env:ProgramFiles\ALPR Community" -or $installation.dataRoot -ne "$env:ProgramData\ALPR Community" -or
        $installation.current -ne ($manifest.version + '-' + $manifest.commit.Substring(0,12))) { throw 'Repaired installation identity changed unexpectedly' }
    $helperBackup = Join-Path $installation.dataRoot ('management\backups\code-repair-helper-' + [Guid]::NewGuid().ToString('N'))
    Protect-SetupDirectory $helperBackup
    $helper = Join-Path $installation.installRoot 'host\ExportMigration.ps1'
    $helperTemporary = $helper + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::Copy((Join-Path $payload 'host\ExportMigration.ps1'),$helperTemporary,$false)
        [IO.File]::Replace($helperTemporary,$helper,(Join-Path $helperBackup 'ExportMigration.ps1'))
    } finally { if (Test-Path -LiteralPath $helperTemporary) { Remove-Item -LiteralPath $helperTemporary -Force } }
    # The verified code repair has attested this installation's running service.
    # Correct the older preview's delayed SCM flag without changing its data.
    & "$env:SystemRoot\System32\sc.exe" config ALPRCommunityApp start= auto
    if ($LASTEXITCODE -ne 0) { throw 'Application code was repaired, but automatic startup needs maintainer recovery' }
    $startup = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\ALPRCommunityApp'
    if ($startup.Start -ne 2 -or $startup.DelayedAutoStart) { throw 'Application code was repaired, but automatic startup verification failed' }
    Write-Output 'ALPR_SETUP_PROGRESS:Normal automatic startup verified.'
} catch {
    Write-Output ("ALPR_SETUP_ERROR:" + $_.Exception.Message)
    exit 1
} finally {
    if ($workCreated -and $work -and (Test-Path -LiteralPath $work)) {
        # Only remove the new, validated private scratch workspace. Installed
        # releases, authentication, storage and database directories are retained.
        $checked = Assert-SetupDirectory $work
        if ((Split-Path -Parent $checked) -eq "$env:ProgramData\ALPR Community Setup" -and (Split-Path -Leaf $checked) -match '^\d{14}-\d+$') {
            Remove-Item -LiteralPath $checked -Recurse -Force
        }
    }
}
