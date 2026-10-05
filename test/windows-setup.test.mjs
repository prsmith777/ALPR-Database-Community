import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const powershell = process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null;
const root = path.resolve(import.meta.dirname, "..");
function ps(script, env = {}) {
  const environment={...process.env};
  for (const [name,value] of Object.entries(env)) {
    for (const existing of Object.keys(environment)) {
      if (existing.toUpperCase() === name.toUpperCase()) delete environment[existing];
    }
    environment[name]=value;
  }
  // A PowerShell 7 build shell must not replace inbox PowerShell's module path.
  delete environment.PSModulePath;
  return spawnSync(powershell, ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command",script], {
    cwd:root, env:environment,encoding:"utf8",windowsHide:true,
  });
}
test("graphical setup scripts parse with inbox PowerShell 5.1", {skip:!powershell}, () => {
  const result = ps("$failures=0; foreach ($name in @('Setup.ps1','Setup-Helpers.ps1','Uninstall.ps1','Install.ps1')) { $tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD ('scripts/windows/' + $name)),[ref]$tokens,[ref]$errors) | Out-Null; $failures += @($errors).Count; $errors | ForEach-Object { Write-Output $_.Message } }; if($failures){exit 1}");
  assert.equal(result.status,0,result.stdout+result.stderr);
});
test("setup payload verification rejects substitution, tampering and extra files", {skip:!powershell}, async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(),"alpr-setup-payload-"));
  t.after(()=>rm(fixture,{recursive:true,force:true}));
  await writeFile(path.join(fixture,"Install.ps1"),"# fixture");
  const hash = createHash("sha256").update("# fixture").digest("hex");
  const manifest={formatVersion:1,source:"https://github.com/prsmith777/ALPR-Database-Community",platform:"win32",arch:"x64",files:{"Install.ps1":hash}};
  const bytes=JSON.stringify(manifest);
  await writeFile(path.join(fixture,"windows-package.json"),bytes);
  const sha=createHash("sha256").update(bytes).digest("hex");
  const command=". ./scripts/windows/Setup-Helpers.ps1; Test-SetupPayload $env:ALPR_TEST_PACKAGE $env:ALPR_TEST_MANIFEST";
  const env={ALPR_TEST_PACKAGE:fixture,ALPR_TEST_MANIFEST:sha};
  const valid=ps(command,env);
  assert.equal(valid.status,0,valid.stdout+valid.stderr);
  assert.notEqual(ps(command,{...env,ALPR_TEST_MANIFEST:"0".repeat(64)}).status,0);
  await writeFile(path.join(fixture,"Install.ps1"),"# changed");
  assert.notEqual(ps(command,env).status,0);
  await writeFile(path.join(fixture,"Install.ps1"),"# fixture");
  await writeFile(path.join(fixture,"extra.txt"),"unexpected");
  assert.notEqual(ps(command,env).status,0);
});
test("prerequisite archives reject traversal before extracting any file", {skip:!powershell}, async (t) => {
  const fixture=await mkdtemp(path.join(os.tmpdir(),"alpr-setup-archive-"));
  t.after(()=>rm(fixture,{recursive:true,force:true}));
  const result=ps("Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem; . ./scripts/windows/Setup-Helpers.ps1; $file=Join-Path $env:ALPR_TEST_ROOT 'bad.zip'; $archive=[IO.Compression.ZipFile]::Open($file,[IO.Compression.ZipArchiveMode]::Create); $stream=$archive.CreateEntry('../outside.txt').Open(); $stream.Dispose(); $archive.Dispose(); try { Expand-SetupArchive $file (Join-Path $env:ALPR_TEST_ROOT 'output') 'ffmpeg'; exit 3 } catch { if($_.Exception.Message -notmatch 'Unsafe'){throw}; if(Test-Path -LiteralPath (Join-Path $env:ALPR_TEST_ROOT 'output')){exit 4}; Write-Output 'Traversal rejected without extraction' }",{ALPR_TEST_ROOT:fixture});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/Traversal rejected/);
});
test("PostgreSQL extraction includes runtime files and excludes other applications", {skip:!powershell}, async (t) => {
  const fixture=await mkdtemp(path.join(os.tmpdir(),"alpr-setup-pgzip-"));
  t.after(()=>rm(fixture,{recursive:true,force:true}));
  const result=ps("Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem; . ./scripts/windows/Setup-Helpers.ps1; $archive=[IO.Compression.ZipFile]::Open((Join-Path $env:ALPR_TEST_ROOT 'pg.zip'),[IO.Compression.ZipArchiveMode]::Create); foreach($name in @('pgsql/bin/postgres.exe','pgsql/lib/runtime.dll','pgsql/share/sample.conf','pgsql/pgAdmin4/unused.txt')){ $stream=$archive.CreateEntry($name).Open(); $stream.Dispose() }; $archive.Dispose(); Expand-SetupArchive (Join-Path $env:ALPR_TEST_ROOT 'pg.zip') (Join-Path $env:ALPR_TEST_ROOT 'output') 'postgresql'",{ALPR_TEST_ROOT:fixture});
  assert.equal(result.status,0,result.stdout+result.stderr);
  for(const name of ["bin/postgres.exe","lib/runtime.dll","share/sample.conf"]) await readFile(path.join(fixture,"output","pgsql",name));
  await assert.rejects(readFile(path.join(fixture,"output","pgsql","pgAdmin4","unused.txt")),{code:"ENOENT"});
});
test("setup cleanup refuses a directory outside its recorded private workspace", {skip:!powershell}, async (t) => {
  const fixture=await mkdtemp(path.join(os.tmpdir(),"alpr-setup-cleanup-"));
  t.after(()=>rm(fixture,{recursive:true,force:true}));
  await mkdir(path.join(fixture,"keep"));
  await writeFile(path.join(fixture,"keep","important.txt"),"retained");
  const result=ps("& ./scripts/windows/Setup.ps1 -Operation cleanup -WorkRoot (Join-Path $env:ALPR_TEST_ROOT 'keep')",{ALPR_TEST_ROOT:fixture});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Unexpected private Setup workspace/);
  assert.equal(await readFile(path.join(fixture,"keep","important.txt"),"utf8"),"retained");
});
test("setup cleanup removes only its recorded attempt and preserves sibling data", {skip:!powershell}, async (t) => {
  const fixture=await mkdtemp(path.join(os.tmpdir(),"alpr-setup-owned-cleanup-"));
  t.after(()=>rm(fixture,{recursive:true,force:true}));
  const work=path.join(fixture,"ALPR Community Setup","20260101000000-123");
  const retained=path.join(fixture,"ALPR Community","management");
  await mkdir(work,{recursive:true});
  await mkdir(retained,{recursive:true});
  await writeFile(path.join(retained,"important.txt"),"retained");
  await writeFile(path.join(work,"setup-state.json"),JSON.stringify({workRoot:work,formatVersion:1}));
  await writeFile(path.join(work,"administrator-password.txt"),"temporary-fixture-password");
  const result=ps("& ./scripts/windows/Setup.ps1 -Operation cleanup -WorkRoot $env:ALPR_TEST_WORK",{
    ProgramData:fixture,ALPR_TEST_WORK:work,
  });
  assert.equal(result.status,0,result.stdout+result.stderr);
  await assert.rejects(readFile(path.join(work,"setup-state.json")),{code:"ENOENT"});
  assert.equal(await readFile(path.join(retained,"important.txt"),"utf8"),"retained");
});
test("uninstall rejects foreign service ownership before stopping either service", {skip:!powershell}, async (t) => {
  const fixture=await mkdtemp(path.join(os.tmpdir(),"alpr-setup-uninstall-"));
  t.after(()=>rm(fixture,{recursive:true,force:true}));
  const programs=path.join(fixture,"programs"),programData=path.join(fixture,"data");
  const installRoot=path.join(programs,"ALPR Community"),dataRoot=path.join(programData,"ALPR Community");
  const pgBin=path.join(installRoot,"prerequisites","postgresql","bin");
  await mkdir(pgBin,{recursive:true});
  await mkdir(path.join(dataRoot,"management"),{recursive:true});
  await writeFile(path.join(installRoot,"installation.json"),JSON.stringify({installRoot,dataRoot,pgBin,profile:"windows-native"}));
  const result=ps("$env:ProgramFiles=$env:ALPR_TEST_PROGRAMS; $env:ProgramData=$env:ALPR_TEST_DATA; $global:stopped=$false; function Get-CimInstance { param($ClassName,$Filter); if($Filter -match 'App'){ return [pscustomobject]@{PathName=('\"' + $env:ProgramFiles + '\\ALPR Community\\services\\ALPRCommunityApp.exe\"')} }; return [pscustomobject]@{PathName='\"C:\\OtherApplication\\pg_ctl.exe\" runservice'} }; function Stop-Service { $global:stopped=$true; throw 'Unexpected stop' }; try { & ./scripts/windows/Uninstall.ps1; exit 3 } catch { if($_.Exception.Message -notmatch 'different installation'){throw}; if($global:stopped){exit 4}; Write-Output 'Ownership refused before service changes' }",{
    ALPR_TEST_PROGRAMS:programs,ALPR_TEST_DATA:programData,
  });
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/Ownership refused/);
  await readFile(path.join(installRoot,"installation.json"));
});
test("graphical setup pins each prerequisite and its build compiler", async () => {
  const pins=JSON.parse(await readFile(path.join(root,"scripts/windows/setup-prerequisites.json"),"utf8"));
  for(const name of ["postgresql","ffmpeg","visualCpp","compiler"]){
    assert.match(pins[name].url,/^https:\/\//);
    assert.match(pins[name].sha256,/^[0-9a-f]{64}$/);
  }
  assert.equal(pins.postgresql.version,"17.10");
  assert.match(pins.ffmpeg.url,/\/packages\/ffmpeg-8\.1\.2-/);
  assert.match(pins.visualCpp.url,/^https:\/\/download\.visualstudio\.microsoft\.com\//);
});
