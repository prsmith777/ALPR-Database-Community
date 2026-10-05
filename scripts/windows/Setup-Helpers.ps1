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
function Assert-FreshSetup {
    foreach ($directory in @("$env:ProgramFiles\ALPR Community", "$env:ProgramData\ALPR Community")) {
        [void](Assert-SetupDirectory $directory)
        if (Test-Path -LiteralPath $directory) { throw 'ALPR or retained ALPR data already exists. This fresh-install preview preserves it; contact the maintainer for upgrade or recovery.' }
    }
    foreach ($name in @('ALPRCommunityApp','ALPRCommunityDatabase')) {
        if (Get-Service -Name $name -ErrorAction SilentlyContinue) { throw 'An ALPR service already exists. Contact the maintainer for upgrade or recovery.' }
    }
    foreach ($port in @(3000,5433)) {
        $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Any, $port)
        try { $listener.Start() } catch { throw "Port $port is in use. Close the conflicting program and run Setup again." } finally { $listener.Stop() }
    }
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
            $inputStream.CopyTo($outputStream)
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
function Expand-SetupArchive([string]$ArchiveFile, [string]$Destination, [ValidateSet('postgresql','ffmpeg')][string]$Kind) {
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

function Assert-SetupWorkRoot([string]$WorkRoot) {
    $root = Assert-SetupDirectory $WorkRoot
    $parent = [IO.Path]::GetFullPath("$env:ProgramData\ALPR Community Setup").TrimEnd('\')
    if ((Split-Path -Parent $root) -ne $parent -or (Split-Path -Leaf $root) -notmatch '^\d{14}-\d+$') {
        throw 'Unexpected private Setup workspace'
    }
    return $root
}
