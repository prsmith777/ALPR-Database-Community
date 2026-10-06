import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runtimeDataPath } from "../lib/runtime-paths.mjs";
import { assertWindowsHost, COMMUNITY_SOURCE, hashFile, listPackageFiles, safePackagePath, verifyWindowsPackage } from "../scripts/windows-native-package.mjs";
import { assertPreservedFiles } from "../scripts/windows-deployment.mjs";
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
test("Windows installer parses with inbox PowerShell 5.1", {skip:process.platform !== "win32"}, () => {
  const command = "$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:ALPR_TEST_INSTALLER,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|Out-String|Write-Error;exit 1}";
  for (const file of ["Install.ps1","Service-Control.ps1"]) {
    const result = spawnSync(path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-NonInteractive","-Command",command],{encoding:"utf8",windowsHide:true,env:{...process.env,ALPR_TEST_INSTALLER:path.resolve("scripts/windows",file)}});
    assert.equal(result.status,0,result.stderr);
  }
});
