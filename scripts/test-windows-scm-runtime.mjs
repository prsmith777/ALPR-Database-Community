import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeRunner, loadWindowsDeployment, fileInventory } from "./windows-deployment.mjs";
import { hashFile, listPackageFiles, verifyWindowsPackage } from "./windows-native-package.mjs";
import { runWindowsUpdater } from "./windows-maintenance.mjs";
import {changeWindowsDatabasePort} from "./windows-database-port.mjs";
import {changeWindowsApplicationPort} from "./windows-application-port.mjs";
import { enableWindowsUpdates } from "./windows-enable-updates.mjs";

// Actual SCM integration test, deliberately isolated from the product service
// namespace. Only fixed service identifiers are substituted in copied scripts;
// SCM start/stop, service accounts, SID ACLs, WinSW and listener attestation are real.
// Run elevated on a disposable Windows desktop, using two real release packages.
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [targetArg, previousArg, pgArg, ffArg, reportArg] = process.argv.slice(2);
if (!reportArg) throw new Error("Usage: test-windows-scm-runtime.mjs TARGET_PACKAGE PREVIOUS_PACKAGE PG_BIN FFMPEG_BIN REPORT_JSON");
const [target, previous, pgBin, ffBin, reportFile] = [targetArg, previousArg, pgArg, ffArg, reportArg].map(p => path.resolve(p));
const psExe = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
const q = value => "'" + value.replaceAll("'", "''") + "'";
function ps(code) {
  const env = { ...process.env }; delete env.PSModulePath;
  return nativeRunner(psExe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "$ErrorActionPreference='Stop';" + code], { env, timeout: 240_000 });
}
assert.equal(ps("$p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent());$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"), "True", "Approve the administrator prompt for this isolated SCM test");
const id = randomUUID().replaceAll("-", "");
const names = { app: "ALPRTestApp" + id, database: "ALPRTestDatabase" + id, updater:"ALPRTestUpdater"+id };
const root = path.join(process.env.ProgramData, "ALPR SCM Acceptance", id);
const programs = path.join(root, "programs"), commonData = path.join(root, "data");
const installRoot = path.join(programs, "ALPR Community"), dataRoot = path.join(commonData, "ALPR Community");
const installationFile = path.join(installRoot, "installation.json");
const report = { startedAt: new Date().toISOString(), scope: "Isolated service names, roots and loopback ports; working ALPR services and data are never targeted", boundary: "Real Windows SCM, WinSW, LocalService/NetworkService, service SID ACLs and production service-controller logic", status: "running" };
const substitute = text => text.replaceAll("ALPRCommunityApp", names.app).replaceAll("ALPRCommunityDatabase", names.database).replaceAll("ALPRCommunityUpdater",names.updater);
async function freePort() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function installerPackage(source, folder) {
  await cp(source, folder, { recursive: true, errorOnExist: true, force: false });
  for (const name of ["Database-Port.ps1","Application-Port.ps1","Install.ps1", "Setup-Helpers.ps1", "Network-Helpers.ps1", "Service-Control.ps1","Update-Service.ps1","Pause-Updates.ps1","Enable-Updates.ps1","Expand-Update.ps1"]) {
    const destination = name === "Install.ps1" ? path.join(folder, name) : path.join(folder, "host", name);
    let script=substitute(await readFile(path.join(checkout, "scripts/windows", name), "utf8"));
    if(["Application-Port.ps1","Database-Port.ps1"].includes(name)) {
      script=script.replace('"$env:ProgramData\\ALPR Community"',q(dataRoot));
      script=script.replace("[Environment]::GetFolderPath('CommonDesktopDirectory')",q(path.join(root,"shortcuts/desktop")));
      script=script.replace("[Environment]::GetFolderPath('CommonPrograms')",q(path.join(root,"shortcuts/programs")));
    }
    await writeFile(destination,script);
  }
  for(const name of ["windows-database-port.mjs","windows-application-port.mjs","windows-update-service.mjs","windows-update-worker.mjs","windows-update-release.mjs","windows-update-host.mjs","windows-enable-updates.mjs","windows-maintenance.mjs","windows-deployment.mjs","windows-native-package.mjs","native-reid-upgrade-policy.mjs"]){await cp(path.join(checkout,"scripts",name),path.join(folder,"host",name));}
  await mkdir(path.join(folder,"lib"),{recursive:true});
  for(const name of ["community-update-control.mjs","community-update-shape.mjs"]){await cp(path.join(checkout,"lib",name),path.join(folder,"lib",name));}
  const manifest = JSON.parse(await readFile(path.join(folder, "windows-package.json"), "utf8"));
  manifest.files = {};
  for (const name of (await listPackageFiles(folder)).filter(name => name !== "windows-package.json")) manifest.files[name] = await hashFile(path.join(folder, ...name.split("/")));
  await writeFile(path.join(folder, "windows-package.json"), JSON.stringify(manifest, null, 2) + "\n");
  await verifyWindowsPackage(folder, { allowPreview: true });
  return folder;
}
function install(folder, reuse = false) {
  const output = ps("& " + q(path.join(folder, "Install.ps1")) + " -AllowPreview -CopyPrerequisites -InstallRoot " + q(installRoot) + " -DataRoot " + q(dataRoot) + " -PgBin " + q(pgBin) + " -FfmpegBin " + q(ffBin) + " -AppPort " + appPort + " -DatabasePort " + dbPort + (reuse ? " -ReuseRetainedData" : " -ListenOnNetwork"));
  return writeFile(path.join(root, reuse ? "reinstall.log" : "install.log"), output);
}
const appPort = await freePort(), dbPort = await freePort();
async function signedInActions(deployment) {
  const base="http://127.0.0.1:"+deployment.installation.environment.PORT;
  const selected=path.join(deployment.releaseRoot,deployment.installation.current,"app");
  const actions=JSON.parse(await readFile(path.join(selected,".next/server/server-reference-manifest.json"),"utf8"));
  const actionId=name=>Object.entries(actions.node).find(([,value])=>value.exportedName === name)?.[0];
  const login=new FormData();login.set("$ACTION_ID_"+actionId("loginAction"),"");login.set("username","");login.set("password",deployment.installation.environment.ADMIN_PASSWORD);
  const response=await fetch(base+"/login",{method:"POST",headers:{origin:base},body:login});
  const cookie=response.headers.getSetCookie().find(value=>value.startsWith("session="))?.split(";")[0];
  assert.ok(cookie,"Isolated installation must accept its existing administrator password");
  return async(input,expectedPhase="succeeded")=>{
    console.log("Windows Settings operation: "+input.operation);
    const isPort=["app-port","database-port"].includes(input.operation);
    const portAction=input.operation === "database-port" ? "requestWindowsDatabasePort" : "requestWindowsApplicationPort";
    const result=await fetch(base+(isPort?"/settings/general":"/settings/software-updates"),{method:"POST",headers:{origin:base,cookie,"next-action":actionId(isPort?portAction:"requestSoftwareUpdate"),"content-type":"text/plain;charset=UTF-8",accept:"text/x-component"},body:JSON.stringify([isPort?(input.operation === "database-port"?input.databasePort:input.appPort):input])});
    const text=await result.text();assert.equal(result.status,200);
    const value=text.split("\n").filter(line=>/^\d+:\{/.test(line)).map(line=>{try{return JSON.parse(line.slice(line.indexOf(":")+1));}catch{return null;}}).find(value=>typeof value?.success === "boolean");
    assert.ok(value,"Real HTTP server action must return its result");assert.equal(value.success,true,value.error);
    let lastMessage;
    for(let attempt=0;attempt<1200;attempt++){
      const state=JSON.parse(await readFile(path.join(dataRoot,"update-control/state.json"),"utf8"));
      if(state.requestId === value.request.requestId && state.message !== lastMessage){console.log(state.message);lastMessage=state.message;}
      if(state.requestId === value.request.requestId && ["succeeded","failed"].includes(state.phase)){assert.equal(state.phase,expectedPhase,state.message);return state;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error("Windows UI operation did not finish within its acceptance deadline");
  };
}
async function installFixtureReleaseSource(candidate) {
  // Simulate GitHub responses in this private, namespaced fixture only. The
  // production discovery/download functions, ZIP extraction, worker, SCM and
  // HTTP server actions remain under test. No custom URL option ships to users.
  const archive=path.join(root,"fixture-update.zip");
  ps("Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory("+q(candidate)+","+q(archive)+",[IO.Compression.CompressionLevel]::Optimal,$false)");
  const manifest=JSON.parse(await readFile(path.join(candidate,"windows-package.json"),"utf8"));
  const {windowsUpdateAssetNames}=await import("./windows-update-release.mjs");
  const names=windowsUpdateAssetNames("v"+manifest.version);
  const {stat}=await import("node:fs/promises");
  const source="https://github.com/prsmith777/ALPR-Database-Community",tag="v"+manifest.version;
  const metadata={formatVersion:1,updaterProtocol:1,source,tag,channel:"stable",commit:manifest.commit,manifestSha256:await hashFile(path.join(candidate,"windows-package.json")),archive:{name:names.archive,sha256:await hashFile(archive),sizeBytes:(await stat(archive)).size}};
  const metadataFile=path.join(root,"fixture-update.json");await writeFile(metadataFile,JSON.stringify(metadata));
  const assets=[{name:names.archive,digest:"sha256:"+metadata.archive.sha256,size:metadata.archive.sizeBytes},{name:names.metadata,digest:"sha256:"+await hashFile(metadataFile),size:(await stat(metadataFile)).size}].map(asset=>({...asset,state:"uploaded",browser_download_url:`${source}/releases/download/${tag}/${asset.name}`}));
  const release={tag_name:tag,html_url:`${source}/releases/tag/${tag}`,draft:false,prerelease:false,assets};
  const mock=`import {readFile} from 'node:fs/promises';
export async function fixtureFetch(url){
 if(url.endsWith('/releases/latest') || url.endsWith('/releases/tags/${tag}'))return Response.json(${JSON.stringify(release)});
 if(url.endsWith('/${names.metadata}'))return new Response(await readFile(${JSON.stringify(metadataFile)}));
 if(url.endsWith('/${names.archive}'))return new Response(await readFile(${JSON.stringify(archive)}));
 if(url.endsWith('/git/ref/tags/${tag}'))return Response.json({ref:'refs/tags/${tag}',object:{type:'commit',sha:'${manifest.commit}'}});
 throw new Error('Unexpected fixture release URL');
}`;
  await writeFile(path.join(installRoot,"host/fixture-release.mjs"),mock);
  const worker=path.join(installRoot,"host/windows-update-worker.mjs");
  const original=await readFile(worker,"utf8");
  const changed=original.replace('import { findWindowsUpdate, downloadWindowsUpdate } from "./windows-update-release.mjs";',
    'import { findWindowsUpdate as realFind, downloadWindowsUpdate as realDownload } from "./windows-update-release.mjs";\nimport {fixtureFetch} from "./fixture-release.mjs";\nconst findWindowsUpdate=(current,target)=>realFind(current,target,{fetch:fixtureFetch});\nconst downloadWindowsUpdate=(candidate,destination,options)=>realDownload(candidate,destination,{...options,fetch:fixtureFetch});');
  assert.notEqual(changed,original);await writeFile(worker,changed);
  return {gitHubResponses:"isolated fixture",archiveSha256:metadata.archive.sha256};
}
let deployment;
try {
  ps(". " + q(path.join(checkout, "scripts/windows/Setup-Helpers.ps1")) + ";Protect-SetupDirectory " + q(root));
  // Node canonicalizes every ancestor. Unlike Program Files/ProgramData,
  // the deliberately private fixture scaffold has no default service-account
  // read access. Grant directory-only access; product roots retain their own
  // service-SID ACLs and private files do not inherit these account grants.
  ps("foreach($p in @(" + [root, programs, commonData].map(q).join(",") + ")){[void][IO.Directory]::CreateDirectory($p);$acl=Get-Acl -LiteralPath $p;foreach($sid in @('S-1-5-19','S-1-5-20')){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'ReadAndExecute','None','None','Allow')))};Set-Acl -LiteralPath $p -AclObject $acl}");
  report.publicationHelperSourceSha256 = await hashFile(path.join(checkout,"scripts/windows-deployment.mjs"));
  report.updateServiceSourceSha256 = await hashFile(path.join(checkout,"scripts/windows-update-service.mjs"));
  report.installerSourceSha256 = await hashFile(path.join(checkout, "scripts/windows/Install.ps1"));
  report.databasePortHelperSourceSha256 = await hashFile(path.join(checkout,"scripts/windows/Database-Port.ps1"));
  report.databasePortControllerSourceSha256 = await hashFile(path.join(checkout,"scripts/windows-database-port.mjs"));
  report.recoveryHelperSourceSha256 = await hashFile(path.join(checkout, "scripts/windows/Setup-Helpers.ps1"));
  const older = await verifyWindowsPackage(previous, { allowPreview: true });
  const newer = await verifyWindowsPackage(target, { allowPreview: true });
  assert.notEqual(older.version, newer.version, "Use distinct real release versions for the update test");
  report.packages = { from: { version: older.version, commit: older.commit }, to: { version: newer.version, commit: newer.commit } };
  const initial = await installerPackage(previous, path.join(root, "initial-package"));
  const candidate=await installerPackage(target,path.join(root,"target-package"));
  const fixtureManifest=JSON.parse(await readFile(path.join(candidate,"windows-package.json"),"utf8"));
  fixtureManifest.channel="stable";await writeFile(path.join(candidate,"windows-package.json"),JSON.stringify(fixtureManifest));
  console.log("Installing isolated services using the real prior-version application...");
  await install(initial);
  deployment = await loadWindowsDeployment(installationFile, { allowPreview: true });
  await deployment.health(); await deployment.attest();
  const security = JSON.parse(ps("$a=Get-CimInstance Win32_Service -Filter " + q("Name='" + names.app + "'") + ";$d=Get-CimInstance Win32_Service -Filter " + q("Name='" + names.database + "'") + ";$s=Get-ItemProperty " + q("HKLM:\\SYSTEM\\CurrentControlSet\\Services\\" + names.app) + ";@{app=$a.StartName;database=$d.StartName;start=$s.Start;delayed=[bool]$s.DelayedAutoStart}|ConvertTo-Json -Compress"));
  assert.match(security.app, /LocalService$/i); assert.match(security.database, /NetworkService$/i);
  assert.equal(security.start, 2); assert.equal(security.delayed, false);
  report.serviceSecurity = security;
  await writeFile(path.join(dataRoot, "config/settings.yaml"), "general:\n  maxRecords: 9876\n");
  await mkdir(path.join(dataRoot, "storage/images"), { recursive: true });
  await writeFile(path.join(dataRoot, "storage/images/recovery.jpg"), "synthetic SCM recovery image");
  deployment.sql("INSERT INTO public.plates(plate_number,occurrence_count) VALUES ('SCMTEST1',1); INSERT INTO public.plate_reads(plate_number,camera_name,image_path,\"timestamp\") VALUES ('SCMTEST1','Isolated SCM fixture','images/recovery.jpg',CURRENT_TIMESTAMP);");
  // A populated native database can retain unbound historical direction
  // predictions. Replaying identical SQL used to delete them and roll back.
  deployment.service("stop");
  deployment.sql(`INSERT INTO public.plate_reads(plate_number,camera_name,timestamp)
    SELECT 'CNT'||(1+((n-1)%99)), 'Count validation fixture', CURRENT_TIMESTAMP+n*interval '1 second'
    FROM generate_series(1,119) n;
    INSERT INTO public.vehicle_direction_observations
      (read_id,camera_key,embedding_model,classifier_version,profile_version,status,orientation)
    SELECT id,'count validation fixture','canonical-crop-direction-v2','canonical-crop-orientation-knn-v2',1,'collecting','unknown'
    FROM public.plate_reads WHERE camera_name='Count validation fixture' ORDER BY id LIMIT 15;
    INSERT INTO public.vehicle_direction_observations
      (read_id,camera_key,embedding_model,classifier_version,profile_version,status,orientation,orientation_confidence,direction_label)
    SELECT id,'count validation fixture','blue-iris-zone-crossing','blue-iris-zone-crossing-v1',1,'ready','front',1,'toward'
    FROM public.plate_reads WHERE camera_name='Count validation fixture'
      AND id NOT IN (SELECT read_id FROM public.vehicle_direction_observations) ORDER BY id LIMIT 90;`);
  const directionsBefore = deployment.sql("SELECT json_agg(row_to_json(observation) ORDER BY read_id)::text FROM public.vehicle_direction_observations observation;");
  assert.equal(deployment.sql("SELECT count(*) FROM public.vehicle_direction_observations;"), "105");
  deployment.service("start"); await deployment.health();
  await fetch("http://127.0.0.1:" + appPort + "/api/verify-session", { method: "POST", headers: { "content-type": "application/json" }, body: '{"sessionId":"invalid"}' });
  const authFile = path.join(dataRoot, "auth/auth.json"), settingsFile = path.join(dataRoot, "config/settings.yaml");
  const auth = JSON.parse(await readFile(authFile, "utf8")), settings = await hashFile(settingsFile), images = await fileInventory(path.join(dataRoot, "storage"));
  console.log("Verifying an incomplete and then complete release-copy retry against real SCM services...");
  const occupied=path.join(deployment.releaseRoot,newer.version+"-"+newer.commit.slice(0,12));
  await mkdir(occupied);await writeFile(path.join(occupied,"interrupted-copy.txt"),"preserve incomplete prior attempt");
  const prepared=await deployment.stage(candidate);
  assert.equal(await readFile(path.join(prepared.preserved,"interrupted-copy.txt"),"utf8"),"preserve incomplete prior attempt");
  assert.equal((await deployment.stage(candidate)).reused,true);
  assert.equal((await deployment.attest()).commit,older.commit);
  report.stagingRetry={incompleteCopyPreserved:true,completeCopyVerifiedAndReused:true,priorServiceRemainedSelected:true};
  console.log("Enabling UI updates in place on the real prior-version installation...");
  await enableWindowsUpdates(candidate,await hashFile(path.join(candidate,"windows-package.json")),{...process.env,ALPR_WINDOWS_INSTALLATION:installationFile});
  deployment = await loadWindowsDeployment(installationFile, { allowPreview: true });
  assert.equal((await deployment.attest()).commit, newer.commit);
  ps(". "+q(path.join(candidate,"host/Setup-Helpers.ps1"))+";Test-InstalledSetupPayload "+q(candidate)+" "+q(installRoot));
  report.stagingRetry.expectedRunningReleaseVerified=true;
  const nativeState = await runWindowsUpdater(["status"], {}, {deployment, confirmed:true, allowPreview:true});
  assert.equal(nativeState.migration.mode, "unchanged", "Unchanged verified SQL must not replay historical cleanup");
  assert.equal(nativeState.migration.validation.passed, true);
  assert.equal(nativeState.validation.counts.vehicle_direction_observations, "105");
  assert.equal(deployment.sql("SELECT json_agg(row_to_json(observation) ORDER BY read_id)::text FROM public.vehicle_direction_observations observation;"), directionsBefore);
  report.populatedCountValidation = {status:"passed",plateReads:119,distinctPlates:99,directionObservations:105,unboundPredictions:15,blueIrisObservations:90,identicalSqlNotReplayed:true,allDirectionValuesPreserved:true};
  const updatedActions=await signedInActions(deployment);
  const accepted=await updatedActions({operation:"accept",confirmation:"I COMPLETED THE MANUAL CHECKS"});
  assert.equal(accepted.updaterStatus,"accepted");
  // Exercise the real authenticated browser action, updater IPC, PowerShell,
  // firewall, SCM, shortcuts and listener attestation on an unused custom port.
  const nextPort=await freePort();
  const shortcutFolders=[path.join(root,"shortcuts/desktop"),path.join(root,"shortcuts/programs")];
  for(const folder of shortcutFolders){await mkdir(folder,{recursive:true});await writeFile(path.join(folder,"ALPR Database Community.url"),"[InternetShortcut]\r\nURL=http://localhost:"+appPort+"\r\n");}
  const portState=await updatedActions({operation:"app-port",appPort:nextPort});assert.equal(portState.currentAppPort,nextPort);
  deployment=await loadWindowsDeployment(installationFile,{allowPreview:true});await deployment.health();await deployment.attest();
  assert.equal(deployment.installation.environment.PORT,String(nextPort));assert.equal(deployment.installation.environment.DB_HOST,"127.0.0.1:"+dbPort);
  assert.equal(deployment.installation.environment.HOSTNAME,"0.0.0.0");const portAuth=JSON.parse(await readFile(authFile,"utf8"));assert.equal(portAuth.apiKey,auth.apiKey);assert.equal(portAuth.password,auth.password);
  for(const folder of shortcutFolders)assert.match(await readFile(path.join(folder,"ALPR Database Community.url"),"utf8"),new RegExp("URL=http://localhost:"+nextPort));
  const newActions=await signedInActions(deployment);
  const portConflictSocket=net.createServer();portConflictSocket.listen(0,"0.0.0.0");await once(portConflictSocket,"listening");
  try{const refused=await newActions({operation:"app-port",appPort:portConflictSocket.address().port},"failed");assert.match(refused.message,/port is in use/);await deployment.health();await deployment.attest();}finally{await new Promise(resolve=>portConflictSocket.close(resolve));}
  // Simulate interruption after apply, before journal commit. Recovery must
  // restore the previous port without applying the same change a second time.
  const journalFile=path.join(dataRoot,"management/updates/application-port.json");const portJournal=JSON.parse(await readFile(journalFile,"utf8"));portJournal.phase="pending";await writeFile(journalFile,JSON.stringify(portJournal));
  const recoveredPort=await changeWindowsApplicationPort({id:portJournal.requestId},{...process.env},{deployment,recover:true});assert.equal(recoveredPort.currentAppPort,appPort);
  deployment=await loadWindowsDeployment(installationFile,{allowPreview:true});await deployment.health();await deployment.attest();
  for(const folder of shortcutFolders)assert.match(await readFile(path.join(folder,"ALPR Database Community.url"),"utf8"),new RegExp("URL=http://localhost:"+appPort));
  await (await signedInActions(deployment))({operation:"app-port",appPort:nextPort});
  deployment=await loadWindowsDeployment(installationFile,{allowPreview:true});await deployment.health();
  report.applicationPort={status:"passed",realHttpAdminAction:true,conflictPreservedActiveApplication:true,networkPreferencePreserved:true,databaseAndApiKeyPreserved:true,shortcutsUpdated:true,interruptedChangeRecovered:true};
  const nextDatabasePort=await freePort();
  const autoFile=path.join(dataRoot,'management/postgres/postgresql.auto.conf'),originalAutoHash=await hashFile(autoFile);
  const databaseState=await (await signedInActions(deployment))({operation:'database-port',databasePort:nextDatabasePort});
  assert.equal(databaseState.currentDatabasePort,nextDatabasePort);
  deployment=await loadWindowsDeployment(installationFile,{allowPreview:true});await deployment.health();await deployment.attest();
  assert.equal(deployment.sql("SHOW port"),String(nextDatabasePort));assert.equal(deployment.sql("SHOW listen_addresses"),'127.0.0.1');
  assert.equal(deployment.installation.environment.PORT,String(nextPort));assert.equal(await hashFile(settingsFile),settings);
  assert.deepEqual(await fileInventory(path.join(dataRoot,'storage')),images);
  const databaseAuth=JSON.parse(await readFile(authFile,'utf8'));assert.equal(databaseAuth.apiKey,auth.apiKey);assert.equal(databaseAuth.password,auth.password);
  assert.equal(deployment.sql("SELECT count(*) FROM public.plate_reads WHERE plate_number='SCMTEST1'"),'1');
  const occupiedDatabase=net.createServer();occupiedDatabase.listen(0,'0.0.0.0');await once(occupiedDatabase,'listening');
  try{const refused=await (await signedInActions(deployment))({operation:'database-port',databasePort:occupiedDatabase.address().port},'failed');assert.match(refused.message,/port is in use/);await deployment.health();}finally{await new Promise(resolve=>occupiedDatabase.close(resolve));}
  const databaseJournalFile=path.join(dataRoot,'management/updates/database-port.json');
  const databaseJournal=JSON.parse(await readFile(databaseJournalFile,'utf8'));databaseJournal.phase='pending';await writeFile(databaseJournalFile,JSON.stringify(databaseJournal));
  assert.equal((await changeWindowsDatabasePort({id:databaseJournal.requestId},process.env,{deployment,recover:true})).currentDatabasePort,dbPort);
  deployment=await loadWindowsDeployment(installationFile,{allowPreview:true});await deployment.health();
  assert.equal(deployment.sql('SHOW port'),String(dbPort));assert.equal(await hashFile(autoFile),originalAutoHash);
  // Occupy a port after preflight but before apply to force an actual PostgreSQL
  // startup failure. The recovery path must restore configuration and both services.
  const lateConflict=net.createServer(),latePort=await freePort();
  try{
    await assert.rejects(changeWindowsDatabasePort({id:randomUUID(),databasePort:latePort},process.env,{deployment,progress:async()=>{
      lateConflict.listen(latePort,'127.0.0.1');await once(lateConflict,'listening');
    }}),/previous PostgreSQL port was restored/);
  }finally{if(lateConflict.listening)await new Promise(resolve=>lateConflict.close(resolve));}
  deployment=await loadWindowsDeployment(installationFile,{allowPreview:true});await deployment.health();await deployment.attest();
  assert.equal(deployment.sql('SHOW port'),String(dbPort));assert.equal(await hashFile(autoFile),originalAutoHash);
  await (await signedInActions(deployment))({operation:'database-port',databasePort:nextDatabasePort});
  deployment=await loadWindowsDeployment(installationFile,{allowPreview:true});await deployment.health();
  report.databasePort={status:'passed',realHttpAdminAction:true,realPostgreSqlListener:true,loopbackOnly:true,conflictPreservedApplication:true,credentialsRecordsSettingsImagesPreserved:true,interruptedChangeRestoredExactConfiguration:true,failedDatabaseStartupRecovered:true};
  report.inPlaceBridge={status:"passed",realPriorApplication:true,noUninstall:true,technicalValidation:true,acceptanceThroughHttp:true};
  deployment.sql("UPDATE public.plate_reads SET camera_name='Changed after update' WHERE plate_number='SCMTEST1'; INSERT INTO public.plates(plate_number,occurrence_count) VALUES ('POSTUPDATE',0);");
  await writeFile(settingsFile, "general:\n  maxRecords: 111\n");
  console.log("Rolling back through real SCM stop/start and PostgreSQL restore...");
  const rolledBack = await runWindowsUpdater(["rollback"], {}, { deployment, confirmed: true, allowPreview: true });
  assert.equal(rolledBack.status, "rolled-back");
  deployment = await loadWindowsDeployment(installationFile, { allowPreview: true });
  assert.equal((await deployment.attest()).commit, older.commit);
  assert.equal(deployment.installation.environment.PORT,String(nextPort));
  ps(". "+q(path.join(root,"target-package/host/Network-Helpers.ps1"))+";[void](Get-AlprNetworkRule "+nextPort+")");
  report.applicationPort.portAndFirewallPreservedOnSoftwareRollback=true;
  assert.equal(deployment.installation.environment.DB_HOST,"127.0.0.1:"+nextDatabasePort);assert.equal(deployment.sql("SHOW port"),String(nextDatabasePort));
  report.databasePort.preservedOnSoftwareRollback=true;
  assert.equal(deployment.sql("SELECT camera_name FROM public.plate_reads WHERE plate_number='SCMTEST1';"), "Isolated SCM fixture");
  assert.equal(deployment.sql("SELECT count(*) FROM public.plates WHERE plate_number='POSTUPDATE';"), "0");
  assert.equal(await hashFile(settingsFile), settings);
  assert.equal(JSON.parse(await readFile(authFile, "utf8")).apiKey, auth.apiKey);
  report.upgradeRollback = { status: "passed", realScmStopsAndStarts: true, selectedReleaseListenerAttested: true, changedRowsAndSettingsRestored: true };
  console.log("Real SCM version upgrade and transactional rollback passed.");
  const uninstallRoot = path.join(root, "uninstaller"); await mkdir(uninstallRoot);
  for (const name of ["Uninstall.ps1", "Setup-Helpers.ps1", "Network-Helpers.ps1"]) await writeFile(path.join(uninstallRoot, name), substitute(await readFile(path.join(checkout, "scripts/windows", name), "utf8")));
  ps("$env:ProgramFiles=" + q(programs) + ";$env:ProgramData=" + q(commonData) + ";& " + q(path.join(uninstallRoot, "Uninstall.ps1")));
  assert.equal(ps("@(Get-Service -Name " + q(names.app) + "," + q(names.database) + "," +q(names.updater)+ " -ErrorAction SilentlyContinue).Count"), "0");
  // Equivalent of Inno's code-only [UninstallDelete]; the entire target is
  // generated within this test's recorded root and was previously attested.
  assert.ok(installRoot.startsWith(root + path.sep)); await rm(installRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  assert.equal(await hashFile(settingsFile), settings);
  const reinstall = await installerPackage(target, path.join(root, "reinstall-package"));
  console.log("Reinstalling against retained data and existing credentials...");
  await install(reinstall, true);
  deployment = await loadWindowsDeployment(installationFile, { allowPreview: true });
  await deployment.health(); assert.equal((await deployment.attest()).commit, newer.commit);
  assert.equal(deployment.installation.environment.HOSTNAME, "0.0.0.0");
  assert.equal(deployment.installation.environment.PORT, String(nextPort));
  assert.equal(deployment.installation.environment.DB_HOST,"127.0.0.1:"+nextDatabasePort);assert.equal(deployment.sql("SHOW port"),String(nextDatabasePort));
  report.databasePort.preservedOnRetainedReinstall=true;
  const afterAuth = JSON.parse(await readFile(authFile, "utf8"));
  assert.equal(afterAuth.apiKey, auth.apiKey); assert.equal(afterAuth.password, auth.password);
  assert.equal(await hashFile(settingsFile), settings);
  assert.deepEqual(await fileInventory(path.join(dataRoot, "storage")), images);
  assert.equal(deployment.sql("SELECT count(*) FROM public.plate_reads WHERE plate_number='SCMTEST1';"), "1");
  assert.equal(ps("@(Get-ChildItem -LiteralPath " + q(path.join(dataRoot, "management/reinstall-backups")) + " -Filter verified.json -Recurse).Count"), "1");
  report.retainedReinstall = { status: "passed", databaseRowPreserved: true, passwordAndApiKeyPreserved: true, settingsAndImageChecksumsPreserved: true, coldClusterBackupVerified: true, networkPreferenceAndPortsPreserved: true };
  // No published older application understands the new Windows UI protocol.
  // Exercise the browser download path with a higher-version package fixture
  // using the exact target application and modules. Only package.json/version
  // and the private fixture manifest change; this is not a published release.
  const uiCandidate=await installerPackage(target,path.join(root,"ui-target-package"));
  const uiManifest=JSON.parse(await readFile(path.join(uiCandidate,"windows-package.json"),"utf8"));
  const parts=newer.version.split(".").map(Number);parts[2]++;
  uiManifest.version=parts.join(".");uiManifest.channel="stable";
  const appMetadataFile=path.join(uiCandidate,"app/package.json");
  const appMetadata=JSON.parse(await readFile(appMetadataFile,"utf8"));appMetadata.version=uiManifest.version;
  await writeFile(appMetadataFile,JSON.stringify(appMetadata));uiManifest.files["app/package.json"]=await hashFile(appMetadataFile);
  await writeFile(path.join(uiCandidate,"windows-package.json"),JSON.stringify(uiManifest));
  await verifyWindowsPackage(uiCandidate);
  const releaseEvidence=await installFixtureReleaseSource(uiCandidate);
  const action=await signedInActions(deployment);
  const checked=await action({operation:"check"});assert.equal(checked.targetTag,"v"+uiManifest.version);
  const updated=await action({operation:"update",target:"v"+uiManifest.version,confirmation:"INSTALL v"+uiManifest.version});
  assert.equal(updated.updaterStatus,"ready-for-acceptance");
  deployment=await loadWindowsDeployment(installationFile,{allowPreview:true});
  assert.equal((await deployment.attest()).commit,newer.commit);
  const uiActions=await signedInActions(deployment);
  assert.equal((await uiActions({operation:"accept",confirmation:"I COMPLETED THE MANUAL CHECKS"})).updaterStatus,"accepted");
  report.browserUpdate={status:"passed",realHttpAdminActions:true,separateUpdaterService:true,automaticBackup:true,technicalValidation:true,acceptance:true,syntheticFutureVersion:uiManifest.version,applicationSourceCommit:newer.commit,...releaseEvidence};
  assert.equal((await uiActions({operation:"rollback",confirmation:"ROLL BACK AND DISCARD NEW WRITES"})).updaterStatus,"rolled-back");
  deployment=await loadWindowsDeployment(installationFile,{allowPreview:true});
  assert.equal(deployment.installation.environment.DB_HOST,"127.0.0.1:"+nextDatabasePort);assert.equal(deployment.sql("SHOW port"),String(nextDatabasePort));
  report.databasePort.preservedOnBrowserUpdateAndRollback=true;
  report.status = "passed"; console.log("Uninstall and retained-data reinstall passed actual SCM and protected service accounts.");
} catch (error) {
  report.status = "failed"; report.error = error.stack?.slice(-12000); console.error(report.error); process.exitCode = 1;
  try {
    const record = JSON.parse(await readFile(installationFile, "utf8"));
    report.serviceLogs = {};
    for (const suffix of ["err.log", "out.log", "wrapper.log"]) {
      let text = await readFile(path.join(dataRoot, "logs", names.app + "." + suffix), "utf8").catch(() => "");
      for (const secret of [record.environment.DB_PASSWORD, record.environment.ADMIN_PASSWORD]) if (secret) text = text.replaceAll(secret, "[fixture credential]");
      report.serviceLogs[suffix] = text.slice(-10000);
    }
  } catch { /* a pre-install refusal has no owned service logs */ }
} finally {
  try {
    // Never target an arbitrary service by name alone. Both exact executable
    // roots must belong to the UUID fixture before stopping or deleting it.
    ps("foreach($name in @(" + q(names.updater)+","+q(names.app) + "," + q(names.database) + ")){$s=Get-CimInstance Win32_Service -Filter (\"Name='\"+$name+\"'\");if($s){if($s.PathName -notlike " + q('*' + installRoot + '*') + "){throw 'Foreign service ownership; refusing cleanup'};Stop-Service -Name $name -ErrorAction Stop;& $env:SystemRoot\\System32\\sc.exe delete $name;if($LASTEXITCODE){throw 'SCM cleanup failed'}}}");
    const record=JSON.parse(await readFile(installationFile,"utf8"));
    const cleanupPort=Number(record.environment.PORT);assert.ok(Number.isInteger(cleanupPort)&&cleanupPort>=1024&&cleanupPort<=65535);
    ps(". " + q(path.join(root, "initial-package/host/Network-Helpers.ps1")) + ";Remove-AlprNetworkRule " + cleanupPort);
    report.cleanup = "owned test services removed";
  } catch (error) { report.cleanup = "preserved for diagnosis: " + error.message; process.exitCode = 1; }
  report.completedAt = new Date().toISOString(); await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  if (report.status === "passed" && report.cleanup === "owned test services removed") {
    assert.equal(path.dirname(root), path.join(process.env.ProgramData, "ALPR SCM Acceptance"));
    assert.match(path.basename(root), /^[a-f0-9]{32}$/); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } else { console.error("Owned test files preserved at " + root); }
}
