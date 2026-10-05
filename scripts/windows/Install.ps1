#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = "$env:ProgramFiles\ALPR Community",
    [string]$DataRoot = "$env:ProgramData\ALPR Community",
    [string]$PgBin = "$env:ProgramFiles\PostgreSQL\17\bin",
    [Parameter(Mandatory = $true)][string]$FfmpegBin,
    [ValidateRange(1024,65535)][int]$AppPort = 3000,
    [ValidateRange(1024,65535)][int]$DatabasePort = 5433,
    [switch]$AllowPreview,
    [switch]$CheckOnly,
    [switch]$ListenOnNetwork,
    [switch]$CopyPrerequisites,
    [string]$AdministratorPasswordFile
)
$ErrorActionPreference = 'Stop'
$packageRoot = $PSScriptRoot
. (Join-Path $packageRoot 'host\Network-Helpers.ps1')
function Invoke-Native([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable failed (exit $LASTEXITCODE)" }
}
function Assert-LocalPath([string]$Candidate) {
    if ($Candidate.Contains('%')) { throw 'Percent signs in paths are not supported by the service wrapper' }
    if (-not [IO.Path]::IsPathRooted($Candidate) -or $Candidate.StartsWith('\\')) { throw 'Use absolute paths on a local NTFS drive' }
    $full = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
    if ($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) { throw 'A filesystem root cannot be used' }
    $drive = Get-Volume -DriveLetter $full.Substring(0,1)
    if ($drive.FileSystem -ne 'NTFS') { throw 'Native ALPR data and releases require NTFS' }
    $probe = $full
    while ($probe) {
        if ((Test-Path -LiteralPath $probe) -and ((Get-Item -LiteralPath $probe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Install paths cannot contain reparse points' }
        $probe = Split-Path -Parent $probe
    }
    return $full
}
function Assert-PortAvailable([int]$Port) {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Any, $Port)
    try { $listener.Start() } finally { $listener.Stop() }
}
function Set-PrivateAcl([string]$Path, [string]$ServiceSid = '', [string]$Rights = 'Modify', [bool]$InheritServiceAccess = $true, [string]$AdditionalReadSid = '') {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($sid)),
            'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    if ($ServiceSid) {
        $inheritance = 'None'
        if ($InheritServiceAccess) { $inheritance = 'ContainerInherit,ObjectInherit' }
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($ServiceSid)),
            $Rights, $inheritance, 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    if ($AdditionalReadSid) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($AdditionalReadSid)),
            'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Resolve-ServiceSid([string]$Name) {
    return (New-Object Security.Principal.NTAccount("NT SERVICE\$Name")).Translate([Security.Principal.SecurityIdentifier]).Value
}
function Write-Utf8([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}
function New-Secret {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($bytes).Replace('+','-').Replace('/','_').TrimEnd('=')
}
$os = Get-CimInstance Win32_OperatingSystem
$versionInfo = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$nativeArchitecture = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment').PROCESSOR_ARCHITECTURE
if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess -or
    $os.OSArchitecture -notmatch '64' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or $nativeArchitecture -ne 'AMD64' -or $os.ProductType -ne 1 -or
    -not (([int]$os.BuildNumber -eq 19045 -and $versionInfo.DisplayVersion -eq '22H2') -or [int]$os.BuildNumber -ge 22000)) {
    throw 'Use 64-bit PowerShell on Windows 10 22H2 x64 or Windows 11 x64'
}
$installPath = Assert-LocalPath $InstallRoot
$dataPath = Assert-LocalPath $DataRoot
$selectedAdminPassword = $null
if ($AdministratorPasswordFile) {
    $passwordPath = Assert-LocalPath $AdministratorPasswordFile
    $selectedAdminPassword = [IO.File]::ReadAllText($passwordPath)
    if ($selectedAdminPassword.Length -lt 12 -or $selectedAdminPassword.Length -gt 128 -or $selectedAdminPassword -match '[\x00-\x1f]') {
        throw 'Choose an administrator password containing 12 to 128 characters'
    }
}
$PgBin = Assert-LocalPath $PgBin
$FfmpegBin = Assert-LocalPath $FfmpegBin
if ($installPath -eq $dataPath -or $dataPath.StartsWith("$installPath\",[StringComparison]::OrdinalIgnoreCase) -or
    $installPath.StartsWith("$dataPath\",[StringComparison]::OrdinalIgnoreCase)) { throw 'Release and data roots must be separate' }
foreach ($directory in @($installPath,$dataPath)) {
    if (Test-Path -LiteralPath $directory) { throw "Fresh install requires unused directory: $directory" }
}
foreach ($service in @('ALPRCommunityApp','ALPRCommunityDatabase')) {
    if (Get-Service -Name $service -ErrorAction SilentlyContinue) { throw "ALPR service already exists: $service" }
}
Assert-PortAvailable $AppPort
Assert-PortAvailable $DatabasePort
if ($AppPort -eq $DatabasePort) { throw 'Application and database ports must differ' }
foreach ($name in @('postgres.exe','pg_ctl.exe','initdb.exe','psql.exe','pg_dump.exe','pg_restore.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PgBin $name) -PathType Leaf)) { throw "Install PostgreSQL 17 with command-line tools: missing $name" }
}
$pgVersion = & (Join-Path $PgBin 'psql.exe') --version
if ($LASTEXITCODE -ne 0 -or $pgVersion -notmatch 'PostgreSQL\) 17\.') { throw 'PostgreSQL major version 17 is required' }
foreach ($name in @('ffmpeg.exe','ffprobe.exe')) {
    Invoke-Native (Join-Path $FfmpegBin $name) @('-version')
}
# Verify the complete file inventory before executing any bundled program.
$manifest = Get-Content -Raw -LiteralPath (Join-Path $packageRoot 'windows-package.json') | ConvertFrom-Json
if ($manifest.formatVersion -ne 1 -or $manifest.source -ne 'https://github.com/prsmith777/ALPR-Database-Community' -or
    $manifest.platform -ne 'win32' -or $manifest.arch -ne 'x64' -or $manifest.commit -notmatch '^[0-9a-f]{40}$' -or
    $manifest.version -notmatch '^\d+\.\d+\.\d+$' -or (-not $AllowPreview -and $manifest.channel -ne 'stable')) { throw 'Unsupported package; development packages require -AllowPreview' }
$plannedReleasePath = Join-Path $installPath ("releases\" + $manifest.version + '-' + $manifest.commit.Substring(0,12))
foreach ($property in $manifest.files.PSObject.Properties) {
    if (($packageRoot.Length + 1 + $property.Name.Length) -ge 260 -or ($plannedReleasePath.Length + 1 + $property.Name.Length) -ge 260) {
        throw 'Use shorter package and installation paths for inbox PowerShell compatibility'
    }
}
$actual = @(Get-ChildItem -LiteralPath $packageRoot -Recurse -Force)
foreach ($item in $actual) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package contains a reparse point' }
}
$files = @($actual | Where-Object { -not $_.PSIsContainer -and $_.FullName -ne (Join-Path $packageRoot 'windows-package.json') })
if ($files.Count -ne @($manifest.files.PSObject.Properties).Count) { throw 'Package inventory mismatch' }
foreach ($file in $files) {
    $name = $file.FullName.Substring($packageRoot.Length + 1).Replace('\','/')
    $expected = $manifest.files.PSObject.Properties[$name].Value
    if ($expected -notmatch '^[0-9a-f]{64}$' -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw "Package checksum mismatch: $name" }
}
$node = Join-Path $packageRoot 'runtime\node.exe'
if ((& $node -p 'process.versions.node').Split('.')[0] -ne '24') { throw 'Bundled Node.js must be version 24' }
Push-Location (Join-Path $packageRoot 'app')
try { Invoke-Native $node @('openvino-runtime-probe.cjs') } finally { Pop-Location }
if ($CheckOnly) { Write-Output 'Native Windows prerequisites and package checks passed. No changes made.'; return }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run the installer in an elevated 64-bit PowerShell window' }
if ($ListenOnNetwork -and (Get-AlprNetworkRule $AppPort)) { throw 'An ALPR network rule already exists. Preserve it and contact the maintainer.' }
# All checks above precede creation, service registration, and database initialization.
New-Item -ItemType Directory -Path $installPath,$dataPath | Out-Null
$installerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
# PostgreSQL drops the Administrator group while initializing. Its packaged
# executables/share files need the installing user's explicit read grant too.
Set-PrivateAcl $installPath $installerSid 'ReadAndExecute'
# initdb drops Administrator group privileges on Windows. Grant the installing
# user's SID during initialization, then replace it with service-specific ACLs.
Set-PrivateAcl $dataPath $installerSid 'FullControl'
$management = Join-Path $dataPath 'management'
$database = Join-Path $management 'postgres'
New-Item -ItemType Directory -Path $management | Out-Null
foreach ($name in @('auth','config','logs','storage','update-control')) { New-Item -ItemType Directory -Path (Join-Path $dataPath $name) | Out-Null }
$releaseName = "$($manifest.version)-$($manifest.commit.Substring(0,12))"
$releasePath = Join-Path $installPath "releases\$releaseName"
New-Item -ItemType Directory -Path (Split-Path -Parent $releasePath) | Out-Null
Copy-Item -LiteralPath $packageRoot -Destination $releasePath -Recurse
if ($CopyPrerequisites) {
    $prerequisites = Join-Path $installPath 'prerequisites'
    New-Item -ItemType Directory -Path $prerequisites | Out-Null
    Copy-Item -LiteralPath (Split-Path -Parent $PgBin) -Destination (Join-Path $prerequisites 'postgresql') -Recurse
    Copy-Item -LiteralPath (Split-Path -Parent $FfmpegBin) -Destination (Join-Path $prerequisites 'ffmpeg') -Recurse
    $PgBin = Join-Path $prerequisites 'postgresql\bin'
    $FfmpegBin = Join-Path $prerequisites 'ffmpeg\bin'
}
New-Item -ItemType Directory -Path (Join-Path $installPath 'host'),(Join-Path $installPath 'runtime'),(Join-Path $installPath 'services') | Out-Null
Copy-Item -Path (Join-Path $releasePath 'host\*') -Destination (Join-Path $installPath 'host') -Recurse
Copy-Item -Path (Join-Path $releasePath 'runtime\*') -Destination (Join-Path $installPath 'runtime')
$dbPassword = New-Secret
$adminPassword = New-Secret
if ($null -ne $selectedAdminPassword) { $adminPassword = $selectedAdminPassword }
$hostAddress = '127.0.0.1'
if ($ListenOnNetwork) { $hostAddress = '0.0.0.0' }
$environment = @{
    NODE_ENV='production'; ALPR_DEPLOYMENT_PROFILE='windows-native'; ALPR_DATA_DIR=$dataPath;
    HOSTNAME=$hostAddress; PORT=[string]$AppPort; DB_HOST="127.0.0.1:$DatabasePort";
    DB_NAME='postgres'; DB_USER='postgres'; DB_PASSWORD=$dbPassword; ADMIN_PASSWORD=$adminPassword;
    ALPR_LOG_DIR=(Join-Path $dataPath 'logs'); ALPR_UPDATE_CONTROL_DIR=(Join-Path $dataPath 'update-control');
    SESSION_COOKIE_SECURE='false'; PATH="$FfmpegBin;$env:PATH"
}
$installation = @{
    formatVersion=1; profile='windows-native'; installRoot=$installPath; dataRoot=$dataPath;
    pgBin=([IO.Path]::GetFullPath($PgBin)); current=$releaseName; environment=$environment
}
Write-Utf8 (Join-Path $installPath 'installation.json') ($installation | ConvertTo-Json -Depth 8)
$pwfile = Join-Path $management 'initdb-password.tmp'
Write-Utf8 $pwfile ($dbPassword + [Environment]::NewLine)
$dbRegistered = $false
$appRegistered = $false
$networkRuleCreated = $false
$originalPgPassword = $env:PGPASSWORD
try {
    Invoke-Native (Join-Path $PgBin 'initdb.exe') @('-D',$database,'-U','postgres','--encoding=UTF8','--auth-host=scram-sha-256','--auth-local=scram-sha-256',"--pwfile=$pwfile")
    Add-Content -LiteralPath (Join-Path $database 'postgresql.conf') -Value "listen_addresses = '127.0.0.1'`nport = $DatabasePort`nlogging_collector = on`nlog_directory = 'log'`nlog_rotation_age = '1d'`nlog_rotation_size = '10MB'`nlog_truncate_on_rotation = on`nlog_filename = 'postgresql-%a.log'"
    Invoke-Native (Join-Path $PgBin 'pg_ctl.exe') @('register','-N','ALPRCommunityDatabase','-D',$database,'-S','auto','-U','NT AUTHORITY\NetworkService')
    $dbRegistered = $true
    Invoke-Native "$env:SystemRoot\System32\sc.exe" @('sidtype','ALPRCommunityDatabase','unrestricted')
    $dbSid = Resolve-ServiceSid 'ALPRCommunityDatabase'
    if ($CopyPrerequisites) { Set-PrivateAcl $installPath $installerSid 'ReadAndExecute' $true $dbSid }
    Set-PrivateAcl $management $dbSid 'ReadAndExecute' $false
    # Reset inherited/initializer ACLs only inside this newly created cluster,
    # then propagate the database service SID from its protected directory.
    if ([IO.Path]::GetFullPath($database) -ne [IO.Path]::GetFullPath((Join-Path $management 'postgres'))) { throw 'Unexpected database ACL target' }
    Invoke-Native "$env:SystemRoot\System32\icacls.exe" @($database,'/reset','/T','/Q')
    Set-PrivateAcl $database $dbSid 'Modify'
    Start-Service -Name ALPRCommunityDatabase
    $ready = $false
    $env:PGPASSWORD = $dbPassword
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        & (Join-Path $PgBin 'psql.exe') -X -h 127.0.0.1 -p $DatabasePort -U postgres -d postgres -Atc 'SELECT 1' 2>$null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'PostgreSQL did not become ready' }
    foreach ($sql in @('schema.sql','migrations.sql')) {
        Invoke-Native (Join-Path $PgBin 'psql.exe') @('-X','-h','127.0.0.1','-p',[string]$DatabasePort,'-U','postgres','-d','postgres','--set','ON_ERROR_STOP=1','--single-transaction','--file',(Join-Path $releasePath $sql))
    }
    $serviceFile = Join-Path $installPath 'services\ALPRCommunityApp.exe'
    Copy-Item -LiteralPath (Join-Path $installPath 'runtime\winsw.exe') -Destination $serviceFile
    $xmlNode = [Security.SecurityElement]::Escape((Join-Path $installPath 'runtime\node.exe'))
    $xmlHost = [Security.SecurityElement]::Escape((Join-Path $installPath 'host\windows-service.mjs'))
    $xmlInstallation = [Security.SecurityElement]::Escape((Join-Path $installPath 'installation.json'))
    $xmlLogs = [Security.SecurityElement]::Escape((Join-Path $dataPath 'logs'))
    $xml = "<service><id>ALPRCommunityApp</id><name>ALPR Community</name><description>Native ALPR Community application</description><executable>$xmlNode</executable><arguments>&quot;$xmlHost&quot; &quot;$xmlInstallation&quot;</arguments><workingdirectory>$([Security.SecurityElement]::Escape($installPath))</workingdirectory><serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount><depend>ALPRCommunityDatabase</depend><startmode>Automatic</startmode><delayedAutoStart>false</delayedAutoStart><onfailure action='restart' delay='10 sec'/><stoptimeout>60 sec</stoptimeout><logpath>$xmlLogs</logpath><log mode='roll-by-size'><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log></service>"
    Write-Utf8 (Join-Path $installPath 'services\ALPRCommunityApp.xml') $xml
    Invoke-Native $serviceFile @('install')
    $appRegistered = $true
    Invoke-Native "$env:SystemRoot\System32\sc.exe" @('sidtype','ALPRCommunityApp','unrestricted')
    $appSid = Resolve-ServiceSid 'ALPRCommunityApp'
    $databaseCodeSid = ''
    if ($CopyPrerequisites) { $databaseCodeSid = $dbSid }
    Set-PrivateAcl $installPath $appSid 'ReadAndExecute' $true $databaseCodeSid
    Set-PrivateAcl $dataPath $appSid 'ReadAndExecute'
    # Re-protect management after granting traversal on the data root.
    Set-PrivateAcl $management $dbSid 'ReadAndExecute' $false
    Set-PrivateAcl $database $dbSid 'Modify'
    foreach ($name in @('auth','config','logs','storage','update-control')) { Set-PrivateAcl (Join-Path $dataPath $name) $appSid 'Modify' }
    Start-Service -Name ALPRCommunityApp
    $healthy = $false
    for ($attempt=0; $attempt -lt 60; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$AppPort/api/health-check" -TimeoutSec 3
            if ($health.status -eq 'ok') { $healthy = $true; break }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $healthy) { throw 'Application health check failed; preserve the installation and inspect service logs' }
    if ($ListenOnNetwork) {
        $networkRuleCreated = $true
        New-AlprNetworkRule $AppPort
    }
    if (-not $AdministratorPasswordFile) {
        Write-Utf8 (Join-Path $management 'initial-login.txt') ("Administrator password: $adminPassword" + [Environment]::NewLine)
        Write-Output "ALPR is available at http://localhost:$AppPort. Initial sign-in is saved in $management\initial-login.txt (Administrators only). Store the password and delete that file after first sign-in."
    } else {
        Write-Output "ALPR is available at http://localhost:$AppPort. Sign in using the administrator password you chose in Setup."
    }
} catch {
    if ($appRegistered) { Stop-Service ALPRCommunityApp -ErrorAction SilentlyContinue }
    if ($dbRegistered) { Stop-Service ALPRCommunityDatabase -ErrorAction SilentlyContinue }
    if ($networkRuleCreated) { Remove-AlprNetworkRule $AppPort }
    Write-Utf8 (Join-Path $management 'installer-error.txt') $_.Exception.Message
    throw
} finally {
    if ($null -eq $originalPgPassword) { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
    else { $env:PGPASSWORD = $originalPgPassword }
    if (Test-Path -LiteralPath $pwfile) { Remove-Item -LiteralPath $pwfile -Force }
}
