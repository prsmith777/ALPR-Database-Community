#requires -Version 5.1
$ErrorActionPreference = 'Stop'

function Assert-SetupDirectory([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path.StartsWith('\\') -or $Path.Contains('%')) { throw 'Use a local absolute setup path' }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $probe = $full
    while ($probe) {
        if ((Test-Path -LiteralPath $probe) -and ((Get-Item -LiteralPath $probe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Setup directories cannot contain links or junctions' }
        $probe = Split-Path -Parent $probe
    }
    return $full
}
function Protect-SetupDirectory([string]$Path) {
    $full = Assert-SetupDirectory $Path
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $installerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($sid in @('S-1-5-18','S-1-5-32-544',$installerSid) | Select-Object -Unique) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($sid)),
            'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    if (Test-Path -LiteralPath $full) {
        # A foreign owner can change a directory's DACL even after inherited
        # permissions are removed. Never adopt that directory while elevated.
        $owner = (Get-Acl -LiteralPath $full).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -notin @('S-1-5-18','S-1-5-32-544',$installerSid)) { throw 'The setup workspace belongs to another Windows account; contact the maintainer' }
        Set-Acl -LiteralPath $full -AclObject $acl
    } else {
        # Supply the private ACL at creation, rather than first creating a
        # publicly writable directory and protecting it in a later operation.
        [void][IO.Directory]::CreateDirectory($full, $acl)
    }
    [void](Assert-SetupDirectory $full)
}
function Assert-SetupHost {
    $os = Get-CimInstance Win32_OperatingSystem
    $info = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $native = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment').PROCESSOR_ARCHITECTURE
    if (-not [Environment]::Is64BitProcess -or $native -ne 'AMD64' -or $os.ProductType -ne 1 -or
        -not (([int]$os.BuildNumber -eq 19045 -and $info.DisplayVersion -eq '22H2') -or [int]$os.BuildNumber -ge 22000)) {
        throw 'ALPR requires Windows 10 22H2 or Windows 11 on an x64 computer'
    }
}
function Assert-SetupServicesAbsent {
    foreach ($name in @('ALPRCommunityApp','ALPRCommunityDatabase','ALPRCommunityUpdater')) {
        if (Get-Service -Name $name -ErrorAction SilentlyContinue) { throw 'An ALPR service already exists. Use the ALPR update or repair installer instead of reinstalling.' }
    }
}
function Assert-ExistingSetup {
    $root=Assert-SetupDirectory "$env:ProgramFiles\ALPR Community"
    $data=Assert-SetupDirectory "$env:ProgramData\ALPR Community"
    $file=Assert-SetupDirectory (Join-Path $root 'installation.json')
    foreach($item in @($root,$data,(Join-Path $data 'management'),$file)) {
        $acl=Get-Acl -LiteralPath $item
        if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)){throw 'Existing installation has an unexpected owner'}
        foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -and ([int]$rule.FileSystemRights -band 0xD0156)){throw 'Existing installation metadata is writable by another account'}
        }
    }
    $record=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if($record.profile -ne 'windows-native' -or $record.installRoot -ne $root -or $record.dataRoot -ne $data -or $record.pgBin -ne (Join-Path $root 'prerequisites\postgresql\bin') -or $record.current -notmatch '^\d+\.\d+\.\d+-[0-9a-f]{12}$'){throw 'Existing installation identity differs'}
    foreach($name in @('ALPRCommunityApp','ALPRCommunityDatabase','ALPRCommunityUpdater')) {
        $service=Get-CimInstance Win32_Service -Filter "Name='$name'"
        if(!$service){if($name -ne 'ALPRCommunityUpdater'){throw 'Existing application or database service is missing'};continue}
        $expected=Join-Path $root ('services\'+$name+'.exe')
        if($name -eq 'ALPRCommunityDatabase'){$expected=Join-Path $record.pgBin 'pg_ctl.exe'}
        if($service.PathName -notmatch ('^(?:"'+[regex]::Escape($expected)+'"|'+[regex]::Escape($expected)+')(?:\s|$)')){throw 'An ALPR service belongs to another installation'}
        if($name -eq 'ALPRCommunityDatabase' -and $service.PathName -notmatch [regex]::Escape((Join-Path $data 'management\postgres'))){throw 'Database data directory differs'}
    }
    if((Test-Path -LiteralPath (Join-Path $data 'management\updates\active.json')) -or (Test-Path -LiteralPath (Join-Path $data 'management\backups\maintenance.lock'))){throw 'Wait for the current backup or update to finish'}
    return $record
}
function Get-RetainedSetup([string]$InstallRoot, [string]$DataRoot) {
    $root = Assert-SetupDirectory $InstallRoot
    $data = Assert-SetupDirectory $DataRoot
    if (Test-Path -LiteralPath $root) { throw 'ALPR program files already exist. Use the update or repair installer.' }
    $metadata = Join-Path $data 'management\uninstalled-installation.json'
    [void](Assert-SetupDirectory $metadata)
    if (-not (Test-Path -LiteralPath $metadata -PathType Leaf)) { throw 'Retained ALPR recovery metadata is missing. Existing data was preserved.' }
    # A writable metadata file or parent could substitute credentials/paths
    # while Setup is elevated. Do not adopt data owned by an unrelated user.
    $trusted = @('S-1-5-18','S-1-5-32-544',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    foreach ($item in @($data,(Join-Path $data 'management'),$metadata)) {
        $acl = Get-Acl -LiteralPath $item
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Retained ALPR data has an unexpected owner' }
        foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted -and
                ([int]$rule.FileSystemRights -band 0xD0156)) { throw 'Retained ALPR recovery metadata is writable by another account' }
        }
    }
    $record = Get-Content -Raw -LiteralPath $metadata | ConvertFrom-Json
    if ($record.formatVersion -ne 1 -or $record.profile -ne 'windows-native' -or
        $record.installRoot -ne $root -or $record.dataRoot -ne $data -or
        $record.pgBin -ne (Join-Path $root 'prerequisites\postgresql\bin') -or
        $record.current -notmatch '^\d+\.\d+\.\d+-[0-9a-f]{12}$') { throw 'Retained ALPR installation identity is invalid' }
    $e = $record.environment
    if ($e.ALPR_DATA_DIR -ne $data -or $e.DB_NAME -ne 'postgres' -or $e.DB_USER -ne 'postgres' -or
        $e.DB_HOST -notmatch '^127\.0\.0\.1:(\d{4,5})$' -or
        [int]$Matches[1] -lt 1024 -or [int]$Matches[1] -gt 65535 -or
        [string]$e.PORT -notmatch '^\d{4,5}$' -or [int]$e.PORT -lt 1024 -or [int]$e.PORT -gt 65535 -or
        $e.HOSTNAME -notin @('127.0.0.1','0.0.0.0') -or -not $e.DB_PASSWORD -or -not $e.ADMIN_PASSWORD -or
        $e.DB_PASSWORD -match '[\x00-\x1f]' -or $e.ADMIN_PASSWORD -match '[\x00-\x1f]') { throw 'Retained ALPR connection settings are invalid' }
    $database = Join-Path $data 'management\postgres'
    if ((Get-Content -Raw -LiteralPath (Join-Path $database 'PG_VERSION')).Trim() -ne '17') { throw 'Retained recovery requires PostgreSQL 17' }
    # Reject links before walking/copying the cluster or private files.
    $pending = New-Object 'Collections.Generic.Stack[string]'
    $pending.Push($data)
    while ($pending.Count) {
        foreach ($child in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Retained ALPR data contains a link or junction' }
            if ($child.PSIsContainer) { $pending.Push($child.FullName) }
        }
    }
    if (Test-Path -LiteralPath (Join-Path $database 'postmaster.pid')) { throw 'The retained database was not cleanly stopped. Preserve the data and contact the maintainer.' }
    return $record
}
function Assert-FreshSetup([switch]$ReuseRetainedData) {
    Assert-SetupServicesAbsent
    $ports = @(3000,5433)
    if ($ReuseRetainedData) {
        $retained = Get-RetainedSetup "$env:ProgramFiles\ALPR Community" "$env:ProgramData\ALPR Community"
        $ports = @([int]$retained.environment.PORT,[int]($retained.environment.DB_HOST.Split(':')[-1]))
    } else {
        foreach ($directory in @("$env:ProgramFiles\ALPR Community", "$env:ProgramData\ALPR Community")) {
            [void](Assert-SetupDirectory $directory)
            if (Test-Path -LiteralPath $directory) { throw 'ALPR or retained ALPR data already exists. Choose Restore the ALPR data already on this computer, or use the update/repair installer.' }
        }
    }
    foreach ($port in $ports) {
        $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Any, $port)
        try { $listener.Start() } catch { throw "Port $port is in use. Close the conflicting program and run Setup again." } finally { $listener.Stop() }
    }
}
function Backup-RetainedSetup([string]$DataRoot) {
    $data = Assert-SetupDirectory $DataRoot
    $backup = Join-Path $data ('management\reinstall-backups\' + [Guid]::NewGuid().ToString('N'))
    $bytes = [long]0
    foreach ($name in @('management\postgres','auth','config')) {
        foreach ($file in Get-ChildItem -LiteralPath (Join-Path $data $name) -File -Recurse -Force) { $bytes += $file.Length }
    }
    $volume = Get-Volume -DriveLetter $data.Substring(0,1)
    if ($volume.SizeRemaining -lt ($bytes + 512MB)) { throw 'Not enough free space to verify a retained database backup. Free disk space and run Setup again.' }
    # Permanent database backups exclude the application service and the
    # installing user's filtered token. initdb does not run in this directory.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    }
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    [void][IO.Directory]::CreateDirectory($backup,$acl)
    $inventory = @{}
    foreach ($name in @('management\postgres','auth','config')) {
        $source = Join-Path $data $name
        $target = Join-Path $backup $name
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $target))
        Copy-Item -LiteralPath $source -Destination $target -Recurse
        $files = @(Get-ChildItem -LiteralPath $source -File -Recurse -Force)
        $copies = @(Get-ChildItem -LiteralPath $target -File -Recurse -Force)
        if ($files.Count -ne $copies.Count) { throw 'Retained data backup inventory is incomplete' }
        foreach ($file in $files) {
            $copy = Join-Path $target $file.FullName.Substring($source.Length + 1)
            $hash = (Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()
            if ($hash -ne (Get-FileHash -LiteralPath $copy).Hash.ToLowerInvariant()) { throw 'Retained data backup checksum mismatch' }
            $inventory[($name.Replace('\','/') + '/' + $file.FullName.Substring($source.Length + 1).Replace('\','/'))] = $hash
        }
    }
    Copy-Item -LiteralPath (Join-Path $data 'management\uninstalled-installation.json') -Destination (Join-Path $backup 'installation.json')
    $inventory['installation.json'] = (Get-FileHash -LiteralPath (Join-Path $backup 'installation.json')).Hash.ToLowerInvariant()
    $verification = @{formatVersion=1;status='verified';createdAt=[DateTime]::UtcNow.ToString('o');files=$inventory}
    [IO.File]::WriteAllText((Join-Path $backup 'verified.json'),($verification | ConvertTo-Json -Depth 4),(New-Object Text.UTF8Encoding($false)))
    return $backup
}
function Test-SetupPayload([string]$PackageRoot, [string]$ManifestSha256) {
    $root = Assert-SetupDirectory $PackageRoot
    if ($ManifestSha256 -notmatch '^[0-9a-f]{64}$' -or
        (Get-FileHash -LiteralPath (Join-Path $root 'windows-package.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ManifestSha256) {
        throw 'The application package does not match this installer'
    }
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $root 'windows-package.json') | ConvertFrom-Json
    if ($manifest.source -ne 'https://github.com/prsmith777/ALPR-Database-Community' -or $manifest.platform -ne 'win32' -or
        $manifest.arch -ne 'x64' -or $manifest.formatVersion -ne 1) { throw 'Unsupported ALPR package' }
    $all = @(Get-ChildItem -LiteralPath $root -Force -Recurse)
    if ($all | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'The package contains a link or junction' }
    $files = @($all | Where-Object { -not $_.PSIsContainer -and $_.FullName -ne (Join-Path $root 'windows-package.json') })
    if ($files.Count -ne @($manifest.files.PSObject.Properties).Count) { throw 'Incomplete application package' }
    foreach ($file in $files) {
        $name = $file.FullName.Substring($root.Length + 1).Replace('\','/')
        $expected = $manifest.files.PSObject.Properties[$name].Value
        if ($expected -notmatch '^[0-9a-f]{64}$' -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
            throw "Damaged application file: $name"
        }
    }
}
function Get-SetupDownload([object]$Pin, [string]$Destination) {
    if ($Pin.sha256 -notmatch '^[0-9a-f]{64}$' -or $Pin.url -notmatch '^https://') { throw 'Invalid prerequisite pin' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $response = $null; $inputStream = $null; $outputStream = $null
        try {
            $request = [Net.HttpWebRequest]::Create($Pin.url)
            $request.Timeout = 30000; $request.ReadWriteTimeout = 30000
            $response = $request.GetResponse()
            $inputStream = $response.GetResponseStream()
            $outputStream = [IO.File]::Create($Destination)
            $buffer = New-Object byte[] 1048576
            $downloaded = [long]0; $lastPercent = -1
            while (($read = $inputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
                $outputStream.Write($buffer,0,$read)
                $downloaded += $read
                if ($response.ContentLength -gt 0) {
                    $percent = [Math]::Min(100,[int]([Math]::Floor(100.0 * $downloaded / $response.ContentLength)))
                    if ($percent -ne $lastPercent) { Write-Output "ALPR_SETUP_PERCENT:$percent"; $lastPercent = $percent }
                }
            }
            $outputStream.Dispose(); $outputStream = $null
            if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Pin.sha256) { throw 'Downloaded component failed verification' }
            return
        } catch {
            if ($attempt -eq 3) { throw 'A required component could not be downloaded or verified. Check the internet connection and run Setup again.' }
            Start-Sleep -Seconds $attempt
        } finally {
            if ($outputStream) { $outputStream.Dispose() }
            if ($inputStream) { $inputStream.Dispose() }
            if ($response) { $response.Dispose() }
        }
    }
}
function Expand-SetupArchive([string]$ArchiveFile, [string]$Destination, [ValidateSet('postgresql','ffmpeg','community')][string]$Kind) {
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $root = Assert-SetupDirectory $Destination
    if (Test-Path -LiteralPath $root) { throw 'Archive destination is already used' }
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchiveFile)
    try {
        # Validate every entry, even ones omitted from the PostgreSQL extraction.
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\','/')
            $parts = $name.TrimEnd('/').Split('/')
            $badParts = @($parts | Where-Object {
                -not $_ -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[\x00-\x1f<>:"|?*]' -or $_ -match '[. ]$' -or
                $_ -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)'
            })
            if (-not $name -or $name.StartsWith('/') -or $badParts.Count -gt 0) { throw 'Unsafe prerequisite archive path' }
        }
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\','/')
            if ($name.EndsWith('/')) { continue }
            if ($Kind -eq 'postgresql' -and $name -notmatch '^pgsql/(bin|lib|share)/') { continue }
            $file = [IO.Path]::GetFullPath((Join-Path $root $name))
            if (-not $file.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive escapes its destination' }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$file)
        }
    } finally { $archive.Dispose() }
}

function Wait-SetupChildProcess([Diagnostics.Process]$Process, [scriptblock]$WhileWaiting) {
    # Inbox PowerShell 5.1 can lose ExitCode when a Start-Process instance is
    # refreshed after redirecting output. Keep its native handle open and wait
    # without Refresh so successful backups are not reported as failures.
    $null = $Process.Handle
    while (-not $Process.WaitForExit(200)) {
        if ($WhileWaiting) { [void](& $WhileWaiting) }
    }
    $Process.WaitForExit()
    if ($null -eq $Process.ExitCode) { throw 'Windows did not return the maintenance process result. Check the diagnostic log.' }
    return [int]$Process.ExitCode
}

function Assert-SetupWorkRoot([string]$WorkRoot) {
    $root = Assert-SetupDirectory $WorkRoot
    $parent = [IO.Path]::GetFullPath("$env:ProgramData\ALPR Community Setup").TrimEnd('\')
    if ((Split-Path -Parent $root) -ne $parent -or (Split-Path -Leaf $root) -notmatch '^\d{14}-\d+$') {
        throw 'Unexpected private Setup workspace'
    }
    return $root
}

function Test-InstalledSetupPayload([string]$PackageRoot, [string]$InstallRoot = "$env:ProgramFiles\ALPR Community") {
    $root = Assert-SetupDirectory $InstallRoot
    $expected = Get-Content -LiteralPath (Join-Path $PackageRoot 'windows-package.json') -Raw | ConvertFrom-Json
    $installed = Get-Content -LiteralPath (Join-Path $root 'installation.json') -Raw | ConvertFrom-Json
    $name = "$($expected.version)-$($expected.commit.Substring(0,12))"
    if ($installed.current -ne $name -or $installed.installRoot -ne $root) { throw 'The installed application is still on a different release. Setup has stopped.' }
    $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $output = & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'host\Service-Control.ps1') -Operation attest
    if ($LASTEXITCODE -ne 0) { throw 'The installed application could not attest its running release' }
    $running = ($output -join [Environment]::NewLine) | ConvertFrom-Json
    if ($running.current -ne $name -or $running.commit -ne $expected.commit -or $running.status -ne 'Running' -or $running.listenerOwned -ne $true) { throw 'The running application does not own the expected release listener' }
}
