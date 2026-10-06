import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,readFile,rm,writeFile,mkdir} from "node:fs/promises";
import {existsSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {verifyWindowsSetupStartup} from "../scripts/test-windows-setup-startup.mjs";

const windows=process.platform==="win32";
const root=path.resolve(import.meta.dirname,"..");
const compiler=process.env.ALPR_ISCC_PATH||path.join(root,".native-dependencies/inno-6.7.3/ISCC.exe");
function ps(code,extra={}){
  const env={...process.env,...extra};delete env.PSModulePath;
  return spawnSync(path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command",code],{cwd:root,env,encoding:"utf8",windowsHide:true});
}
const mocks=`
. ./scripts/windows/Network-Helpers.ps1
$global:rule=$null
$global:mutations=0
function Get-NetFirewallRule { [CmdletBinding()]param($PolicyStore); if($global:rule){$global:rule} }
function New-NetFirewallRule { [CmdletBinding()]param($PolicyStore,$Name,$DisplayName,$Group,$Description,$Direction,$Action,$Protocol,$LocalPort,$RemoteAddress,$Profile,$EdgeTraversalPolicy,$Enabled)
  $global:mutations++;$global:rule=[pscustomobject]@{Name=$Name;Group=$Group;Description=$Description;Direction=$Direction;Action=$Action;Profile=$Profile;EdgeTraversalPolicy=$EdgeTraversalPolicy;Enabled=$Enabled;Port=[string]$LocalPort;RemoteAddress=$RemoteAddress;Program='Any';Protocol=$Protocol};if($env:ALPR_TEST_FAIL_RULE -eq 'yes'){throw 'Fixture rule creation failure'};$global:rule }
function Remove-NetFirewallRule { [CmdletBinding()]param($PolicyStore,$Name); $global:mutations++;$global:rule=$null }
function Set-NetFirewallRule { [CmdletBinding()]param($PolicyStore,$Name,$Enabled); $global:mutations++;$global:rule.Enabled=$Enabled }
function Get-NetFirewallPortFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline=$true)]$InputObject);process{[pscustomobject]@{Protocol=$InputObject.Protocol;LocalPort=$InputObject.Port;RemotePort='Any'}} }
function Get-NetFirewallAddressFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline=$true)]$InputObject);process{[pscustomobject]@{RemoteAddress=$InputObject.RemoteAddress;LocalAddress='Any'}} }
function Get-NetFirewallApplicationFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline=$true)]$InputObject);process{[pscustomobject]@{Program=$InputObject.Program}} }
function Get-NetTCPConnection { [CmdletBinding()]param($State,$LocalPort);$installed=Get-Content -Raw -LiteralPath $env:ALPR_TEST_INSTALLATION|ConvertFrom-Json;[pscustomobject]@{LocalAddress=$installed.environment.HOSTNAME} }
function Wait-AlprNetworkHealth { param($Port) }
$installation=Get-Content -Raw -LiteralPath $env:ALPR_TEST_INSTALLATION|ConvertFrom-Json
`;
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),"alpr-network-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await mkdir(path.join(directory,"host"));
  const file=path.join(directory,"installation.json");
  const installation={formatVersion:1,installRoot:directory,current:"0.1.46-5783f41b5044",
    environment:{PORT:"3000",HOSTNAME:"127.0.0.1",DB_HOST:"127.0.0.1:5433",DB_PASSWORD:"unchanged fixture password"}};
  await writeFile(file,JSON.stringify(installation));
  await writeFile(path.join(directory,"host/Service-Control.ps1"),`param($Operation)
if($Operation -eq 'attest'){$i=Get-Content -Raw -LiteralPath $env:ALPR_TEST_INSTALLATION|ConvertFrom-Json;@{current=$i.current;listenerOwned=$true}|ConvertTo-Json;return}
Add-Content -LiteralPath (Join-Path $env:ALPR_TEST_ROOT 'operations.txt') -Value $Operation
if($Operation -eq 'start' -and $env:ALPR_TEST_FAIL_START -eq 'yes'){$marker=Join-Path $env:ALPR_TEST_ROOT 'failed-once';if(-not(Test-Path -LiteralPath $marker)){Set-Content -LiteralPath $marker 'fixture';throw 'Fixture startup failure'}}
`);
  return {directory,file,installation,env:{ALPR_TEST_ROOT:directory,ALPR_TEST_INSTALLATION:file}};
}

