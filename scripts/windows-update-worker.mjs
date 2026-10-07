import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateCommunityUpdateRequest } from "../lib/community-update-control.mjs";
import { loadWindowsDeployment, assertRealDirectory } from "./windows-deployment.mjs";
import { runWindowsUpdater } from "./windows-maintenance.mjs";
import { findWindowsUpdate, downloadWindowsUpdate } from "./windows-update-release.mjs";
import { waitForWindowsDatabase } from "./windows-service-startup.mjs";

const PHASES = Object.freeze({ preparing: "Checking the Windows runtime and AI models before stopping ALPR.",
  "backing-up": "Pausing ALPR and creating its recovery backup.", "backed-up": "Recovery backup verified.",
  applying: "Installing the update and migrating the database.", validating: "ALPR is restarting. Checking the installed release and preserved data.",
  "ready-for-acceptance": "Technical checks passed. Complete the real-use checks below.",
  "rolling-back": "Restoring the previous release and database.", "rolled-back": "The previous release was restored.",
  "rollback-failed": "Automatic recovery needs administrator assistance. Preserve all ALPR data.",
  "apply-failed": "The update failed. Checking recovery options.", "validation-failed": "Technical checks failed. Checking recovery options.",
  "backup-failed": "The recovery backup could not be completed.", accepted: "The update was accepted." });

export function windowsUpdateSummary(operation, state, candidate = null, current = null) {
  const unfinished = state && !["accepted","rolled-back","no-update-recorded"].includes(state.status);
  return {
    currentTag: current?.tag || state?.current?.tag || null,
    targetTag: operation === "check" ? candidate?.tag || null : state?.target?.tag || null,
    activeUpdateTag: state?.target?.tag || null,
    updaterStatus: state?.status === "no-update-recorded" ? (candidate ? "update-available" : "current") : state?.status || (candidate ? "update-available" : "current"),
    rollbackPresent: Boolean(state?.backup?.dumpSha256 && !state.backup.cleanedAt),
    rollbackEligibleUntil: state?.acceptance?.cleanupEligibleAt || null,
    message: operation === "check" ? unfinished ? "Finish or recover the current update before installing another release."
      : candidate ? `Update ${candidate.tag} is available.` : `${current?.tag || "The installed release"} is current.`
      : operation === "cleanup" ? "The eligible rollback copy was removed."
      : PHASES[state?.status] || "The requested Windows update operation completed.",
  };
}
export async function performWindowsUpdateRequest(input, environment = process.env, options = {}) {
  const request = validateCommunityUpdateRequest(input, { requireIdentity: true });
  const age = Date.now() - Date.parse(request.createdAt);
  if (input.formatVersion !== 1 || age < -30_000 || age > 5 * 60_000) throw new Error("Windows update request is unsupported or expired");
  const deployment = options.deployment || await loadWindowsDeployment(environment.ALPR_WINDOWS_INSTALLATION, {allowPreview:true});
  const current = { tag: `v${deployment.current.version}`, commit: deployment.current.commit };
  const progress = (value) => options.progress?.(PHASES[value] || value);
  const run = (args, extra = {}) => (options.runUpdater || runWindowsUpdater)(args, environment,
    { confirmed:true, allowPreview:true, deployment, progress, ...extra });
  if (request.operation === "check") {
    progress("Checking published stable Community releases.");
    const candidate = await (options.findRelease || findWindowsUpdate)(current, request.target);
    return windowsUpdateSummary("check", await run(["status"]), candidate, current);
  }
  let workspace;
  try {
    if (request.operation === "update") {
      progress("Verifying the selected stable Community release.");
      const candidate = await (options.findRelease || findWindowsUpdate)(current, request.target);
      if (!candidate) throw new Error("The selected update is not newer than the installed release");
      const cache = path.join(deployment.data,"management","updates","cache");
      await mkdir(cache,{recursive:true}); await assertRealDirectory(cache);
      workspace = path.join(cache,randomUUID());
      const packageRoot = await (options.download || downloadWindowsUpdate)(candidate, workspace, { progress,
        extract: async (archive, destination) => deployment.run(environment.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
          "-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path.join(deployment.root,"host","Expand-Update.ps1"),archive,destination,
        ]),
      });
      const result = await run(["update","--package",packageRoot,"--manifest-sha256",candidate.manifestSha256], {retainPrevious:true,automaticRecovery:true});
      return windowsUpdateSummary(request.operation,result);
    }
    return windowsUpdateSummary(request.operation,await run([request.operation]));
  } finally {
    if (workspace) {
      // Only this operation's generated cache child is eligible for removal.
      const cache = path.join(deployment.data,"management","updates","cache");
      if (path.dirname(workspace) !== cache || !/^[a-f0-9-]{36}$/.test(path.basename(workspace))) throw new Error("Invalid update cache ownership");
      try { await assertRealDirectory(workspace); await rm(workspace,{recursive:true,force:true}); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [installationFile, requestFile, ...extra] = process.argv.slice(2);
  const recovering=extra.length === 1 && extra[0] === "--recover";
  const send=(value)=>{if(process.connected)process.send(value,()=>{});};
  try {
    if ((extra.length && !recovering) || !installationFile || !requestFile || !process.send) throw new Error("Run Windows updates through the installed update service");
    // The parent must persist this worker's recovery record before maintenance
    // begins. Disconnecting before that handshake must never stop ALPR.
    await new Promise((resolve,reject)=>{
      const disconnected=()=>{process.off("message",started);reject(new Error("Updater disconnected before recording recovery ownership"));};
      const started=(message)=>{process.off("disconnect",disconnected);if(message?.kind !== "start")reject(new Error("Invalid updater start handshake"));else resolve();};
      process.once("message",started);process.once("disconnect",disconnected);
    });
    const installation = JSON.parse(await readFile(installationFile,"utf8"));
    const privateRoot = path.join(installation.dataRoot,"management","updates");
    if (path.dirname(requestFile) !== privateRoot || !/^request-[a-f0-9-]{36}\.json$/.test(path.basename(requestFile))) throw new Error("Invalid private update request location");
    await assertRealDirectory(privateRoot);
    const request = JSON.parse(await readFile(requestFile,"utf8"));
    const environment={...process.env,ALPR_WINDOWS_INSTALLATION:installationFile};
    const progress=(message)=>send({kind:"progress",message});
    let result;
    if(recovering) {
      const deployment=await loadWindowsDeployment(installationFile,{allowPreview:true});
      await waitForWindowsDatabase(deployment.installation,path.join(deployment.currentPath,"app"));
      result=windowsUpdateSummary("update",await runWindowsUpdater(["recover"],environment,{allowPreview:true,internalRecovery:true,deployment,progress}));
    }else result=await performWindowsUpdateRequest(request,environment,{progress});
    send({kind:"result",result});
  } catch (error) {
    // Detailed errors stay in the protected updater log, never in public state.
    console.error(error.stack || error.message);
    let summary = {};
    try {
      const result = await runWindowsUpdater(["status"],{...process.env,ALPR_WINDOWS_INSTALLATION:installationFile},{allowPreview:true});
      summary = windowsUpdateSummary("update",result);
    } catch { /* Keep the original failure authoritative. */ }
    send({kind:"error",result:{...summary,message:summary.updaterStatus === "rolled-back"
      ? "The update failed. ALPR restored the previous release automatically. Your recovery copy is preserved."
      : "The operation could not complete. Your data and recovery copies are preserved. Check the protected updater log or contact support."}});
    process.exitCode=1;
  } finally { if(process.connected)process.disconnect(); }
}
