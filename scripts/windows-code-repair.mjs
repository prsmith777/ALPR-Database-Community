import { cp, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson, assertRealDirectory, loadWindowsDeployment } from "./windows-deployment.mjs";
import { hashFile, verifyWindowsPackage } from "./windows-native-package.mjs";

// A supervised preview repair replaces application code only. It never runs
// migrations, restores a database, changes credentials, or accepts an update.
export async function repairWindowsCode({ packageRoot, manifestSha256, fromCommit }, env = process.env, options = {}) {
  if (!options.confirmed && env.ALPR_CODE_REPAIR !== "ALPR_CODE_REPAIR_APPROVED") {
    throw new Error("Code repair requires ALPR_CODE_REPAIR=ALPR_CODE_REPAIR_APPROVED");
  }
  if (!packageRoot || !/^[0-9a-f]{64}$/.test(manifestSha256 || "") || !/^[0-9a-f]{40}$/.test(fromCommit || "")) {
    throw new Error("Code repair requires its trusted package checksum and exact source commit");
  }
  if (await hashFile(path.join(packageRoot,"windows-package.json")) !== manifestSha256) {
    throw new Error("Repair package does not match the trusted checksum");
  }
  const target = await verifyWindowsPackage(packageRoot,{allowPreview:true});
  const deployment = options.deployment || await loadWindowsDeployment(env.ALPR_WINDOWS_INSTALLATION,{allowPreview:true});
  if (deployment.current.commit !== fromCommit || deployment.current.channel !== "preview" || target.channel !== "preview" ||
      target.version !== deployment.current.version || target.commit === fromCommit) {
    throw new Error("This repair applies only to its exact installed Community preview");
  }
  for (const file of ["schema.sql","migrations.sql"]) {
    if (target.files[file] !== deployment.current.files[file]) throw new Error("Code repair cannot change the database schema or migrations");
  }
  await mkdir(deployment.backupRoot,{recursive:true});
  await assertRealDirectory(deployment.backupRoot);
  const lockPath = path.join(deployment.backupRoot,"maintenance.lock");
  const lock = await open(lockPath,"wx").catch((error) => {
    if (error.code === "EEXIST") throw new Error("Another native maintenance operation is in progress");
    throw error;
  });
  let stopped = false, record, recordFile;
  try {
    // Avoid interfering with an update awaiting manual acceptance or rollback.
    const update = await readFile(path.join(deployment.backupRoot,"updater-state.json"),"utf8")
      .then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (update && !["accepted","rolled-back"].includes(update.status)) throw new Error("Finish the pending update before repairing application code");
    const running = await deployment.attest();
    if (running.current !== deployment.installation.current || running.commit !== fromCommit ||
        !running.listenerOwned || running.status !== "Running") throw new Error("Installed service identity does not match this repair");
    const staged = await deployment.stage(packageRoot);
    const expectedName = target.version + "-" + target.commit.slice(0,12);
    if (staged.name !== expectedName || path.resolve(staged.path) !== path.join(deployment.releaseRoot,expectedName)) {
      throw new Error("Repair staging destination does not belong to this installation");
    }
    // Recheck the staged files before selecting them, including fixture stages.
    await verifyWindowsPackage(staged.path,{allowPreview:true});
    if (await hashFile(path.join(staged.path,"windows-package.json")) !== manifestSha256) throw new Error("Staged repair checksum mismatch");
    const backup = path.join(deployment.backupRoot,"code-repair-" + Date.now() + "-" + target.commit.slice(0,12));
    await mkdir(backup);
    await cp(deployment.installationFile,path.join(backup,"installation.json"));
    recordFile = path.join(backup,"repair.json");
    record = {formatVersion:1,status:"prepared",from:fromCommit,to:target.commit,previousRelease:deployment.installation.current,targetRelease:staged.name};
    await atomicJson(recordFile,record);
    stopped = true;
    deployment.service("stop");
    await deployment.switchRelease(staged.name);
    deployment.service("start");
    await deployment.health();
    const repaired = await deployment.attest();
    if (repaired.current !== staged.name || repaired.commit !== target.commit || !repaired.listenerOwned || repaired.status !== "Running") {
      throw new Error("Repaired application did not own the expected service listener");
    }
    record.status = "repaired";
    record.completedAt = new Date().toISOString();
    await atomicJson(recordFile,record);
    return {status:"repaired",commit:target.commit};
  } catch (error) {
    if (stopped) {
      try {
        deployment.service("stop");
        await atomicJson(deployment.installationFile,deployment.installation);
        deployment.service("start");
        await deployment.health();
        const previous = await deployment.attest();
        if (previous.current !== deployment.installation.current || previous.commit !== fromCommit || !previous.listenerOwned || previous.status !== "Running") {
          throw new Error("Previous application listener was not restored");
        }
        record.status = "previous-code-restored";
      } catch {
        record.status = "recovery-required";
      }
      await atomicJson(recordFile,record);
      throw new Error(record.status === "previous-code-restored"
        ? "Repair failed; the previous application was restored. " + error.message
        : "Repair failed and the previous application could not restart. Contact the maintainer; all data and releases have been retained.");
    }
    throw error;
  } finally {
    await lock.close();
    await rm(lockPath,{force:true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [packageRoot,manifestSha256,fromCommit,...extra] = process.argv.slice(2);
  if (extra.length) throw new Error("Unexpected code repair arguments");
  repairWindowsCode({packageRoot,manifestSha256,fromCommit}).then(() => console.log("ALPR_SETUP_PROGRESS:Settings repair completed. Your existing password and data are preserved."))
    .catch((error) => {console.error("ALPR_SETUP_ERROR:" + error.message);process.exitCode=1;});
}
