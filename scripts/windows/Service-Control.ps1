#requires -Version 5.1
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('start','stop','status','attest')][string]$Operation
)
$ErrorActionPreference = 'Stop'
# Deliberately no user-selected service name, executable, arguments, or shell.
$service = Get-Service -Name 'ALPRCommunityApp'
switch ($Operation) {
    'start' { Start-Service -InputObject $service; $service.WaitForStatus('Running',[TimeSpan]::FromSeconds(60)) }
    'stop' { Stop-Service -InputObject $service; $service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(90)) }
    'status' { Write-Output $service.Status.ToString() }
    'attest' {
        $root = Split-Path -Parent $PSScriptRoot
        $installation = Get-Content -Raw -LiteralPath (Join-Path $root 'installation.json') | ConvertFrom-Json
        if ($installation.current -notmatch '^\d+\.\d+\.\d+-[0-9a-f]{12}$' -or $installation.installRoot -ne $root) { throw 'Invalid protected installation metadata' }
        $release = Join-Path $root ("releases\" + $installation.current)
        $manifest = Get-Content -Raw -LiteralPath (Join-Path $release 'windows-package.json') | ConvertFrom-Json
        $record = Get-CimInstance Win32_Service -Filter "Name='ALPRCommunityApp'"
        if ($record.State -ne 'Running' -or $record.ProcessId -eq 0) { throw 'ALPR application service is not running' }
        $launcher = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $record.ProcessId) |
            Where-Object { $_.ExecutablePath -eq (Join-Path $root 'runtime\node.exe') })
        if ($launcher.Count -ne 1) { throw 'ALPR service launcher identity mismatch' }
        $application = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $launcher[0].ProcessId) |
            Where-Object { $_.ExecutablePath -eq (Join-Path $release 'runtime\node.exe') })
        if ($application.Count -ne 1) { throw 'Running process does not belong to the selected release' }
        $port = [int]$installation.environment.PORT
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop)
        if (-not ($listeners | Where-Object { $_.OwningProcess -eq $application[0].ProcessId })) { throw 'ALPR listener is owned by a different process' }
        @{ current=$installation.current; commit=$manifest.commit; status='Running'; listenerOwned=$true } | ConvertTo-Json -Compress
    }
}
