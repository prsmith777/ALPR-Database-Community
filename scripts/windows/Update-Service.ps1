#requires -Version 5.1
function Install-WindowsUpdateService([string]$InstallRoot,[string]$DataRoot) {
 $root=Assert-SetupDirectory $InstallRoot;$data=Assert-SetupDirectory $DataRoot
 $installation=Get-Content -LiteralPath (Join-Path $root 'installation.json') -Raw | ConvertFrom-Json
 if($installation.installRoot -ne $root -or $installation.dataRoot -ne $data -or $installation.profile -ne 'windows-native'){throw 'Unexpected updater installation identity'}
 $app=Get-CimInstance Win32_Service -Filter "Name='ALPRCommunityApp'"
 if(!$app -or $app.PathName -ne ('"'+$root+'\services\ALPRCommunityApp.exe"') -or $app.State -ne 'Stopped'){throw 'Stop this installation before registering the updater'}
 $serviceFile=Join-Path $root 'services\ALPRCommunityUpdater.exe'
 $existing=Get-CimInstance Win32_Service -Filter "Name='ALPRCommunityUpdater'"
 if($existing){
  if($existing.PathName -ne ('"'+$serviceFile+'"') -or $existing.StartName -ne 'LocalSystem'){throw 'Updater service belongs to another installation'}
  return
 }
 $private=Join-Path $data 'management\updates'
 Protect-SetupDirectory $private
 $logs=Join-Path $private 'logs';Protect-SetupDirectory $logs
 $control=Assert-SetupDirectory (Join-Path $data 'update-control')
 if(!(Test-Path -LiteralPath $control)){[void][IO.Directory]::CreateDirectory($control)}
 if(@(Get-ChildItem -LiteralPath $control -Force | Where-Object { $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)}).Count){throw 'Unexpected directory or link in the updater inbox'}
 $appSid=(New-Object Security.Principal.NTAccount('NT SERVICE\ALPRCommunityApp')).Translate([Security.Principal.SecurityIdentifier])
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetAccessRuleProtection($true,$false)
 $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
 foreach($sid in @('S-1-5-18','S-1-5-32-544')){
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
 }
 # The app can create requests, but cannot replace the directory, create a
 # junction below it, or modify updater-owned heartbeat and result files.
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($appSid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($appSid,'CreateFiles','None','None','Allow')))
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-3-0')),'Modify','ObjectInherit','InheritOnly','Allow')))
 Set-Acl -LiteralPath $control -AclObject $acl
 foreach($file in @(Get-ChildItem -LiteralPath $control -File -Force)){
  # Discard only old advisory public state. Requests must be submitted again
  # after the service is online; private update and backup records stay intact.
  if($file.Name -notin @('request.json','request-active.json','state.json','heartbeat.json')){throw 'Unexpected updater inbox entry'}
  Remove-Item -LiteralPath $file.FullName -Force
 }
 Copy-Item -LiteralPath (Join-Path $root 'runtime\winsw.exe') -Destination $serviceFile
 $node=[Security.SecurityElement]::Escape((Join-Path $root 'runtime\node.exe'))
 $hostFile=[Security.SecurityElement]::Escape((Join-Path $root 'host\windows-update-service.mjs'))
 $metadata=[Security.SecurityElement]::Escape((Join-Path $root 'installation.json'))
 $working=[Security.SecurityElement]::Escape($root);$logPath=[Security.SecurityElement]::Escape($logs)
 $xml="<service><id>ALPRCommunityUpdater</id><name>ALPR Community Updater</name><description>Installs verified Community Windows releases requested by an ALPR administrator</description><executable>$node</executable><arguments>&quot;$hostFile&quot; &quot;$metadata&quot;</arguments><workingdirectory>$working</workingdirectory><startmode>Automatic</startmode><onfailure action='restart' delay='10 sec'/><stoptimeout>300 sec</stoptimeout><logpath>$logPath</logpath><log mode='roll-by-size'><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log></service>"
 [IO.File]::WriteAllText((Join-Path $root 'services\ALPRCommunityUpdater.xml'),$xml,(New-Object Text.UTF8Encoding($false)))
 & $serviceFile install
 if($LASTEXITCODE -ne 0){throw 'Could not register the Windows update service'}
 & "$env:SystemRoot\System32\sc.exe" config ALPRCommunityUpdater start= auto
 if($LASTEXITCODE -ne 0){throw 'Could not enable automatic updater startup'}
 Start-Service -Name ALPRCommunityUpdater
 $ready=$false
 for($attempt=0;$attempt -lt 30;$attempt++){
  $heartbeat=Join-Path $control 'heartbeat.json'
  if(Test-Path -LiteralPath $heartbeat){
   $value=Get-Content -LiteralPath $heartbeat -Raw | ConvertFrom-Json
   if(([DateTime]::UtcNow - [DateTime]::Parse($value.observedAt).ToUniversalTime()).TotalSeconds -lt 20){$ready=$true;break}
  }
  Start-Sleep -Seconds 1
 }
 if(!$ready){throw 'Windows update service did not become ready; preserve the installation and check its protected log'}
 Write-Output 'ALPR_SETUP_PROGRESS:Updates are enabled in Settings > Software Updates.'
}
