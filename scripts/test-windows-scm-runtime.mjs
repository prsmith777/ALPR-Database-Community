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
const names = { app: "ALPRTestApp" + id, database: "ALPRTestDatabase" + id };
const root = path.join(process.env.ProgramData, "ALPR SCM Acceptance", id);
const programs = path.join(root, "programs"), commonData = path.join(root, "data");
const installRoot = path.join(programs, "ALPR Community"), dataRoot = path.join(commonData, "ALPR Community");
const installationFile = path.join(installRoot, "installation.json");
const report = { startedAt: new Date().toISOString(), scope: "Isolated service names, roots and loopback ports; working ALPR services and data are never targeted", boundary: "Real Windows SCM, WinSW, LocalService/NetworkService, service SID ACLs and production service-controller logic", status: "running" };
const substitute = text => text.replaceAll("ALPRCommunityApp", names.app).replaceAll("ALPRCommunityDatabase", names.database);
async function freePort() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function installerPackage(source, folder) {
  await cp(source, folder, { recursive: true, errorOnExist: true, force: false });
  for (const name of ["Install.ps1", "Setup-Helpers.ps1", "Network-Helpers.ps1", "Service-Control.ps1"]) {
    const destination = name === "Install.ps1" ? path.join(folder, name) : path.join(folder, "host", name);
    await writeFile(destination, substitute(await readFile(path.join(checkout, "scripts/windows", name), "utf8")));
  }
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
let deployment;
try {
  ps(". " + q(path.join(checkout, "scripts/windows/Setup-Helpers.ps1")) + ";Protect-SetupDirectory " + q(root));
  const older = await verifyWindowsPackage(previous, { allowPreview: true });
  const newer = await verifyWindowsPackage(target, { allowPreview: true });
  assert.notEqual(older.version, newer.version, "Use distinct real release versions for the update test");
  report.packages = { from: { version: older.version, commit: older.commit }, to: { version: newer.version, commit: newer.commit } };
  const initial = await installerPackage(previous, path.join(root, "initial-package"));
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
  await fetch("http://127.0.0.1:" + appPort + "/api/verify-session", { method: "POST", headers: { "content-type": "application/json" }, body: '{"sessionId":"invalid"}' });
  const authFile = path.join(dataRoot, "auth/auth.json"), settingsFile = path.join(dataRoot, "config/settings.yaml");
  const auth = JSON.parse(await readFile(authFile, "utf8")), settings = await hashFile(settingsFile), images = await fileInventory(path.join(dataRoot, "storage"));
  const updated = await runWindowsUpdater(["update", "--package", target, "--manifest-sha256", await hashFile(path.join(target, "windows-package.json"))], {}, { deployment, confirmed: true, allowPreview: true });
  assert.equal(updated.status, "ready-for-acceptance");
  deployment = await loadWindowsDeployment(installationFile, { allowPreview: true });
  assert.equal((await deployment.attest()).commit, newer.commit);
  deployment.sql("UPDATE public.plate_reads SET camera_name='Changed after update' WHERE plate_number='SCMTEST1'; INSERT INTO public.plates(plate_number,occurrence_count) VALUES ('AFTERUPDATE',0);");
  await writeFile(settingsFile, "general:\n  maxRecords: 111\n");
  const rolledBack = await runWindowsUpdater(["rollback"], {}, { deployment, confirmed: true, allowPreview: true });
  assert.equal(rolledBack.status, "rolled-back");
  deployment = await loadWindowsDeployment(installationFile, { allowPreview: true });
  assert.equal((await deployment.attest()).commit, older.commit);
  assert.equal(deployment.sql("SELECT camera_name FROM public.plate_reads WHERE plate_number='SCMTEST1';"), "Isolated SCM fixture");
  assert.equal(deployment.sql("SELECT count(*) FROM public.plates WHERE plate_number='AFTERUPDATE';"), "0");
  assert.equal(await hashFile(settingsFile), settings);
  assert.equal(JSON.parse(await readFile(authFile, "utf8")).apiKey, auth.apiKey);
  report.upgradeRollback = { status: "passed", realScmStopsAndStarts: true, selectedReleaseListenerAttested: true, changedRowsAndSettingsRestored: true };
  console.log("Real SCM version upgrade and transactional rollback passed.");
  const uninstallRoot = path.join(root, "uninstaller"); await mkdir(uninstallRoot);
  for (const name of ["Uninstall.ps1", "Setup-Helpers.ps1", "Network-Helpers.ps1"]) await writeFile(path.join(uninstallRoot, name), substitute(await readFile(path.join(checkout, "scripts/windows", name), "utf8")));
  ps("$env:ProgramFiles=" + q(programs) + ";$env:ProgramData=" + q(commonData) + ";& " + q(path.join(uninstallRoot, "Uninstall.ps1")));
  assert.equal(ps("@(Get-Service -Name " + q(names.app) + "," + q(names.database) + " -ErrorAction SilentlyContinue).Count"), "0");
  // Equivalent of Inno's code-only [UninstallDelete]; the entire target is
  // generated within this test's recorded root and was previously attested.
  assert.ok(installRoot.startsWith(root + path.sep)); await rm(installRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  assert.equal(await hashFile(settingsFile), settings);
  const reinstall = await installerPackage(target, path.join(root, "reinstall-package"));
  await install(reinstall, true);
  deployment = await loadWindowsDeployment(installationFile, { allowPreview: true });
  await deployment.health(); assert.equal((await deployment.attest()).commit, newer.commit);
  assert.equal(deployment.installation.environment.HOSTNAME, "0.0.0.0");
  assert.equal(deployment.installation.environment.PORT, String(appPort));
  const afterAuth = JSON.parse(await readFile(authFile, "utf8"));
  assert.equal(afterAuth.apiKey, auth.apiKey); assert.equal(afterAuth.password, auth.password);
  assert.equal(await hashFile(settingsFile), settings);
  assert.deepEqual(await fileInventory(path.join(dataRoot, "storage")), images);
  assert.equal(deployment.sql("SELECT count(*) FROM public.plate_reads WHERE plate_number='SCMTEST1';"), "1");
  assert.equal(ps("@(Get-ChildItem -LiteralPath " + q(path.join(dataRoot, "management/reinstall-backups")) + " -Filter verified.json -Recurse).Count"), "1");
  report.retainedReinstall = { status: "passed", databaseRowPreserved: true, passwordAndApiKeyPreserved: true, settingsAndImageChecksumsPreserved: true, coldClusterBackupVerified: true, networkPreferenceAndPortsPreserved: true };
  report.status = "passed"; console.log("Uninstall and retained-data reinstall passed actual SCM and protected service accounts.");
} catch (error) {
  report.status = "failed"; report.error = error.stack; console.error(error.stack); process.exitCode = 1;
} finally {
  try {
    // Never target an arbitrary service by name alone. Both exact executable
    // roots must belong to the UUID fixture before stopping or deleting it.
    ps("foreach($name in @(" + q(names.app) + "," + q(names.database) + ")){$s=Get-CimInstance Win32_Service -Filter (\"Name='\"+$name+\"'\");if($s){if($s.PathName -notlike " + q('*' + installRoot + '*') + "){throw 'Foreign service ownership; refusing cleanup'};Stop-Service -Name $name -ErrorAction Stop;& $env:SystemRoot\\System32\\sc.exe delete $name;if($LASTEXITCODE){throw 'SCM cleanup failed'}}}");
    ps(". " + q(path.join(root, "initial-package/host/Network-Helpers.ps1")) + ";Remove-AlprNetworkRule " + appPort);
    report.cleanup = "owned test services removed";
  } catch (error) { report.cleanup = "preserved for diagnosis: " + error.message; process.exitCode = 1; }
  report.completedAt = new Date().toISOString(); await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  if (report.status === "passed" && report.cleanup === "owned test services removed") {
    assert.equal(path.dirname(root), path.join(process.env.ProgramData, "ALPR SCM Acceptance"));
    assert.match(path.basename(root), /^[a-f0-9]{32}$/); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } else { console.error("Owned test files preserved at " + root); }
}
