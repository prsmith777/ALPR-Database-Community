import { cp, lstat, mkdir, open, readFile, readdir, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson, assertPreservedFiles, assertRealDirectory, fileInventory, loadWindowsDeployment } from "./windows-deployment.mjs";
import { hashFile, verifyWindowsPackage } from "./windows-native-package.mjs";
import { compareMinimumCounts } from "./native-reid-upgrade-policy.mjs";

const ACKS = Object.freeze({ update: "ALPR_UPDATE_APPROVED", accept: "ALPR_UPDATE_ACCEPTED", rollback: "ALPR_UPDATE_ROLLBACK", cleanup: "ALPR_UPDATE_CLEANUP" });
const ACK_ENV = Object.freeze({ update: "ALPR_UPDATE_ACKNOWLEDGE", accept: "ALPR_UPDATE_ACCEPTANCE", rollback: "ALPR_UPDATE_ROLLBACK", cleanup: "ALPR_UPDATE_CLEANUP" });
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function compareVersions(a, b) {
  if (!TAG.test(a) || !TAG.test(b)) throw new Error("Use exact stable version tags");
  const left = a.slice(1).split(".").map(Number), right = b.slice(1).split(".").map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}
function confirm(command, environment, confirmed) {
  if (ACKS[command] && !confirmed && environment[ACK_ENV[command]] !== ACKS[command]) {
    throw new Error("Requires " + ACK_ENV[command] + "=" + ACKS[command]);
  }
}
async function readState(deployment) {
  try { return JSON.parse(await readFile(path.join(deployment.backupRoot, "updater-state.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function saveState(deployment, state) {
  await atomicJson(path.join(deployment.backupRoot, "updater-state.json"), state);
  deployment.updateProgress?.(state.status);
}
function ownedBackup(deployment, state) {
  const name = state?.backup?.id;
  if (!/^\d{13}-[0-9a-f]{12}$/.test(name || "")) throw new Error("Invalid backup ownership record");
  return path.join(deployment.backupRoot, name);
}
async function verifyBackup(deployment, state) {
  const backup = ownedBackup(deployment, state);
  await assertRealDirectory(backup);
  if (await hashFile(path.join(backup, "postgres.dump")) !== state.backup.dumpSha256) throw new Error("Rollback dump checksum mismatch");
  for (const name of ["auth", "config"]) {
    const inventory = await fileInventory(path.join(backup, name));
    assertPreservedFiles(state.backup.privateFiles[name], inventory);
    if (Object.keys(inventory).length !== Object.keys(state.backup.privateFiles[name]).length) throw new Error("Rollback private file inventory mismatch");
  }
  if (await hashFile(path.join(backup, "installation.json")) !== state.backup.installationSha256) throw new Error("Rollback configuration checksum mismatch");
  return backup;
}
async function verifyRunningRelease(deployment, name, commit) {
  const health = await deployment.health();
  const running = await deployment.attest();
  if (running.current !== name || running.commit !== commit ||
      running.listenerOwned !== true || running.status !== "Running") {
    throw new Error("Running Windows service does not own the target release listener");
  }
  return { health, running };
}
async function validate(deployment, state) {
  if (!["validating","validation-failed","ready-for-acceptance"].includes(state?.status)) throw new Error("No update is ready to validate");
  try {
    await verifyBackup(deployment, state);
    const installed = JSON.parse(await readFile(deployment.installationFile, "utf8"));
    if (installed.current !== state.target.name) throw new Error("Active release differs from update target");
    const manifest = await verifyWindowsPackage(path.join(deployment.releaseRoot, installed.current), { allowPreview: state.target.channel === "preview" });
    if (manifest.commit !== state.target.commit) throw new Error("Active release commit differs from update target");
    const counts = await deployment.counts();
    if (compareMinimumCounts(state.backup.counts, counts).length) throw new Error("Database row counts decreased after update");
    assertPreservedFiles(state.backup.storage, await fileInventory(path.join(deployment.data, "storage")));
    const { health, running } = await verifyRunningRelease(deployment, state.target.name, state.target.commit);
    state.validation = { health, running, completedAt: new Date().toISOString(), counts };
    state.status = "ready-for-acceptance";
    delete state.lastFailure;
    await saveState(deployment, state);
    return state;
  } catch (error) {
    state.status = "validation-failed";
    state.lastFailure = { phase: "validation", code: "validation-failed" };
    await saveState(deployment, state);
    throw error;
  }
}
async function update(deployment, state, packageRoot, expectedManifestSha, options = {}) {
  if (state && !["accepted","rolled-back"].includes(state.status)) throw new Error("An update is already " + state.status + "; validate or roll back first");
  if (state?.backup && !state.backup.cleanedAt) {
    if (!options.retainPrevious) throw new Error("Clean the previous rollback generation before installing another update");
    await verifyBackup(deployment, state);
    // Keep accepted generations intact when another release arrives during
    // their retention window. Only the latest generation is offered as rollback.
    const history = path.join(deployment.backupRoot, `history-${state.backup.id}.json`);
    try { await writeFile(history, JSON.stringify(state, null, 2) + "\n", { flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST" || JSON.stringify(JSON.parse(await readFile(history,"utf8"))) !== JSON.stringify(state)) throw error;
    }
  }
  if (!packageRoot || !/^[0-9a-f]{64}$/.test(expectedManifestSha || "")) throw new Error("Native updates require --package and its trusted --manifest-sha256");
  if (await hashFile(path.join(packageRoot, "windows-package.json")) !== expectedManifestSha) throw new Error("Update manifest does not match the trusted checksum");
  const manifest = await verifyWindowsPackage(packageRoot, { allowPreview: options.allowPreview });
  if (compareVersions("v" + manifest.version, "v" + deployment.current.version) <= 0) throw new Error("Update target must be a newer version");
  // Stage and probe native dependencies before stopping the existing application.
  deployment.updateProgress?.("preparing");
  const staged = await deployment.stage(packageRoot);
  const disk = await statfs(deployment.backupRoot, { bigint: true });
  const databaseBytes = BigInt(deployment.sql("SELECT pg_database_size(current_database());"));
  if (disk.bavail * disk.bsize < databaseBytes + 512n * 1024n * 1024n) throw new Error("Insufficient rollback backup space");
  const id = String(Date.now()) + "-" + manifest.commit.slice(0,12);
  const backup = path.join(deployment.backupRoot, id);
  await mkdir(backup);
  state = {
    formatVersion: 1, profile: "windows-native", status: "backing-up",
    current: { tag: "v" + deployment.current.version, commit: deployment.current.commit, name: deployment.installation.current },
    target: { tag: "v" + manifest.version, version: manifest.version, commit: manifest.commit, channel: manifest.channel, name: staged.name },
    backup: { id }, createdAt: new Date().toISOString(),
  };
  await saveState(deployment, state);
  let migrationStarted = false, backupComplete = false;
  try {
    deployment.service("stop");
    state.backup.counts = await deployment.counts();
    state.backup.storage = await fileInventory(path.join(deployment.data, "storage"));
    state.backup.privateFiles = {};
    for (const name of ["auth","config"]) {
      await cp(path.join(deployment.data, name), path.join(backup, name), { recursive: true });
      state.backup.privateFiles[name] = await fileInventory(path.join(backup, name));
    }
    await cp(deployment.installationFile, path.join(backup, "installation.json"));
    state.backup.installationSha256 = await hashFile(path.join(backup, "installation.json"));
    deployment.pg("pg_dump", ["--format=custom","--compress=9","--no-owner","--no-privileges","--file",path.join(backup,"postgres.dump")]);
    const dumpSha256 = await hashFile(path.join(backup, "postgres.dump"));
    deployment.run(path.join(deployment.installation.pgBin, "pg_restore.exe"), ["--list", path.join(backup,"postgres.dump")]);
    state.backup.dumpSha256 = dumpSha256;
    backupComplete = true;
    state.status = "backed-up";
    await saveState(deployment, state);
    state.status = "applying";
    await saveState(deployment, state);
    migrationStarted = true;
    deployment.migrate(staged.path);
    await deployment.switchRelease(staged.name);
    deployment.service("start");
    state.status = "validating";
    await saveState(deployment, state);
    return await validate(deployment, state);
  } catch (error) {
    if (state.status !== "validation-failed") state.status = backupComplete ? "apply-failed" : "backup-failed";
    state.lastFailure = { phase: backupComplete ? "apply" : "backup", code: "native-update-failed" };
    if (!migrationStarted) {
      try {
        deployment.service("start");
        state.recovery = { previousApplicationRestored: true };
        state.status = backupComplete ? "rolled-back" : "backup-failed";
      } catch { state.recovery = { previousApplicationRestored: false }; }
    }
    await saveState(deployment, state);
    if (options.automaticRecovery && backupComplete && migrationStarted) {
      try {
        state = await rollback(deployment, state);
        state.recovery = { previousApplicationRestored: true, automatic: true };
        await saveState(deployment, state);
      } catch {
        state.recovery = { previousApplicationRestored: false, automatic: true };
        await saveState(deployment, state);
      }
    }
    throw error;
  }
}
async function restorePrivateDirectory(source, destination) {
  // Preserve the installed NTFS ACL on the directory. The complete inventory
  // check rejects junctions before clearing any state-owned child.
  await fileInventory(destination);
  for (const name of await readdir(destination)) await rm(path.join(destination, name), { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
}
async function rollback(deployment, state) {
  if (!["backed-up","applying","apply-failed","validating","validation-failed","ready-for-acceptance","accepted","rolling-back","rollback-failed"].includes(state?.status) ||
      state.backup.cleanedAt) throw new Error("No verified update is eligible for rollback");
  const backup = await verifyBackup(deployment, state);
  if (!/^\d+\.\d+\.\d+-[0-9a-f]{12}$/.test(state.current.name)) throw new Error("Invalid previous release");
  const manifest = await verifyWindowsPackage(path.join(deployment.releaseRoot, state.current.name), { allowPreview: true });
  if (manifest.commit !== state.current.commit) throw new Error("Previous release commit mismatch");
  state.status = "rolling-back";
  await saveState(deployment, state);
  try {
    deployment.service("stop");
    // Render pg_restore SQL, then replace the schema and replay it in one
    // transaction. A failure leaves the pre-rollback database intact.
    const restore = path.join(backup, "restore.sql");
    const transaction = path.join(backup, "restore-transaction.sql");
    deployment.run(path.join(deployment.installation.pgBin, "pg_restore.exe"), [
      "--no-owner","--no-privileges","--file",restore,path.join(backup,"postgres.dump"),
    ]);
    await writeRestoreTransaction(restore, transaction);
    deployment.pg("psql", ["--no-psqlrc","--set","ON_ERROR_STOP=1","--single-transaction","--file",transaction]);
    for (const name of ["auth","config"]) await restorePrivateDirectory(path.join(backup,name), path.join(deployment.data,name));
    const restoredInstallation = JSON.parse(await readFile(path.join(backup, "installation.json"), "utf8"));
    if (restoredInstallation.installRoot !== deployment.root || restoredInstallation.dataRoot !== deployment.data ||
        restoredInstallation.current !== state.current.name) throw new Error("Rollback installation belongs to a different native instance");
    await atomicJson(deployment.installationFile, restoredInstallation);
    const counts = await deployment.counts();
    if (JSON.stringify(Object.entries(counts).sort()) !== JSON.stringify(Object.entries(state.backup.counts).sort())) throw new Error("Restored row counts differ from rollback snapshot");
    // Verify exact restoration before restarting workers that may legitimately
    // append derived rows or audit events.
    assertPreservedFiles(state.backup.storage, await fileInventory(path.join(deployment.data,"storage")));
    deployment.service("start");
    await verifyRunningRelease(deployment, state.current.name, state.current.commit);
    state.status = "rolled-back";
    state.rollback = { restoredTag: state.current.tag, completedAt: new Date().toISOString() };
    await saveState(deployment, state);
    return state;
  } catch (error) {
    state.status = "rollback-failed";
    state.lastFailure = { phase: "rollback", code: "native-rollback-failed" };
    await saveState(deployment, state);
    throw error;
  }
}
async function writeRestoreTransaction(source, destination) {
  const { createReadStream, createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const header = "SET client_min_messages = warning;\nDROP SCHEMA public CASCADE;\nCREATE SCHEMA public AUTHORIZATION pg_database_owner;\nGRANT ALL ON SCHEMA public TO pg_database_owner;\nGRANT USAGE ON SCHEMA public TO PUBLIC;\n";
  await writeFile(destination, header);
  await pipeline(createReadStream(source), createWriteStream(destination, { flags: "a" }));
}
export async function runWindowsUpdater(argumentsList = process.argv.slice(2), environment = process.env, options = {}) {
  options = { ...options, allowPreview: options.allowPreview === true || environment.ALPR_WINDOWS_PREVIEW === "ALPR_WINDOWS_PREVIEW_APPROVED" };
  const [command = "status", ...args] = argumentsList;
  if (!["check","status","update","validate","accept","rollback","cleanup"].includes(command) && !(command === "recover" && options.internalRecovery)) throw new Error("Unsupported native maintenance operation");
  let packageRoot, manifestSha;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!value) throw new Error("Missing value for " + flag);
    if (flag === "--package" && command === "update") packageRoot = path.resolve(value);
    else if (flag === "--manifest-sha256" && command === "update") manifestSha = value;
    else throw new Error("Unknown native maintenance option: " + flag);
  }
  confirm(command, environment, options.confirmed);
  const deployment = options.deployment || await loadWindowsDeployment(environment.ALPR_WINDOWS_INSTALLATION, options);
  deployment.updateProgress = options.progress;
  await mkdir(deployment.backupRoot, { recursive: true });
  await assertRealDirectory(deployment.backupRoot);
  const lockPath = path.join(deployment.backupRoot, "maintenance.lock");
  let lock;
  try { lock=await open(lockPath,"wx"); }
  catch(error) {
    if(error.code !== "EEXIST")throw error;
    if(!options.internalRecovery)throw new Error("Native maintenance lock exists; verify no maintenance process is running before removing it");
    const oldPid=(await readFile(lockPath,"utf8")).trim();
    if(!/^[1-9]\d{0,9}$/.test(oldPid))throw new Error("An unrecognized maintenance lock requires administrator recovery");
    try {process.kill(Number(oldPid),0);throw new Error("A native maintenance process is still running");}
    catch(probe){if(probe.code !== "ESRCH")throw probe;}
    await rm(lockPath);lock=await open(lockPath,"wx");
  }
  await lock.writeFile(String(process.pid));
  try {
    const state = await readState(deployment);
    if(command === "recover") {
      if(!state || ["accepted","rolled-back","ready-for-acceptance"].includes(state.status)) {
        deployment.service("start");
        await verifyRunningRelease(deployment,deployment.installation.current,deployment.current.commit);
        return state || {status:"no-update-recorded"};
      }
      if(["backing-up","backup-failed"].includes(state.status) && !state.backup.dumpSha256) {
        if(deployment.installation.current !== state.current.name)throw new Error("Interrupted backup selected a different release");
        deployment.service("start");await verifyRunningRelease(deployment,state.current.name,state.current.commit);
        await assertRealDirectory(ownedBackup(deployment,state));
        await rm(ownedBackup(deployment,state),{recursive:true});
        state.backup.cleanedAt=new Date().toISOString();state.status="rolled-back";
      } else {await rollback(deployment,state);}
      state.recovery={previousApplicationRestored:true,automatic:true,interrupted:true};
      await saveState(deployment,state);return state;
    }
    if (command === "status") return state || { status: "no-update-recorded" };
    if (command === "check") return { current: { tag: "v" + deployment.current.version, commit: deployment.current.commit }, target: null, message: "Use Settings > Software Updates to check published Windows releases. Local maintenance requires a verified package and its manifest checksum." };
    if (command === "update") return await update(deployment, state, packageRoot, manifestSha, options);
    if (command === "validate") return await validate(deployment, state);
    if (command === "rollback") return await rollback(deployment, state);
    if (command === "accept") {
      if (state?.status !== "ready-for-acceptance") throw new Error("Technical checks must pass before acceptance");
      await validate(deployment, state);
      state.status = "accepted";
      state.acceptance = { acceptedAt: new Date().toISOString(), cleanupEligibleAt: new Date(Date.now() + 14 * 86400000).toISOString(), manualChecksConfirmed: true };
      await saveState(deployment, state);
      return state;
    }
    if (state?.status === "backup-failed") {
      if (state.backup.dumpSha256) throw new Error("A verified dump requires explicit recovery");
      if (!state.recovery?.previousApplicationRestored) throw new Error("Recover the existing application before cleaning an incomplete backup");
      await assertRealDirectory(ownedBackup(deployment, state));
      await rm(ownedBackup(deployment, state), { recursive: true });
      state.status = "rolled-back";
    } else {
      if (!["accepted","rolled-back"].includes(state?.status) || state.backup.cleanedAt) throw new Error("No completed update has cleanup artifacts");
      if (state.status === "accepted" && Date.now() < Date.parse(state.acceptance.cleanupEligibleAt)) throw new Error("Rollback retention period has not expired");
      await verifyBackup(deployment, state);
      await rm(ownedBackup(deployment, state), { recursive: true });
    }
    state.backup.cleanedAt = new Date().toISOString();
    await saveState(deployment, state);
    return state;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
export const windowsMaintenanceInternals = Object.freeze({ compareVersions, confirm, ownedBackup, update, validate, rollback });
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWindowsUpdater().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error("Native maintenance stopped: " + error.message); process.exitCode = 1;
  });
}