test("network scripts parse with inbox PowerShell 5.1",{skip:!windows},()=>{
  const result=ps("$failures=0;foreach($name in @('Network.ps1','Network-Helpers.ps1','Uninstall.ps1','Setup.ps1','Install.ps1')){$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD ('scripts/windows/'+$name)),[ref]$t,[ref]$e)|Out-Null;$failures+=@($e).Count;$e|ForEach-Object{$_.Message}};if($failures){exit 1}");
  assert.equal(result.status,0,result.stdout+result.stderr);
});
test("network enable and disable preserve credentials and restrict the firewall scope",{skip:!windows},async(t)=>{
  const f=await fixture(t);
  const result=ps(mocks+`Set-AlprNetworkAccess $installation $env:ALPR_TEST_INSTALLATION enable
if($global:rule.Port -ne '3000' -or $global:rule.RemoteAddress -ne 'LocalSubnet' -or $global:rule.Protocol -ne 'TCP' -or $global:rule.EdgeTraversalPolicy -ne 'Block'){throw 'Unexpected firewall scope'}
$i=Get-Content -Raw -LiteralPath $env:ALPR_TEST_INSTALLATION|ConvertFrom-Json
if($i.environment.HOSTNAME -ne '0.0.0.0'){throw 'LAN listener not selected'}
Set-AlprNetworkAccess $i $env:ALPR_TEST_INSTALLATION disable
if($global:rule){throw 'Firewall rule was not removed'}
`,f.env);
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.deepEqual(JSON.parse(await readFile(f.file,"utf8")),f.installation);
});
test("foreign or broadened rules refuse before changing the application",{skip:!windows},async(t)=>{
  const f=await fixture(t);
  const result=ps(mocks+`New-AlprNetworkRule 3000
$global:rule.RemoteAddress='Any';$before=$global:mutations
try{Set-AlprNetworkAccess $installation $env:ALPR_TEST_INSTALLATION enable;exit 3}catch{if($_.Exception.Message -notmatch 'unexpected owner or scope'){throw}}
if($global:mutations -ne $before -or (Test-Path -LiteralPath (Join-Path $env:ALPR_TEST_ROOT 'operations.txt'))){throw 'Foreign rule changed the application'}
`,f.env);
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.deepEqual(JSON.parse(await readFile(f.file,"utf8")),f.installation);
});
test("failed network startup restores the previous listener and removes the new rule",{skip:!windows},async(t)=>{
  const f=await fixture(t);
  const result=ps(mocks+`try{Set-AlprNetworkAccess $installation $env:ALPR_TEST_INSTALLATION enable;exit 3}catch{if($_.Exception.Message -notmatch 'previous access mode was restored'){throw}}
if($global:rule){throw 'New firewall rule was left behind'}
Write-Output 'Previous access mode verified'
`,{...f.env,ALPR_TEST_FAIL_START:"yes"});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.deepEqual(JSON.parse(await readFile(f.file,"utf8")),f.installation);
  assert.deepEqual((await readFile(path.join(f.directory,"operations.txt"),"utf8")).trim().split(/\r?\n/),["stop","start","stop","start"]);
});
test("installer selection reaches installation and uninstall removes only the owned rule",async()=>{
  const setup=await readFile(path.join(root,"scripts/windows/Setup.ps1"),"utf8");
  assert.match(setup,/listenOnNetwork=\[bool\]\$ListenOnNetwork/);
  assert.match(setup,/if \(\$record\.listenOnNetwork -eq \$true\)/);
  const uninstall=await readFile(path.join(root,"scripts/windows/Uninstall.ps1"),"utf8");
  assert.match(uninstall,/Get-AlprNetworkRule/);
  assert.match(uninstall,/Remove-AlprNetworkRule/);
});
test("partial firewall creation is rolled back without stopping the application",{skip:!windows},async(t)=>{
  const f=await fixture(t);
  const result=ps(mocks+`try{Set-AlprNetworkAccess $installation $env:ALPR_TEST_INSTALLATION enable;exit 3}catch{if($_.Exception.Message -notmatch 'previous access mode was restored'){throw}}
if($global:rule -or (Test-Path -LiteralPath (Join-Path $env:ALPR_TEST_ROOT 'operations.txt'))){throw 'Partial firewall creation was not rolled back'}
Write-Output 'Partial rule recovery verified'
`,{...f.env,ALPR_TEST_FAIL_RULE:"yes"});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.deepEqual(JSON.parse(await readFile(f.file,"utf8")),f.installation);
});
test("a failed disable restores LAN mode and its previous rule",{skip:!windows},async(t)=>{
  const f=await fixture(t);
  f.installation.environment.HOSTNAME="0.0.0.0";
  await writeFile(f.file,JSON.stringify(f.installation));
  const result=ps(mocks+`New-AlprNetworkRule 3000
try{Set-AlprNetworkAccess $installation $env:ALPR_TEST_INSTALLATION disable;exit 3}catch{if($_.Exception.Message -notmatch 'previous access mode was restored'){throw}}
$restored=Get-AlprNetworkRule 3000
if(-not $restored -or $restored.Enabled -ne 'True'){throw 'Previous LAN rule was not restored'}
Write-Output 'LAN recovery verified'
`,{...f.env,ALPR_TEST_FAIL_START:"yes"});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.deepEqual(JSON.parse(await readFile(f.file,"utf8")),f.installation);
});
test("compiled network wizard creates its actual access choices without installation",{skip:!windows||!existsSync(compiler)},async()=>{
  const result=await verifyWindowsSetupStartup({compiler,sourceFile:path.join(root,"scripts/windows/CommunityNetwork.iss")});
  assert.equal(result.verified,true);
});
