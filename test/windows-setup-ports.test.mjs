import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm,copyFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';

const root=path.resolve(import.meta.dirname,'..');
const powershell=process.platform==='win32'?path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'):null;
function ps(script,extra={}) {
 const env={...process.env};delete env.PSModulePath;
 for(const [key,value] of Object.entries(extra)){
  for(const existing of Object.keys(env))if(existing.toUpperCase()===key.toUpperCase())delete env[existing];
  env[key]=value;
 }
 return spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:30000});
}
async function listener(t) {
 const server=net.createServer(socket=>socket.end('original application'));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'0.0.0.0',resolve);});
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return server.address().port;
}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'0.0.0.0',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('Setup port check rejects conflicts without stopping the original application',{skip:!powershell},async t=>{
 const occupied=await listener(t),app=await freePort();let db=await freePort();while(db===app)db=await freePort();
 const check=(a,b)=>ps('& ./scripts/windows/Setup.ps1 -Operation check-ports -AppPort '+a+' -DatabasePort '+b);
 const conflict=check(occupied,db);assert.notEqual(conflict.status,0);assert.match(conflict.stdout,new RegExp('Port '+occupied+' is in use'));
 const databaseConflict=check(app,occupied);assert.notEqual(databaseConflict.status,0);assert.match(databaseConflict.stdout,new RegExp('Port '+occupied+' is in use'));
 const available=check(app,db);assert.equal(available.status,0,available.stdout+available.stderr);
 assert.notEqual(check(app,app).status,0);assert.notEqual(check(1023,db).status,0);assert.notEqual(check(app,65536).status,0);
 const reply=await new Promise((resolve,reject)=>{let text='';const socket=net.connect(occupied,'127.0.0.1');socket.on('data',data=>text+=data);socket.on('end',()=>resolve(text));socket.on('error',reject);});
 assert.equal(reply,'original application');
});

