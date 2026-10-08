#requires -Version 5.1
param(
 [Parameter(Mandatory=$true)][ValidateSet('check','apply','restore')][string]$Operation,
 [ValidateRange(1024,65535)][int]$Port,
 [ValidateRange(1024,65535)][int]$PreviousPort,
 [ValidateSet(0,1)][int]$RulePresent=0,
 [ValidateSet(0,1)][int]$RuleEnabled=0
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Setup-Helpers.ps1')
. (Join-Path $PSScriptRoot 'Network-Helpers.ps1')
$root=Assert-SetupDirectory (Split-Path -Parent $PSScriptRoot)
$file=Join-Path $root 'installation.json'
$installation=Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
if($installation.profile -ne 'windows-native' -or $installation.installRoot -ne $root -or
 $installation.dataRoot -ne "$env:ProgramData\ALPR Community" -or $installation.pgBin -ne (Join-Path $root 'prerequisites\postgresql\bin') -or
 $installation.current -notmatch '^\d+\.\d+\.\d+-[0-9a-f]{12}$' -or $installation.environment.HOSTNAME -notin @('127.0.0.1','0.0.0.0') -or
 $installation.environment.DB_HOST -notmatch '^127\.0\.0\.1:\d{4,5}$' -or $Port -eq [int]($installation.environment.DB_HOST.Split(':')[-1])){throw 'Unsupported application port installation'}
[void](Assert-SetupDirectory $installation.dataRoot)
foreach($name in @('ALPRCommunityApp','ALPRCommunityDatabase')){
 $service=Get-CimInstance Win32_Service -Filter "Name='$name'"
 $expected=Join-Path $root 'services\ALPRCommunityApp.exe'
 if($name -eq 'ALPRCommunityDatabase'){$expected=Join-Path $installation.pgBin 'pg_ctl.exe'}
 if(!$service -or $service.PathName -notmatch ('^(?:"'+[regex]::Escape($expected)+'"|'+[regex]::Escape($expected)+')(?:\s|$)')){throw 'Application service ownership differs'}
 if($name -eq 'ALPRCommunityDatabase' -and $service.PathName -notmatch [regex]::Escape((Join-Path $installation.dataRoot 'management\postgres'))){throw 'Database data directory differs'}
}
$controller=Join-Path $root 'host\Service-Control.ps1'
$manifestFile=Join-Path $root ('releases\'+$installation.current+'\windows-package.json')
$manifest=Get-Content -Raw -LiteralPath $manifestFile | ConvertFrom-Json
foreach($name in @('Service-Control.ps1','Application-Port.ps1','Network-Helpers.ps1')){
 if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.files.('host/'+$name)){throw 'Port helper does not match the installed release'}
}
if([int]$installation.environment.PORT -notin @($PreviousPort,$Port)){throw 'The application port changed during this request'}
$rules=@(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | Where-Object {$_.Name -eq $script:AlprNetworkRuleName})
$rule=$null
if($rules.Count){
 $actual=@($rules | Get-NetFirewallPortFilter -ErrorAction Stop)
 if($actual.Count -ne 1 -or [string]$actual[0].LocalPort -notin @([string]$PreviousPort,[string]$Port)){throw 'The firewall rule belongs to a different port'}
 $rule=Get-AlprNetworkRule ([int]$actual[0].LocalPort)
}
# These are the two fixed shortcuts created by Setup. A foreign shortcut or link
# is refused before stopping ALPR; never follow an arbitrary user-selected path.
$shortcuts=@((Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'ALPR Database Community.url'),
 (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'ALPR Database Community.url'))
foreach($shortcut in $shortcuts){
 [void](Assert-SetupDirectory $shortcut)
 if(Test-Path -LiteralPath $shortcut){
  $content=Get-Content -LiteralPath $shortcut -Raw
  if($content -notmatch ('(?m)^URL=http://localhost:('+ $PreviousPort+'|'+$Port+')(?:/)?\r?$')){throw 'An ALPR shortcut was changed by another application'}
 }
}
if($Operation -eq 'check'){
 $identity=& $controller -Operation attest | ConvertFrom-Json
 if(!$identity.listenerOwned -or $identity.current -ne $installation.current){throw 'The current application listener could not be verified'}
 $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Any,$Port)
 $listener.Server.ExclusiveAddressUse=$true
 try{$listener.Start()}catch{throw 'The selected application port is in use. Choose another port.'}finally{$listener.Stop()}
 @{rulePresent=[bool]$rule;ruleEnabled=[bool]($rule -and [string]$rule.Enabled -eq 'True')} | ConvertTo-Json -Compress
 exit 0
}
$selected=$Port
if($Operation -eq 'restore'){$selected=$PreviousPort}
& $controller -Operation stop
if($rule){Remove-AlprNetworkRule ([int]$actual[0].LocalPort)}
if($RulePresent -eq 1){
 New-AlprNetworkRule $selected
 if($RuleEnabled -eq 0){Set-NetFirewallRule -PolicyStore PersistentStore -Name $script:AlprNetworkRuleName -Enabled False -ErrorAction Stop}
}
$installation.environment.PORT=[string]$selected
Write-AlprInstallationAtomically $file $installation
foreach($shortcut in $shortcuts){
 if(Test-Path -LiteralPath $shortcut){
  if((Get-Content -LiteralPath $shortcut -Raw) -notmatch ('(?m)^URL=http://localhost:'+$selected+'(?:/)?\r?$')){Write-AlprShortcut $root $shortcut $selected}
 }
}
& $controller -Operation start
Wait-AlprNetworkHealth $selected
$identity=& $controller -Operation attest | ConvertFrom-Json
if(!$identity.listenerOwned -or $identity.current -ne $installation.current){throw 'The selected application listener could not be verified'}
$listeners=@(Get-NetTCPConnection -State Listen -LocalPort $selected -ErrorAction Stop | Where-Object {$_.LocalAddress -eq $installation.environment.HOSTNAME})
if(!$listeners.Count){throw 'The application network access mode was not preserved'}
