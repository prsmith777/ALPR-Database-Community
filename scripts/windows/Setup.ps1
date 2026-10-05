#requires -Version 5.1
param(
    [Parameter(Mandatory = $true)][ValidateSet('prepare','install','verify','cleanup')][string]$Operation,
    [string]$PackageRoot,
    [string]$ManifestSha256,
    [string]$WorkRoot
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Setup-Helpers.ps1')

function Progress([string]$Message) { Write-Output "ALPR_SETUP_PROGRESS:$Message" }
function Native([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'A required installation step failed. The support log has details.' }
}

try {
    if ($Operation -eq 'verify') {
        Test-SetupPayload $PackageRoot $ManifestSha256
        Write-Output 'Application payload verified.'
        exit 0
    }
    $work = Assert-SetupWorkRoot $WorkRoot
    $recordFile = Join-Path $work 'setup-state.json'
    if ($Operation -eq 'cleanup') {
        if (-not (Test-Path -LiteralPath $recordFile)) { exit 0 }
        $record = Get-Content -Raw -LiteralPath $recordFile | ConvertFrom-Json
        if ($record.workRoot -ne $work -or $record.formatVersion -ne 1) { throw 'Setup workspace ownership mismatch' }
        if (Get-ChildItem -LiteralPath $work -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Setup workspace contains a link; preserved for diagnosis' }
        # Only the absolute, recorded per-attempt workspace may be removed.
        Remove-Item -LiteralPath $work -Recurse -Force
        exit 0
    }
    Assert-SetupHost
    Assert-FreshSetup
    if ($Operation -eq 'prepare') {
        Progress 'Checking your computer and the application...'
        Test-SetupPayload $PackageRoot $ManifestSha256
        if (Test-Path -LiteralPath $work) { throw 'This Setup workspace is already in use' }
        $parent = Split-Path -Parent $work
        Protect-SetupDirectory $parent
        Protect-SetupDirectory $work
        $record = @{ formatVersion=1; workRoot=$work; manifestSha256=$ManifestSha256 }
        [IO.File]::WriteAllText($recordFile, ($record | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        $payload = Join-Path $work 'payload'
        Copy-Item -LiteralPath $PackageRoot -Destination $payload -Recurse
        $pins = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'setup-prerequisites.json') | ConvertFrom-Json
        Progress 'Downloading the required database tools...'
        $pgArchive = Join-Path $work 'postgresql.zip'
        Get-SetupDownload $pins.postgresql $pgArchive
        Expand-SetupArchive $pgArchive (Join-Path $work 'postgresql') 'postgresql'
        Progress 'Downloading the required media tools...'
        $ffArchive = Join-Path $work 'ffmpeg.zip'
        Get-SetupDownload $pins.ffmpeg $ffArchive
        Expand-SetupArchive $ffArchive (Join-Path $work 'ffmpeg') 'ffmpeg'
        $pgBin = Join-Path $work 'postgresql\pgsql\bin'
        $ffRoots = @(Get-ChildItem -LiteralPath (Join-Path $work 'ffmpeg') -Directory)
        if ($ffRoots.Count -ne 1) { throw 'Unexpected media component layout' }
        $ffBin = Join-Path $ffRoots[0].FullName 'bin'
        foreach ($entry in @(@($pgBin,'postgres.exe'),@($pgBin,'pg_ctl.exe'),@($ffBin,'ffmpeg.exe'),@($ffBin,'ffprobe.exe'))) {
            if (-not (Test-Path -LiteralPath (Join-Path $entry[0] $entry[1]) -PathType Leaf)) { throw 'A required component is incomplete' }
        }
        $vc = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
        $needsVc = -not $vc -or $vc.Installed -ne 1 -or [Version]$vc.Version.TrimStart('v') -lt [Version]$pins.visualCpp.version
        if ($needsVc) {
            Progress 'Installing the required Windows runtime...'
            $vcFile = Join-Path $work 'vc_redist.x64.exe'
            Get-SetupDownload $pins.visualCpp $vcFile
            $signature = Get-AuthenticodeSignature -LiteralPath $vcFile
            if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'Windows runtime publisher verification failed' }
            $process = Start-Process -FilePath $vcFile -ArgumentList @('/install','/quiet','/norestart') -Wait -PassThru -WindowStyle Hidden
            if ($process.ExitCode -in @(3010,1641)) {
                Progress 'Windows needs to restart. Run Setup again after restarting.'
                exit 3010
            }
            if ($process.ExitCode -ne 0) { throw 'The Windows runtime could not be installed' }
        }
        $record.pgBin = $pgBin; $record.ffmpegBin = $ffBin
        [IO.File]::WriteAllText($recordFile, ($record | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        Progress 'Checking the application and recognition models...'
        Native "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" @(
            '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $payload 'Install.ps1'),
            '-CheckOnly','-AllowPreview','-PgBin',$pgBin,'-FfmpegBin',$ffBin)
        exit 0
    }
    $record = Get-Content -Raw -LiteralPath $recordFile | ConvertFrom-Json
    if ($record.workRoot -ne $work -or $record.formatVersion -ne 1 -or $record.manifestSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Setup workspace ownership mismatch' }
    $payload = Join-Path $work 'payload'
    Test-SetupPayload $payload $record.manifestSha256
    Progress 'Installing ALPR and starting its services...'
    Native "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" @(
        '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $payload 'Install.ps1'),
        '-AllowPreview','-CopyPrerequisites','-PgBin',$record.pgBin,'-FfmpegBin',$record.ffmpegBin,
        '-AdministratorPasswordFile',(Join-Path $work 'administrator-password.txt'))
    $controller = "$env:ProgramFiles\ALPR Community\host\Service-Control.ps1"
    Native "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" @(
        '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$controller,'-Operation','attest')
    Progress 'ALPR is ready. Sign in with the password you chose.'
    exit 0
} catch {
    # The wrapper records this in its support log. Never serialize the record
    # or password file; protected installation metadata contains credentials.
    Write-Output ("ALPR_SETUP_ERROR:" + $_.Exception.Message)
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
} finally {
    if ($Operation -eq 'install' -and $work -and (Test-Path -LiteralPath (Join-Path $work 'administrator-password.txt'))) {
        Remove-Item -LiteralPath (Join-Path $work 'administrator-password.txt') -Force
    }
}