test('Setup stages and installs the selected ports for fresh and migrated databases',{skip:!powershell},async t=>{
 const occupied=await listener(t);
 for(const migration of [false,true]){
  const fixture=await mkdtemp(path.join(os.tmpdir(),'alpr-setup-ports-'));t.after(()=>rm(fixture,{recursive:true,force:true}));
  const scripts=path.join(fixture,'scripts'),payload=path.join(fixture,'package'),data=path.join(fixture,'data'),programs=path.join(fixture,'programs');
  const work=path.join(data,'ALPR Community Setup','20260101000000-123'),capture=path.join(fixture,'captured.json'),source=path.join(fixture,'old-backup');
  const app=await freePort();let db=await freePort();while(db===app)db=await freePort();
  await mkdir(scripts);await mkdir(path.join(payload,'runtime'),{recursive:true});await mkdir(path.join(payload,'host'));await mkdir(data);await mkdir(programs);await mkdir(source);
  await writeFile(path.join(source,'source-marker'),'original backup');
  await copyFile(path.join(root,'scripts/windows/Setup.ps1'),path.join(scripts,'Setup.ps1'));
  const helper=await readFile(path.join(root,'scripts/windows/Setup-Helpers.ps1'),'utf8');
  // Only platform/dependency/service operations are substituted. The real wrapper,
  // port checks, workspace validation, staging record and subprocess arguments run.
  await writeFile(path.join(scripts,'Setup-Helpers.ps1'),helper+`
function Assert-SetupHost {}
function Assert-SetupServicesAbsent {}
function Test-SetupPayload {}
function Get-SetupDownload {}
function Expand-SetupArchive([string]$Archive,[string]$Destination,[string]$Kind) {
 if($Kind -eq 'postgresql'){$bin=Join-Path $Destination 'pgsql\\bin';$files=@('postgres.exe','pg_ctl.exe')}
 else{$bin=Join-Path $Destination 'ffmpeg-fixture\\bin';$files=@('ffmpeg.exe','ffprobe.exe')}
 [void][IO.Directory]::CreateDirectory($bin);foreach($file in $files){[IO.File]::WriteAllText((Join-Path $bin $file),'fixture')}
}
function Get-ItemProperty { return [pscustomobject]@{Installed=1;Version='v99.0.0'} }
function Test-InstalledSetupPayload { $captured=Get-Content -LiteralPath $env:ALPR_TEST_CAPTURE -Raw | ConvertFrom-Json; Write-Output "ALPR_SETUP_PORT:$($captured.AppPort)" }
`);
  await writeFile(path.join(scripts,'setup-prerequisites.json'),JSON.stringify({postgresql:{},ffmpeg:{},visualCpp:{version:'1.0.0'}}));
  await copyFile(process.execPath,path.join(payload,'runtime/node.exe'));
  await writeFile(path.join(payload,'host/community-migration-bundle.mjs'),`import {mkdir,writeFile} from 'node:fs/promises';const args=process.argv;const output=args[args.indexOf('--output')+1];await mkdir(output);await writeFile(output+'/verified-fixture','staged');`);
  await writeFile(path.join(payload,'Install.ps1'),`param([switch]$CheckOnly,[switch]$AllowPreview,[switch]$CopyPrerequisites,[string]$PgBin,[string]$FfmpegBin,[int]$AppPort,[int]$DatabasePort,[string]$AdministratorPasswordFile,[switch]$ListenOnNetwork,[string]$MigrationBackup,[switch]$ReuseRetainedData)
@{AppPort=$AppPort;DatabasePort=$DatabasePort;CheckOnly=[bool]$CheckOnly;ListenOnNetwork=[bool]$ListenOnNetwork;MigrationBackup=$MigrationBackup} | ConvertTo-Json | Set-Content -LiteralPath $env:ALPR_TEST_CAPTURE
exit 0
`);
  const env={ALPR_TEST_SCRIPT:path.join(scripts,'Setup.ps1'),ALPR_TEST_WORK:work,ALPR_TEST_PACKAGE:payload,ALPR_TEST_DATA:data,ALPR_TEST_PROGRAMS:programs,ALPR_TEST_CAPTURE:capture,ALPR_TEST_SOURCE:source};
  const prefix='$env:ProgramData=$env:ALPR_TEST_DATA;$env:ProgramFiles=$env:ALPR_TEST_PROGRAMS;';
  const prepared=ps(prefix+`& $env:ALPR_TEST_SCRIPT -Operation prepare -PackageRoot $env:ALPR_TEST_PACKAGE -ManifestSha256 '${'a'.repeat(64)}' -WorkRoot $env:ALPR_TEST_WORK -AppPort ${app} -DatabasePort ${db} -ListenOnNetwork`+(migration?' -MigrationBackup $env:ALPR_TEST_SOURCE':''),env);
  assert.equal(prepared.status,0,prepared.stdout+prepared.stderr);
  const checked=JSON.parse(await readFile(capture,'utf8'));assert.equal(checked.CheckOnly,true);assert.equal(checked.AppPort,app);assert.equal(checked.DatabasePort,db);
  const state=JSON.parse(await readFile(path.join(work,'setup-state.json'),'utf8'));assert.equal(state.appPort,app);assert.equal(state.databasePort,db);
  // A later invocation supplies the occupied old application's port. The sealed
  // prepare record must win, including staged migration and network preference.
  const installed=ps(prefix+`& $env:ALPR_TEST_SCRIPT -Operation install -WorkRoot $env:ALPR_TEST_WORK -AppPort ${occupied} -DatabasePort ${occupied}`,env);
  assert.equal(installed.status,0,installed.stdout+installed.stderr);assert.match(installed.stdout,new RegExp('ALPR_SETUP_PORT:'+app));assert.match(installed.stdout,/ALPR_SETUP_COMPLETE:verified/);
  const actual=JSON.parse(await readFile(capture,'utf8'));assert.equal(actual.CheckOnly,false);assert.equal(actual.AppPort,app);assert.equal(actual.DatabasePort,db);assert.equal(actual.ListenOnNetwork,true);
  assert.equal(actual.MigrationBackup,migration?path.join(work,'migration'):'');
  assert.equal(await readFile(path.join(source,'source-marker'),'utf8'),'original backup');
  // Corrupted state must stop before invoking the child again.
  await writeFile(capture,'not invoked');state.appPort=0;await writeFile(path.join(work,'setup-state.json'),JSON.stringify(state));
  const refused=ps(prefix+'& $env:ALPR_TEST_SCRIPT -Operation install -WorkRoot $env:ALPR_TEST_WORK',env);assert.notEqual(refused.status,0);assert.equal(await readFile(capture,'utf8'),'not invoked');
 }
});

test('Retained-data recovery checks its saved custom ports rather than fresh defaults',{skip:!powershell},async t=>{
 const occupied=await listener(t),app=await freePort();let db=await freePort();while(db===app)db=await freePort();
 const result=ps(`. ./scripts/windows/Setup-Helpers.ps1
 function Assert-SetupServicesAbsent {}
 function Get-RetainedSetup { return @{environment=@{PORT='${app}';DB_HOST='127.0.0.1:${db}'}} }
 $ports=Assert-FreshSetup -ReuseRetainedData -AppPort ${occupied} -DatabasePort ${occupied}
 if($ports.appPort -ne ${app} -or $ports.databasePort -ne ${db}){throw 'Saved ports lost'}
 Write-Output 'Saved custom ports checked'
`);assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/Saved custom ports checked/);
});
