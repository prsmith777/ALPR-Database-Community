#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$script:AlprNetworkRuleName = 'ALPRCommunityApp-LocalSubnet'
$script:AlprNetworkRuleGroup = 'ALPR Database Community'
$script:AlprNetworkRuleDescription = 'Native ALPR Community application port; local subnet only.'

function Get-AlprNetworkRule([int]$Port) {
    $rules = @(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop |
        Where-Object { $_.Name -eq $script:AlprNetworkRuleName })
    if ($rules.Count -gt 1) { throw 'More than one ALPR network rule exists; no network changes were made' }
    if ($rules.Count -eq 0) { return $null }
    $rule = $rules[0]
    $ports = @($rule | Get-NetFirewallPortFilter -ErrorAction Stop)
    $addresses = @($rule | Get-NetFirewallAddressFilter -ErrorAction Stop)
    $applications = @($rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
    if ($rule.Group -ne $script:AlprNetworkRuleGroup -or $rule.Description -ne $script:AlprNetworkRuleDescription -or
        [string]$rule.Direction -ne 'Inbound' -or [string]$rule.Action -ne 'Allow' -or [string]$rule.Profile -ne 'Any' -or
        [string]$rule.EdgeTraversalPolicy -ne 'Block' -or $ports.Count -ne 1 -or $addresses.Count -ne 1 -or $applications.Count -ne 1 -or
        [string]$ports[0].Protocol -notin @('TCP','6') -or [string]$ports[0].LocalPort -ne [string]$Port -or
        [string]$ports[0].RemotePort -ne 'Any' -or [string]$addresses[0].RemoteAddress -ne 'LocalSubnet' -or
        [string]$addresses[0].LocalAddress -ne 'Any' -or [string]$applications[0].Program -ne 'Any') {
        throw 'The ALPR network rule has an unexpected owner or scope; no network changes were made'
    }
    return $rule
}

function New-AlprNetworkRule([int]$Port) {
    if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid ALPR application port' }
    if (Get-AlprNetworkRule $Port) { throw 'An ALPR network rule already exists' }
    New-NetFirewallRule -PolicyStore PersistentStore -Name $script:AlprNetworkRuleName -DisplayName 'ALPR Community - local network access' `
        -Group $script:AlprNetworkRuleGroup -Description $script:AlprNetworkRuleDescription -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Profile Any -EdgeTraversalPolicy Block -Enabled True -ErrorAction Stop | Out-Null
    [void](Get-AlprNetworkRule $Port)
}

function Remove-AlprNetworkRule([int]$Port) {
    if (Get-AlprNetworkRule $Port) {
        Remove-NetFirewallRule -PolicyStore PersistentStore -Name $script:AlprNetworkRuleName -ErrorAction Stop
    }
}

function Write-AlprInstallationAtomically([string]$File, [object]$Installation) {
    $temporary = $File + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary,($Installation | ConvertTo-Json -Depth 12),(New-Object Text.UTF8Encoding($false)))
        # Same protected directory/volume. File.Replace keeps the destination's
        # ACLs and replaces its contents without a partially-written config.
        # PowerShell binds $null to an empty string for this .NET parameter.
        # NullString passes an actual null backup path, including on PS 5.1.
        [IO.File]::Replace($temporary,$File,[NullString]::Value)
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Set-AlprNetworkAccess([object]$Installation, [string]$InstallationFile, [ValidateSet('enable','disable')][string]$Operation) {
    $port = [int]$Installation.environment.PORT
    if ($port -lt 1024 -or $port -gt 65535 -or $Installation.environment.DB_HOST -notmatch '^127\.0\.0\.1:\d+$' -or
        $Installation.environment.HOSTNAME -notin @('127.0.0.1','0.0.0.0')) { throw 'Unsupported ALPR network configuration' }
    $controller = Join-Path $Installation.installRoot 'host\Service-Control.ps1'
    $previousJson = $Installation | ConvertTo-Json -Depth 12
    $previousRule = Get-AlprNetworkRule $port
    $previousEnabled = $previousRule -and [string]$previousRule.Enabled -eq 'True'
    $changedRule = $false
    $stopping = $false
    try {
        if ($Operation -eq 'enable') {
            if (-not $previousRule) {
                $changedRule = $true
                New-AlprNetworkRule $port
            } elseif (-not $previousEnabled) {
                $changedRule = $true
                Set-NetFirewallRule -PolicyStore PersistentStore -Name $script:AlprNetworkRuleName -Enabled True -ErrorAction Stop
            }
        } elseif ($previousRule) {
            $changedRule = $true
            Remove-AlprNetworkRule $port
        }
        $stopping = $true
        & $controller -Operation stop
        $Installation.environment.HOSTNAME = '127.0.0.1'
        if ($Operation -eq 'enable') { $Installation.environment.HOSTNAME = '0.0.0.0' }
        Write-AlprInstallationAtomically $InstallationFile $Installation
        & $controller -Operation start
        Wait-AlprNetworkHealth $port
        $identity = & $controller -Operation attest | ConvertFrom-Json
        if (-not $identity.listenerOwned -or $identity.current -ne $Installation.current) { throw 'The restarted application did not own its expected listener' }
        $expectedAddress = $Installation.environment.HOSTNAME
        $listener = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop |
            Where-Object { $_.LocalAddress -eq $expectedAddress })
        if ($listener.Count -eq 0) { throw 'ALPR did not start with the selected network access mode' }
        if ($Operation -eq 'enable') {
            $rule = Get-AlprNetworkRule $port
            if (-not $rule -or [string]$rule.Enabled -ne 'True') { throw 'ALPR network access rule was not enabled' }
        }
    } catch {
        $failure = $_.Exception.Message
        $recovered = $true
        try {
            # Restore firewall scope even if a service stop cannot complete.
            if ($changedRule) {
                Remove-AlprNetworkRule $port
                if ($previousRule) {
                    New-AlprNetworkRule $port
                    if (-not $previousEnabled) { Set-NetFirewallRule -PolicyStore PersistentStore -Name $script:AlprNetworkRuleName -Enabled False -ErrorAction Stop }
                }
            }
            if ($stopping) {
                & $controller -Operation stop
                Write-AlprInstallationAtomically $InstallationFile ($previousJson | ConvertFrom-Json)
                & $controller -Operation start
                Wait-AlprNetworkHealth $port
                $identity = & $controller -Operation attest | ConvertFrom-Json
                if (-not $identity.listenerOwned -or $identity.current -ne $Installation.current) { throw 'Previous application listener was not restored' }
            }
        } catch { $recovered = $false }
        if (-not $recovered) { throw 'The network change failed and needs maintainer recovery. Your installation and data have been preserved.' }
        throw "The network change failed; the previous access mode was restored. $failure"
    }
}

function Wait-AlprNetworkHealth([int]$Port) {
    for ($attempt=0; $attempt -lt 60; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health-check" -TimeoutSec 3
            if ($health.status -eq 'ok') { return }
        } catch {}
        Start-Sleep -Seconds 1
    }
    throw 'ALPR did not become ready after the network change'
}

# Stage URL contents inside the protected install root. MoveFileEx replaces the
# destination entry rather than writing through a hard link or symbolic link.
function Write-AlprShortcut([string]$InstallRoot,[string]$Shortcut,[int]$Port) {
    [void](Assert-SetupDirectory $InstallRoot)
    [void](Assert-SetupDirectory (Split-Path -Parent $Shortcut))
    if (-not ('AlprShortcutMove' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class AlprShortcutMove {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 [return: MarshalAs(UnmanagedType.Bool)]
 public static extern bool MoveFileEx(string source,string destination,uint flags);
}
'@
    }
    $temporary=Join-Path $InstallRoot ('shortcut-'+[Guid]::NewGuid().ToString('N')+'.tmp')
    try {
        $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try {$bytes=(New-Object Text.UTF8Encoding($false)).GetBytes("[InternetShortcut]`r`nURL=http://localhost:$Port`r`n");$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        $acl=New-Object Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true,$false)
        foreach($sid in @('S-1-5-18','S-1-5-32-544',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value) | Select-Object -Unique){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','Allow')))}
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')),'ReadAndExecute','Allow')))
        Set-Acl -LiteralPath $temporary -AclObject $acl
        if(-not [AlprShortcutMove]::MoveFileEx($temporary,$Shortcut,9)){throw 'The ALPR shortcut could not be updated safely'}
    }finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
}
