import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { repairWindowsCode } from "../scripts/windows-code-repair.mjs";
import { COMMUNITY_SOURCE, hashFile, listPackageFiles, verifyWindowsPackage } from "../scripts/windows-native-package.mjs";
import { atomicJson } from "../scripts/windows-deployment.mjs";
import { verifyWindowsSetupStartup } from "../scripts/test-windows-setup-startup.mjs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(),"alpr-code-repair-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const make = async (name,commit) => {
    const directory = path.join(root,name);
    const content = {"app/server.js":"// fixture", "app/package.json":'{"version":"0.1.46"}',
      "runtime/node.exe":"fixture", "runtime/winsw.exe":"fixture", "host/windows-service.mjs":"// fixture",
      "host/windows-maintenance.mjs":"// fixture", "schema.sql":"-- unchanged", "migrations.sql":"-- unchanged", "Install.ps1":"# fixture"};
    for (const [file,value] of Object.entries(content)) {
      const destination = path.join(directory,...file.split("/"));
      await mkdir(path.dirname(destination),{recursive:true});
      await writeFile(destination,value);
    }
    const files = {};
    for (const file of await listPackageFiles(directory)) files[file] = await hashFile(path.join(directory,...file.split("/")));
    const manifest = {formatVersion:1,source:COMMUNITY_SOURCE,version:"0.1.46",commit,channel:"preview",platform:"win32",arch:"x64",files};
    await atomicJson(path.join(directory,"windows-package.json"),manifest);
    return {directory,manifest};
  };
  const previous = await make("previous","a".repeat(40));
  const target = await make("target","b".repeat(40));
  const data = path.join(root,"data");
  await mkdir(path.join(data,"management/backups"),{recursive:true});
  await writeFile(path.join(data,"auth.json"),"existing password fixture");
  await writeFile(path.join(data,"plate-image.jpg"),"existing image fixture");
  const installation = {current:"0.1.46-"+"a".repeat(12),environment:{password:"private fixture"}};
  const installationFile = path.join(root,"installation.json");
  await atomicJson(installationFile,installation);
  const operations = [];
  const deployment = {root,data,releaseRoot:path.join(root,"releases"),installation,installationFile,current:previous.manifest,
    backupRoot:path.join(data,"management/backups"),
    service(operation){operations.push(operation);},
    async health(){return {status:"ok"};},
    async attest(){const current=JSON.parse(await readFile(installationFile,"utf8")).current;
      return {current,commit:current===installation.current?previous.manifest.commit:target.manifest.commit,status:"Running",listenerOwned:true};},
    async stage(packageRoot){const manifest=await verifyWindowsPackage(packageRoot,{allowPreview:true});
      const name=manifest.version+"-"+manifest.commit.slice(0,12),destination=path.join(this.releaseRoot,name);
      await cp(packageRoot,destination,{recursive:true});return {name,path:destination};},
    async switchRelease(current){await atomicJson(installationFile,{...installation,current});},
    migrate(){throw new Error("Code repair must never migrate");},
    pg(){throw new Error("Code repair must never change the database");},
  };
  return {root,target,installation,installationFile,deployment,operations,
    args:{packageRoot:target.directory,manifestSha256:await hashFile(path.join(target.directory,"windows-package.json")),fromCommit:previous.manifest.commit},
    options:{deployment,confirmed:true}};
}

test("code repair selects verified code while preserving password, images and schema",async(t)=>{
  const f=await fixture(t);
  const result=await repairWindowsCode(f.args,{},f.options);
  assert.equal(result.status,"repaired");
  assert.deepEqual(f.operations,["stop","start"]);
  assert.equal(JSON.parse(await readFile(f.installationFile,"utf8")).current,"0.1.46-"+"b".repeat(12));
  assert.equal(await readFile(path.join(f.deployment.data,"auth.json"),"utf8"),"existing password fixture");
  assert.equal(await readFile(path.join(f.deployment.data,"plate-image.jpg"),"utf8"),"existing image fixture");
});
test("unapproved or mismatched repairs refuse before stopping the service",async(t)=>{
  const f=await fixture(t);
  await assert.rejects(repairWindowsCode(f.args,{}, {deployment:f.deployment}),/ALPR_CODE_REPAIR/);
  await assert.rejects(repairWindowsCode({...f.args,manifestSha256:"0".repeat(64)}, {},f.options),/trusted checksum/);
  await assert.rejects(repairWindowsCode({...f.args,fromCommit:"c".repeat(40)}, {},f.options),/exact installed/);
  f.deployment.current.files["migrations.sql"]="0".repeat(64);
  await assert.rejects(repairWindowsCode(f.args,{},f.options),/schema or migrations/);
  assert.deepEqual(f.operations,[]);
});
test("changed code, pending updates and concurrent maintenance refuse without stopping",async(t)=>{
  const f=await fixture(t);
  await writeFile(path.join(f.target.directory,"app/server.js"),"tampered");
  await assert.rejects(repairWindowsCode(f.args,{},f.options),/checksum/);
  await writeFile(path.join(f.target.directory,"app/server.js"),"// fixture");
  const state=path.join(f.deployment.backupRoot,"updater-state.json");
  await atomicJson(state,{status:"ready-for-acceptance"});
  await assert.rejects(repairWindowsCode(f.args,{},f.options),/pending update/);
  await rm(state);
  await writeFile(path.join(f.deployment.backupRoot,"maintenance.lock"),"fixture");
  await assert.rejects(repairWindowsCode(f.args,{},f.options),/in progress/);
  assert.deepEqual(f.operations,[]);
});
test("failed repaired startup restores previous code without restoring a database",async(t)=>{
  const f=await fixture(t);
  let calls=0;
  f.deployment.health=async()=>{if(++calls===1)throw new Error("fixture startup failure");};
  await assert.rejects(repairWindowsCode(f.args,{},f.options),/previous application was restored/);
  assert.deepEqual(JSON.parse(await readFile(f.installationFile,"utf8")),f.installation);
  assert.deepEqual(f.operations,["stop","start","stop","start"]);
});
test("a wrong repaired listener triggers code recovery",async(t)=>{
  const f=await fixture(t);
  const original=f.deployment.attest;
  let calls=0;
  f.deployment.attest=async()=>{const running=await original();return ++calls===2?{...running,listenerOwned:false}:running;};
  await assert.rejects(repairWindowsCode(f.args,{},f.options),/previous application was restored/);
  assert.equal(JSON.parse(await readFile(f.installationFile,"utf8")).current,f.installation.current);
});
test("the repair PowerShell script parses with inbox Windows PowerShell 5.1",{skip:process.platform!=="win32"},()=>{
  const env={...process.env,ALPR_TEST_REPAIR:path.resolve("scripts/windows/Repair.ps1")};
  delete env.PSModulePath;
  const result=spawnSync(path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile","-NonInteractive","-Command","$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:ALPR_TEST_REPAIR,[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|Out-String|Write-Error;exit 1}"],{env,encoding:"utf8",windowsHide:true});
  assert.equal(result.status,0,result.stderr);
});
const compiler=process.env.ALPR_ISCC_PATH || path.resolve(".native-dependencies/inno-6.7.3/ISCC.exe");
test("compiled repair wizard starts without installing or elevating",{skip:process.platform!=="win32" || !existsSync(compiler)},async()=>{
  const result=await verifyWindowsSetupStartup({compiler,sourceFile:path.resolve("scripts/windows/CommunityRepair.iss")});
  assert.equal(result.verified,true);
});
