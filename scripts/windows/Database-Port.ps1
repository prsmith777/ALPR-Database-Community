#requires -Version 5.1
param(
 [Parameter(Mandatory=$true)][ValidateSet('check','apply','restore','verify')][string]$Operation,
 [ValidateRange(1024,65535)][int]$Port,
 [ValidateRange(1024,65535)][int]$PreviousPort,
 [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$RequestId,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$BackupSha256
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
 $installation.environment.DB_HOST -notmatch '^127\.0\.0\.1:\d{4,5}$' -or $installation.environment.DB_USER -ne 'postgres' -or $installation.environment.DB_NAME -ne 'postgres' -or
 $Port -eq [int]$installation.environment.PORT -or $Port -eq $PreviousPort){throw 'Unsupported database port installation'}
$data=Assert-SetupDirectory (Join-Path $installation.dataRoot 'management\postgres')
$auto=Assert-SetupDirectory (Join-Path $data 'postgresql.auto.conf')
$backup=Assert-SetupDirectory (Join-Path $installation.dataRoot ('management\updates\database-port-'+$RequestId+'.conf'))
$controller=Join-Path $root 'host\Service-Control.ps1'
$manifest=Get-Content -Raw -LiteralPath (Join-Path $root ('releases\'+$installation.current+'\windows-package.json')) | ConvertFrom-Json
foreach($name in @('Service-Control.ps1','Database-Port.ps1','Network-Helpers.ps1','Setup-Helpers.ps1')){
 if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.files.('host/'+$name)){throw 'Port helper does not match the installed release'}
}
foreach($name in @('ALPRCommunityApp','ALPRCommunityDatabase')){
 $record=Get-CimInstance Win32_Service -Filter "Name='$name'"
 $expected=Join-Path $root 'services\ALPRCommunityApp.exe'
 if($name -eq 'ALPRCommunityDatabase'){$expected=Join-Path $installation.pgBin 'pg_ctl.exe'}
 if(!$record -or $record.PathName -notmatch ('^(?:"'+[regex]::Escape($expected)+'"|'+[regex]::Escape($expected)+')(?:\s|$)')){throw 'Service ownership differs'}
 if($name -eq 'ALPRCommunityDatabase' -and ($record.PathName -notmatch [regex]::Escape($data) -or $record.StartName -ne 'NT AUTHORITY\NetworkService')){throw 'Database service ownership differs'}
}
if([int]($installation.environment.DB_HOST.Split(':')[-1]) -notin @($PreviousPort,$Port)){throw 'The database port changed during this request'}
function Write-ConfigAtomically([byte[]]$Bytes){
 $temporary=$auto+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
 try{[IO.File]::WriteAllBytes($temporary,$Bytes);[IO.File]::Replace($temporary,$auto,[NullString]::Value)}
 finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
}
function Assert-Database([int]$Selected){
 $savedPassword=$env:PGPASSWORD
 $savedTimeout=$env:PGCONNECT_TIMEOUT
 try{
  $env:PGPASSWORD=$installation.environment.DB_PASSWORD
  $env:PGCONNECT_TIMEOUT='5'
  $query="SELECT current_setting('port'), current_setting('data_directory'), current_setting('config_file'), current_setting('listen_addresses')"
  $result=& (Join-Path $installation.pgBin 'psql.exe') --no-psqlrc --set ON_ERROR_STOP=1 -h 127.0.0.1 -p $Selected -U postgres -d postgres -At -c $query 2>$null
  if($LASTEXITCODE -ne 0){throw 'The database connection could not be verified'}
  $values=([string]$result).Split('|')
  if($values.Count -ne 4 -or $values[0] -ne [string]$Selected -or [IO.Path]::GetFullPath($values[1]) -ne $data -or
   [IO.Path]::GetFullPath($values[2]) -ne (Join-Path $data 'postgresql.conf') -or $values[3] -ne '127.0.0.1'){throw 'Database configuration identity differs'}
  $databasePid=[int](Get-Content -LiteralPath (Join-Path $data 'postmaster.pid') -TotalCount 1)
  $process=Get-CimInstance Win32_Process -Filter "ProcessId=$databasePid"
  if(!$process -or $process.ExecutablePath -ne (Join-Path $installation.pgBin 'postgres.exe')){throw 'Database process identity differs'}
  $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $Selected -ErrorAction Stop)
  if(!$listeners.Count -or @($listeners | Where-Object {$_.LocalAddress -ne '127.0.0.1' -or $_.OwningProcess -ne $databasePid}).Count){throw 'Database listener identity differs'}
 }finally{$env:PGPASSWORD=$savedPassword;$env:PGCONNECT_TIMEOUT=$savedTimeout}
}
function Start-Database([int]$Selected){
 $database=Get-Service -Name 'ALPRCommunityDatabase'
 Start-Service -InputObject $database
 $database.WaitForStatus('Running',[TimeSpan]::FromSeconds(60))
 $ready=$false
 for($attempt=0;$attempt -lt 30;$attempt++){
  try{Assert-Database $Selected;$ready=$true;break}catch{Start-Sleep -Seconds 1}
 }
 if(!$ready){throw 'The selected database connection could not be verified'}
}
if($Operation -eq 'verify'){
 Assert-Database ([int]($installation.environment.DB_HOST.Split(':')[-1]))
 exit 0
}
if($Operation -eq 'check'){
 Assert-Database $PreviousPort
 $identity=& $controller -Operation attest | ConvertFrom-Json
 if(!$identity.listenerOwned -or $identity.current -ne $installation.current){throw 'The application listener could not be verified'}
 $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Any,$Port)
 $listener.Server.ExclusiveAddressUse=$true
 try{$listener.Start()}catch{throw 'The selected database port is in use. Choose another port.'}finally{$listener.Stop()}
 if(!(Test-Path -LiteralPath $auto -PathType Leaf) -or (Get-Item -LiteralPath $auto).Length -gt 1048576){throw 'Invalid PostgreSQL configuration file'}
 # Create a private recovery copy before journaling or stopping either service.
 $bytes=[IO.File]::ReadAllBytes($auto)
 $stream=[IO.File]::Open($backup,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 @{backupSha256=(Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json -Compress
 exit 0
}
if(!$BackupSha256 -or !(Test-Path -LiteralPath $backup -PathType Leaf) -or
 (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash.ToLowerInvariant() -ne $BackupSha256){throw 'The database configuration recovery copy could not be verified'}
if($Operation -eq 'apply'){
 Assert-Database $PreviousPort
 if((Get-FileHash -LiteralPath $auto -Algorithm SHA256).Hash.ToLowerInvariant() -ne $BackupSha256){throw 'PostgreSQL configuration changed during this request'}
}
& $controller -Operation stop
$database=Get-Service -Name 'ALPRCommunityDatabase'
if($database.Status -ne 'Stopped'){Stop-Service -InputObject $database;$database.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(90))}
$bytes=[IO.File]::ReadAllBytes($backup)
$selected=$PreviousPort
if($Operation -eq 'apply'){
 $selected=$Port
 # PostgreSQL reads auto.conf after postgresql.conf. Preserve every existing byte
 # and append the local port override; restoration uses the exact original bytes.
 $bytes=$bytes+[Text.Encoding]::UTF8.GetBytes("`r`n# ALPR managed local database port`r`nport = '$Port'`r`n")
}
Write-ConfigAtomically $bytes
$installation.environment.DB_HOST='127.0.0.1:'+$selected
Write-AlprInstallationAtomically $file $installation
Start-Database $selected
& $controller -Operation start
Wait-AlprNetworkHealth ([int]$installation.environment.PORT)
$identity=& $controller -Operation attest | ConvertFrom-Json
if(!$identity.listenerOwned -or $identity.current -ne $installation.current){throw 'The restarted application listener could not be verified'}
