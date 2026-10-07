import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, symlink, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { runtimeDataPath } from "../lib/runtime-paths.mjs";
import { assertWindowsHost, COMMUNITY_SOURCE, hashFile, listPackageFiles, safePackagePath, verifyWindowsPackage } from "../scripts/windows-native-package.mjs";
import { assertPreservedFiles, loadWindowsDeployment, renameWindowsReleaseDirectory } from "../scripts/windows-deployment.mjs";
import { runWindowsUpdater } from "../scripts/windows-maintenance.mjs";
import { openvinoRuntimeInstallerInternals } from "../scripts/install-openvino-runtime.mjs";

async function makePackage(root, version, commit) {
  const contents = {
    "app/server.js": "// fixture", "app/package.json": JSON.stringify({ version }),
    "runtime/node.exe": "fixture", "runtime/winsw.exe": "fixture",
    "host/windows-service.mjs": "// fixture", "host/windows-maintenance.mjs": "// fixture",
    "schema.sql": "-- fixture", "migrations.sql": "-- fixture", "Install.ps1": "# fixture",
  };
  for (const [name, content] of Object.entries(contents)) {
    const file = safePackagePath(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const files = {};
  for (const name of await listPackageFiles(root)) files[name] = await hashFile(safePackagePath(root, name));
  const manifest = { formatVersion: 1, source: COMMUNITY_SOURCE, version, commit, channel: "stable", platform: "win32", arch: "x64", files };
  await writeFile(path.join(root, "windows-package.json"), JSON.stringify(manifest));
  return manifest;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "alpr-native-windows-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root,"data"), releases = path.join(root,"releases"), target = path.join(root,"target");
  for (const name of ["auth","config","storage","management/backups"]) await mkdir(path.join(data,...name.split("/")), { recursive: true });
  await writeFile(path.join(data,"auth","auth.json"), '{"fixture":true}');
  await writeFile(path.join(data,"config","settings.yaml"), "fixture: true");
  await writeFile(path.join(data,"storage","image.jpg"), "fixture image");
  const current = await makePackage(path.join(releases,"0.1.46-" + "a".repeat(12)), "0.1.46", "a".repeat(40));
  await makePackage(target, "0.1.47", "b".repeat(40));
  const installationFile = path.join(root,"installation.json");
  const installation = { installRoot: root, dataRoot: data, current: "0.1.46-" + "a".repeat(12), pgBin: path.join(root,"bin") };
  await writeFile(installationFile,JSON.stringify(installation));
  const operations = [];
  const deployment = {
    data, root, releaseRoot: releases, current, installationFile, installation,
    backupRoot: path.join(data,"management","backups"), operations,
    service(command) { operations.push(command); },
    sql() { return "1024"; },
    async counts() { return { plate_reads:"1", plates:"1" }; },
    async health() { return { status:"ok" }; },
    async attest() {
      const installed = JSON.parse(await readFile(installationFile,"utf8"));
      const manifest = JSON.parse(await readFile(path.join(releases,installed.current,"windows-package.json"),"utf8"));
      return {current:installed.current,commit:manifest.commit,status:"Running",listenerOwned:true};
    },
    async stage(packageRoot) {
      const manifest = await verifyWindowsPackage(packageRoot);
      const name = manifest.version + "-" + manifest.commit.slice(0,12);
      const destination = path.join(releases,name);
      await cp(packageRoot,destination,{recursive:true});
      return { manifest, name, path:destination };
    },
    migrate() { operations.push("migrate"); },
    async switchRelease(name) { await writeFile(installationFile,JSON.stringify({...installation,current:name})); },
    async pg(executable, args) {
      if (executable === "pg_dump") await writeFile(args[args.indexOf("--file")+1],"fixture dump");
      if (executable === "psql") operations.push("restore");
    },
    async run(executable,args) {
      if (args[0] === "--no-owner") await writeFile(args[args.indexOf("--file")+1],"-- fixture restore");
    },
  };
  // The real PostgreSQL runner is synchronous. Fixtures write dumps
  // synchronously to preserve that contract.
  const { writeFileSync } = await import("node:fs");
  deployment.pg = (executable,args) => {
    if (executable === "pg_dump") writeFileSync(args[args.indexOf("--file")+1],"fixture dump");
    if (executable === "psql") operations.push("restore");
  };
  deployment.run = (_command,args) => {
    if (args[0] === "--no-owner") writeFileSync(args[args.indexOf("--file")+1],"-- fixture restore");
  };
  const args = ["update","--package",target,"--manifest-sha256",await hashFile(path.join(target,"windows-package.json"))];
  return { deployment, args, root, target, options:{deployment,confirmed:true} };
}
test("Windows baseline explicitly accepts 10 22H2/11 x64 and rejects older/ARM hosts", () => {
  assert.doesNotThrow(() => assertWindowsHost({platform:"win32",arch:"x64",build:19045}));
  assert.doesNotThrow(() => assertWindowsHost({platform:"win32",arch:"x64",build:26100}));
  for (const host of [{platform:"win32",arch:"x64",build:19044},{platform:"win32",arch:"arm64",build:26100},{platform:"linux",arch:"x64",build:26100}]) assert.throws(() => assertWindowsHost(host));
});
test("native data root stays independent of release working directory", () => {
  const previous = process.env.ALPR_DATA_DIR;
  try {
    process.env.ALPR_DATA_DIR = path.resolve("fixture-native-data");
    assert.equal(runtimeDataPath("auth","auth.json"),path.join(process.env.ALPR_DATA_DIR,"auth","auth.json"));
    process.env.ALPR_DATA_DIR = "relative-data";
    assert.throws(() => runtimeDataPath("auth"), /absolute/);
  } finally {
    if (previous === undefined) delete process.env.ALPR_DATA_DIR; else process.env.ALPR_DATA_DIR = previous;
  }
});

test("Windows row counts use one snapshot and retry only bounded connection observations",async t=>{
 const f=await fixture(t),installation={...f.deployment.installation,formatVersion:1,profile:"windows-native",environment:{DB_HOST:"127.0.0.1:5432",DB_USER:"postgres",DB_NAME:"postgres",DB_PASSWORD:"fixture"}};
 await writeFile(f.deployment.installationFile,JSON.stringify(installation));
 const queries=[];let resets=1;
 const deployment=await loadWindowsDeployment(f.deployment.installationFile,{skipHostCheck:true,runner:(_exe,args)=>{
  const query=args.at(-1);queries.push(query);
  if(query.includes("pg_tables"))return "plate_reads\nplates";
  if(resets-->0)throw new Error('psql: connection to server failed: server closed the connection unexpectedly');
  return "plate_reads|2\nplates|1";
 }});
 assert.deepEqual(await deployment.counts(),{plate_reads:"2",plates:"1"});
 assert.equal(queries.length,4);assert.match(queries[1],/UNION ALL/);
 const refused=await loadWindowsDeployment(f.deployment.installationFile,{skipHostCheck:true,runner:()=>"bad;drop table plates"});
 await assert.rejects(refused.counts(),/Unexpected public table name/);
 const unavailable=await loadWindowsDeployment(f.deployment.installationFile,{skipHostCheck:true,runner:()=>{throw new Error("connection to server failed");}});
 await assert.rejects(unavailable.counts(),/connection to server failed/);
});
test("package paths reject traversal, ADS, reserved names, and ambiguous Win32 suffixes", () => {
  for (const name of ["../outside","app/../secret","C:/secret","app\\server.js","app/CON.txt","app/name:stream","app/a.","app/a ","/absolute"]) assert.throws(() => safePackagePath("/fixture",name));
});
test("packages reject modified, additional, and linked files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(),"alpr-package-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  await makePackage(root,"0.1.47","a".repeat(40));
  await verifyWindowsPackage(root);
  await writeFile(path.join(root,"app","server.js"),"tampered");
  await assert.rejects(verifyWindowsPackage(root), /checksum/);
  await writeFile(path.join(root,"app","server.js"),"// fixture");
  await writeFile(path.join(root,"extra.txt"),"unexpected");
  await assert.rejects(verifyWindowsPackage(root), /inventory/);
  await rm(path.join(root,"extra.txt"));
  await symlink(path.join(root,"app"),path.join(root,"linked-app"),process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyWindowsPackage(root), /links/);
});
test("Windows and Linux OpenVINO archives have independent pinned checksums", () => {
  const win = openvinoRuntimeInstallerInternals.runtimeForHost("win32","x64");
  const linux = openvinoRuntimeInstallerInternals.runtimeForHost("linux","x64");
  assert.equal(win.sha256,"d344132e42852a43ad8a1f7a5e91007fc31739b7b6cd6050cc5f3d397223cd2e");
  assert.equal(linux.sha256,"ec2cfcd283b9d2183899ea9a82be543d1144dae0fae58e6ee9894ce1b43730a6");
  assert.notEqual(win.sha256,linux.sha256);
  assert.throws(() => openvinoRuntimeInstallerInternals.runtimeForHost("win32","arm64"));
});
test("native update stops, backs up, migrates, validates, accepts, and restores the prior release", async (t) => {
  const f = await fixture(t);
  let state = await runWindowsUpdater(f.args,{},f.options);
  assert.equal(state.status,"ready-for-acceptance");
  assert.deepEqual(f.deployment.operations,["stop","migrate","start"]);
  await assert.rejects(runWindowsUpdater(["accept"],{}, {deployment:f.deployment}),/ALPR_UPDATE_ACCEPTANCE/);
  state = await runWindowsUpdater(["accept"],{},f.options);
  assert.equal(state.status,"accepted");
  await assert.rejects(runWindowsUpdater(["cleanup"],{},f.options), /retention/);
  state = await runWindowsUpdater(["rollback"],{},f.options);
  assert.equal(state.status,"rolled-back");
  assert.equal(JSON.parse(await readFile(f.deployment.installationFile,"utf8")).current,f.deployment.installation.current);
  state = await runWindowsUpdater(["cleanup"],{},f.options);
  assert.ok(state.backup.cleanedAt);
});
test("untrusted package checksum refuses before stopping services", async (t) => {
  const f = await fixture(t);
  f.args[f.args.length-1] = "0".repeat(64);
  await assert.rejects(runWindowsUpdater(f.args,{},f.options), /trusted checksum/);
  assert.deepEqual(f.deployment.operations,[]);
});
test("row loss and changed images block native acceptance", async (t) => {
  const f = await fixture(t);
  await runWindowsUpdater(f.args,{},f.options);
  f.deployment.counts = async () => ({plate_reads:"0",plates:"1"});
  await assert.rejects(runWindowsUpdater(["validate"],{},f.options),/row counts decreased/);
  f.deployment.counts = async () => ({plate_reads:"1",plates:"1"});
  await writeFile(path.join(f.deployment.data,"storage","image.jpg"),"different image");
  await assert.rejects(runWindowsUpdater(["validate"],{},f.options),/changed or disappeared/);
  assert.throws(() => assertPreservedFiles({"a":"abc"},{"a":"def"}));
});
test("tampered rollback dump refuses before stopping the application", async (t) => {
  const f = await fixture(t);
  const state = await runWindowsUpdater(f.args,{},f.options);
  await writeFile(path.join(f.deployment.backupRoot,state.backup.id,"postgres.dump"),"tampered");
  const before = [...f.deployment.operations];
  await assert.rejects(runWindowsUpdater(["rollback"],{},f.options), /checksum/);
  assert.deepEqual(f.deployment.operations,before);
});
test("a healthy listener from the wrong release blocks native acceptance", async (t) => {
  const f = await fixture(t);
  await runWindowsUpdater(f.args,{},f.options);
  f.deployment.attest = async () => ({ current:f.deployment.installation.current, commit:"a".repeat(40), status:"Running", listenerOwned:true });
  await assert.rejects(runWindowsUpdater(["accept"],{},f.options), /target release listener/);
});
test("rollback verifies the restored service listener before declaring recovery complete", async (t) => {
  const f = await fixture(t);
  const state = await runWindowsUpdater(f.args,{},f.options);
  f.deployment.attest = async () => ({current:state.target.name,commit:state.target.commit,status:"Running",listenerOwned:true});
  await assert.rejects(runWindowsUpdater(["rollback"],{},f.options), /target release listener/);
  assert.equal((await runWindowsUpdater(["status"],{},f.options)).status,"rollback-failed");
});
test("backup failure restarts the existing application and cleanup is limited to its incomplete backup", async (t) => {
  const f = await fixture(t);
  f.deployment.pg = () => { throw new Error("fixture dump failed"); };
  await assert.rejects(runWindowsUpdater(f.args,{},f.options), /dump failed/);
  assert.deepEqual(f.deployment.operations,["stop","start"]);
  const state = await runWindowsUpdater(["cleanup"],{},f.options);
  assert.equal(state.status,"rolled-back");
  assert.ok(state.backup.cleanedAt);
});
test("maintenance refuses concurrent operations", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.deployment.backupRoot,"maintenance.lock"),"12345");
  await assert.rejects(runWindowsUpdater(["status"],{},f.options),/lock exists/);
});
test("UI updates recover the old database and service automatically when migration fails",async t=>{
  const f=await fixture(t);
  f.deployment.migrate=()=>{throw new Error("fixture migration failed");};
  await assert.rejects(runWindowsUpdater(f.args,{}, {...f.options,automaticRecovery:true}),/fixture migration failed/);
  const state=await runWindowsUpdater(["status"],{},f.options);
  assert.equal(state.status,"rolled-back");assert.equal(state.recovery.previousApplicationRestored,true);
  assert.equal((await f.deployment.attest()).commit,f.deployment.current.commit);
  assert.ok(f.deployment.operations.includes("restore"));
});
test("the next UI update preserves an accepted backup during its retention window",async t=>{
  const f=await fixture(t);
  const first=await runWindowsUpdater(f.args,{},f.options);
  await runWindowsUpdater(["accept"],{},f.options);
  f.deployment.current=JSON.parse(await readFile(path.join(f.deployment.releaseRoot,first.target.name,"windows-package.json"),"utf8"));
  f.deployment.installation=JSON.parse(await readFile(f.deployment.installationFile,"utf8"));
  const target=path.join(f.root,"next");await makePackage(target,"0.1.48","c".repeat(40));
  const next=await runWindowsUpdater(["update","--package",target,"--manifest-sha256",await hashFile(path.join(target,"windows-package.json"))],{}, {...f.options,retainPrevious:true});
  assert.equal(next.status,"ready-for-acceptance");
  assert.equal(await hashFile(path.join(f.deployment.backupRoot,first.backup.id,"postgres.dump")),first.backup.dumpSha256);
  const history=JSON.parse(await readFile(path.join(f.deployment.backupRoot,`history-${first.backup.id}.json`),"utf8"));
  assert.equal(history.status,"accepted");assert.equal(history.backup.id,first.backup.id);
});
test("interrupted migration recovery uses a dead process lock and never replays installation",async t=>{
  const f=await fixture(t);
  f.deployment.migrate=()=>{throw new Error("interrupted migration");};
  await assert.rejects(runWindowsUpdater(f.args,{},f.options),/interrupted migration/);
  const dead=spawnSync(process.execPath,["-e","process.exit(0)"],{windowsHide:true});
  await writeFile(path.join(f.deployment.backupRoot,"maintenance.lock"),String(dead.pid));
  await assert.rejects(runWindowsUpdater(["recover"],{},f.options),/Unsupported/);
  const state=await runWindowsUpdater(["recover"],{}, {...f.options,internalRecovery:true});
  assert.equal(state.status,"rolled-back");assert.equal(state.recovery.interrupted,true);
  assert.equal((await f.deployment.attest()).commit,"a".repeat(40));
});
test("interrupted recovery refuses to steal a live maintenance process lock",async t=>{
 const f=await fixture(t);await writeFile(path.join(f.deployment.backupRoot,"maintenance.lock"),String(process.pid));
 await assert.rejects(runWindowsUpdater(["recover"],{}, {...f.options,internalRecovery:true}),/still running/);
 assert.deepEqual(f.deployment.operations,[]);
});
test("Windows installer parses with inbox PowerShell 5.1", {skip:process.platform !== "win32"}, () => {
  const command = "$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:ALPR_TEST_INSTALLER,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|Out-String|Write-Error;exit 1}";
  for (const file of ["Install.ps1","Service-Control.ps1"]) {
    const result = spawnSync(path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-NonInteractive","-Command",command],{encoding:"utf8",windowsHide:true,env:{...process.env,ALPR_TEST_INSTALLER:path.resolve("scripts/windows",file)}});
    assert.equal(result.status,0,result.stderr);
  }
});

async function stagingFixture(t, runner = () => "", options = {}) {
  const f = await fixture(t);
  await writeFile(f.deployment.installationFile, JSON.stringify({...f.deployment.installation,formatVersion:1,profile:"windows-native",environment:{DB_HOST:"127.0.0.1:5432",DB_USER:"postgres",DB_NAME:"postgres",DB_PASSWORD:"fixture"}}));
  const deployment = await loadWindowsDeployment(f.deployment.installationFile,{skipHostCheck:true,runner,...options});
  return {...f,deployment,destination:path.join(deployment.releaseRoot,"0.1.47-"+"b".repeat(12))};
}
test("native staging reuses a fully verified release after an interrupted update",async t=>{
  const probes=[];const f=await stagingFixture(t,(exe,args)=>{probes.push({exe,args});return "";});
  await cp(f.target,f.destination,{recursive:true});
  const first=await f.deployment.stage(f.target);const second=await f.deployment.stage(f.target);
  assert.equal(first.reused,true);assert.equal(second.reused,true);assert.equal(probes.length,2);
  assert.deepEqual(await readdir(f.deployment.releaseRoot),[f.deployment.installation.current,path.basename(f.destination)]);
  assert.equal(JSON.parse(await readFile(f.deployment.installationFile,"utf8")).current,f.deployment.installation.current);
});
test("native staging preserves an incomplete old copy and publishes only a verified replacement",async t=>{
  const f=await stagingFixture(t);await mkdir(f.destination);await writeFile(path.join(f.destination,"interrupted.txt"),"preserve this old copy");
  const result=await f.deployment.stage(f.target);assert.equal(result.path,f.destination);
  assert.equal(await readFile(path.join(result.preserved,"interrupted.txt"),"utf8"),"preserve this old copy");
  assert.equal((await verifyWindowsPackage(f.destination)).commit,"b".repeat(40));
  assert.equal(path.dirname(result.preserved),f.deployment.releaseRoot);
  assert.equal(JSON.parse(await readFile(f.deployment.installationFile,"utf8")).current,f.deployment.installation.current);
});
test("a failed native probe leaves the selected release unchanged and a later retry can succeed",async t=>{
  let fail=true;const f=await stagingFixture(t,()=>{if(fail)throw new Error("fixture CPU probe failed");return "";});
  await assert.rejects(f.deployment.stage(f.target),/CPU probe failed/);
  await assert.rejects(readFile(path.join(f.destination,"windows-package.json")),{code:"ENOENT"});
  fail=false;await f.deployment.stage(f.target);
  assert.equal((await verifyWindowsPackage(f.destination)).commit,"b".repeat(40));
  assert.equal(JSON.parse(await readFile(f.deployment.installationFile,"utf8")).current,f.deployment.installation.current);
});
test("native staging refuses to replace an active release or a linked target",async t=>{
  const f=await stagingFixture(t);await cp(f.target,f.destination,{recursive:true});
  const installation=JSON.parse(await readFile(f.deployment.installationFile,"utf8"));
  await writeFile(f.deployment.installationFile,JSON.stringify({...installation,current:path.basename(f.destination)}));
  await assert.rejects(f.deployment.stage(f.target),/active Windows release/);
  await writeFile(f.deployment.installationFile,JSON.stringify(installation));await rm(f.destination,{recursive:true});
  await symlink(f.target,f.destination,process.platform==="win32"?"junction":"dir");
  await assert.rejects(f.deployment.stage(f.target),/links|junctions/);
  assert.equal((await verifyWindowsPackage(f.target)).commit,"b".repeat(40));
});

test("native staging waits for temporary Windows sharing failures without stopping the app", async t => {
  let attempts=0;const delays=[];
  const {rename}=await import("node:fs/promises");
  const f=await stagingFixture(t,()=>"",{releaseMoveOptions:{
    renameDirectory:async(from,to)=>{if(++attempts<=2)throw Object.assign(new Error("fixture sharing violation"),{code:"EPERM"});await rename(from,to);},
    sleep:async ms=>delays.push(ms),
  }});
  const result=await f.deployment.stage(f.target);
  assert.equal(attempts,3);assert.deepEqual(delays,[100,200]);
  assert.equal((await verifyWindowsPackage(result.path)).commit,"b".repeat(40));
  assert.equal(JSON.parse(await readFile(f.deployment.installationFile,"utf8")).current,f.deployment.installation.current);

});

test("persistent Windows access failure is bounded and preserves the active release and staged copy", async t => {
  let attempts=0;const delays=[];
  const f=await stagingFixture(t,()=>"",{releaseMoveOptions:{
    renameDirectory:async()=>{attempts++;throw Object.assign(new Error("fixture permanent access denial"),{code:"EACCES"});},
    sleep:async ms=>delays.push(ms),
  }});
  await assert.rejects(f.deployment.stage(f.target),error=>error.code==="EACCES"&&/locked or inaccessible/.test(error.message)&&error.cause.message==="fixture permanent access denial");
  assert.equal(attempts,12);assert.equal(delays.reduce((a,b)=>a+b,0),29500);
  const staged=(await readdir(f.deployment.releaseRoot)).filter(name=>name.startsWith(".staging-"));assert.equal(staged.length,1);
  assert.equal((await verifyWindowsPackage(path.join(f.deployment.releaseRoot,staged[0]))).commit,"b".repeat(40));
  assert.equal(JSON.parse(await readFile(f.deployment.installationFile,"utf8")).current,f.deployment.installation.current);

});

test("a retry rechecks the selected release before moving a directory", async t => {
  let moves=0;let f;
  f=await stagingFixture(t,()=>"",{releaseMoveOptions:{
    renameDirectory:async()=>{moves++;throw Object.assign(new Error("fixture lock"),{code:"EPERM"});},
    sleep:async()=>{const installation=JSON.parse(await readFile(f.deployment.installationFile,"utf8"));await writeFile(f.deployment.installationFile,JSON.stringify({...installation,current:path.basename(f.destination)}));},
  }});
  await assert.rejects(f.deployment.stage(f.target),/active Windows release/);assert.equal(moves,1);
});

test("Windows release move recovers from a real child file handle denying delete sharing", {skip:process.platform!=="win32"}, async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),"alpr-sharing-"));
  const source=path.join(root,"pending"),destination=path.join(root,"release"),signal=path.join(root,"release-lock");
  await mkdir(source);const file=path.join(source,"locked.dll");await writeFile(file,"synthetic native library");
  const script="$ErrorActionPreference='Stop';$h=[IO.File]::Open($env:ALPR_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::Out.WriteLine('ready');while(-not [IO.File]::Exists($env:ALPR_LOCK_SIGNAL)){Start-Sleep -Milliseconds 25}}finally{$h.Dispose()}";
  const child=spawn(path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,env:{...process.env,ALPR_LOCK_FILE:file,ALPR_LOCK_SIGNAL:signal},stdio:["ignore","pipe","pipe"]});
  try {
    await new Promise((resolve,reject)=>{let output="",errors="";const deadline=setTimeout(()=>reject(new Error("Windows lock fixture timed out: "+errors)),10000);child.stdout.on("data",chunk=>{output+=chunk;if(output.includes("ready")){clearTimeout(deadline);resolve();}});child.stderr.on("data",chunk=>errors+=chunk);child.once("error",reject);child.once("exit",code=>{clearTimeout(deadline);if(!output.includes("ready"))reject(new Error("Windows lock fixture failed: "+code+errors));});});
    const {rename}=await import("node:fs/promises");
    await assert.rejects(rename(source,destination),error=>["EPERM","EACCES","EBUSY"].includes(error.code));
    let waits=0;
    await renameWindowsReleaseDirectory(source,destination,{sleep:async ms=>{waits++;await writeFile(signal,"release");await new Promise(resolve=>setTimeout(resolve,ms));}});
    assert.ok(waits>=1);assert.equal(await readFile(path.join(destination,"locked.dll"),"utf8"),"synthetic native library");
  } finally {
    await writeFile(signal,"release");
    if(child.exitCode===null)await new Promise(resolve=>{child.once("exit",resolve);setTimeout(()=>child.kill(),2000).unref();});
    assert.equal(path.dirname(root),os.tmpdir());await rm(root,{recursive:true,force:true});
  }
});
