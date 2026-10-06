#requires -Version 5.1
param(
    [Parameter(Mandatory=$true)][ValidateSet('enable','disable','check')][string]$Operation,
    [string]$ExpectedUninstallerSha256
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Setup-Helpers.ps1')
. (Join-Path $PSScriptRoot 'Network-Helpers.ps1')
$lock = $null
$lockPath = $null
try {
    Assert-SetupHost
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Approve the Windows administrator prompt to configure network access' }
    $root = Assert-SetupDirectory "$env:ProgramFiles\ALPR Community"
    $file = Join-Path $root 'installation.json'
    $installation = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
    if ($installation.formatVersion -ne 1 -or $installation.profile -ne 'windows-native' -or $installation.installRoot -ne $root -or
        $installation.dataRoot -ne "$env:ProgramData\ALPR Community" -or $installation.current -notmatch '^\d+\.\d+\.\d+-[0-9a-f]{12}$' -or
        $installation.pgBin -ne (Join-Path $root 'prerequisites\postgresql\bin')) {
        throw 'This network tool does not own the recorded ALPR installation'
    }
    [void](Assert-SetupDirectory $installation.dataRoot)
    $backups = Assert-SetupDirectory (Join-Path $installation.dataRoot 'management\backups')
    [void][IO.Directory]::CreateDirectory($backups)
    $lockPath = Join-Path $backups 'maintenance.lock'
    try { $lock = [IO.File]::Open($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None) }
    catch { throw 'Another maintenance operation is in progress. Finish it before changing network access.' }
    # The snapshot must be read again under the shared maintenance lock.
    $locked = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
    if (($locked | ConvertTo-Json -Depth 12) -ne ($installation | ConvertTo-Json -Depth 12)) { throw 'The installation changed. Close and run this tool again.' }
    $updateStateFile = Join-Path $backups 'updater-state.json'
    if (Test-Path -LiteralPath $updateStateFile) {
        $updateState = Get-Content -Raw -LiteralPath $updateStateFile | ConvertFrom-Json
        if ($updateState.status -notin @('accepted','rolled-back')) { throw 'Finish the pending update before changing network access' }
    }
    $release = Assert-SetupDirectory (Join-Path $root ("releases\" + $installation.current))
    Test-SetupPayload $release (Get-FileHash -LiteralPath (Join-Path $release 'windows-package.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    foreach ($name in @('ALPRCommunityApp','ALPRCommunityDatabase')) {
        $service = Get-CimInstance Win32_Service -Filter "Name='$name'"
        $expected = Join-Path $root 'services\ALPRCommunityApp.exe'
        if ($name -eq 'ALPRCommunityDatabase') { $expected = Join-Path $installation.pgBin 'pg_ctl.exe' }
        if (-not $service -or $service.PathName -notmatch ('^(?:"' + [regex]::Escape($expected) + '"|' + [regex]::Escape($expected) + ')(?:\s|$)')) {
            throw 'An ALPR service points to a different installation; no network changes were made'
        }
        if ($name -eq 'ALPRCommunityDatabase' -and $service.PathName -notmatch [regex]::Escape((Join-Path $installation.dataRoot 'management\postgres'))) {
            throw 'The database service belongs to a different data directory'
        }
    }
    $controller = Join-Path $root 'host\Service-Control.ps1'
    # Verify the privileged controller is the one shipped with this release.
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $release 'windows-package.json') | ConvertFrom-Json
    if ((Get-FileHash -LiteralPath $controller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.files.'host/Service-Control.ps1') {
        throw 'The service controller does not match the installed release'
    }
    $identity = & $controller -Operation attest | ConvertFrom-Json
    if (-not $identity.listenerOwned -or $identity.current -ne $installation.current) { throw 'ALPR is still starting. Wait for it to open locally, then run this tool again.' }
    if ($Operation -eq 'check') {
        [void](Get-AlprNetworkRule ([int]$installation.environment.PORT))
        Write-Output 'ALPR_SETUP_PROGRESS:Network ownership checks passed. No changes made.'
        exit 0
    }
    if ($ExpectedUninstallerSha256) {
        $allowedPrevious = @($ExpectedUninstallerSha256.Split(','))
        if ($allowedPrevious.Count -gt 2 -or ($allowedPrevious | Where-Object { $_ -notmatch '^[0-9a-f]{64}$' })) { throw 'Invalid uninstaller ownership checksum' }
        $setupRoot = Assert-SetupDirectory "$env:ProgramFiles\ALPR Community Setup"
        $uninstaller = Join-Path $setupRoot 'Uninstall.ps1'
        $source = Join-Path $PSScriptRoot 'Uninstall.ps1'
        $newSha = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
        $currentSha = (Get-FileHash -LiteralPath $uninstaller -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($currentSha -notin @($allowedPrevious + @($newSha))) { throw 'The installed uninstaller does not match this network tool; no network changes were made' }
        $networkHelper = Join-Path $setupRoot 'Network-Helpers.ps1'
        if ((Test-Path -LiteralPath $networkHelper) -and
            (Get-FileHash -LiteralPath $networkHelper -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'Network-Helpers.ps1') -Algorithm SHA256).Hash) {
            throw 'An unexpected network helper already exists; no network changes were made'
        }
        if (-not (Test-Path -LiteralPath $networkHelper)) {
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Network-Helpers.ps1') -Destination $networkHelper
        }
        if ($currentSha -ne $newSha) {
            $backupScript = Join-Path $backups 'uninstaller-before-network.ps1'
            if (-not (Test-Path -LiteralPath $backupScript)) { Copy-Item -LiteralPath $uninstaller -Destination $backupScript }
            $temporary = $uninstaller + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
            try {
                Copy-Item -LiteralPath $source -Destination $temporary
                [IO.File]::Replace($temporary,$uninstaller,[NullString]::Value)
            } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
        }
    }
    Write-Output 'ALPR_SETUP_PROGRESS:Applying network access and restarting ALPR...'
    Set-AlprNetworkAccess $installation $file $Operation
    if ($Operation -eq 'enable') {
        Write-Output 'ALPR_SETUP_PROGRESS:Local network access is enabled. Sign in with your existing ALPR password.'
        try {
            foreach ($config in Get-NetIPConfiguration -ErrorAction Stop | Where-Object { $_.IPv4DefaultGateway }) {
                foreach ($address in $config.IPv4Address) { Write-Output ("ALPR_NETWORK_URL:http://" + $address.IPAddress + ':' + $installation.environment.PORT) }
            }
        } catch { Write-Output 'ALPR_SETUP_PROGRESS:Use this computer''s LAN address and ALPR port from your other devices.' }
    } else { Write-Output 'ALPR_SETUP_PROGRESS:ALPR is now available only on this computer.' }
} catch {
    Write-Output ("ALPR_SETUP_ERROR:" + $_.Exception.Message)
    exit 1
} finally {
    if ($lock) {
        $lock.Dispose()
        Remove-Item -LiteralPath $lockPath -Force
    }
}
