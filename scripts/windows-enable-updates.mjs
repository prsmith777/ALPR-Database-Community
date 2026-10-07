import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadWindowsDeployment } from "./windows-deployment.mjs";
import { runWindowsUpdater } from "./windows-maintenance.mjs";
import { refreshWindowsUpdateHost } from "./windows-update-host.mjs";
import { hashFile,verifyWindowsPackage } from "./windows-native-package.mjs";

export async function enableWindowsUpdates(packageRoot, manifestSha256, environment=process.env) {
  if(!/^[a-f0-9]{64}$/.test(manifestSha256) || await hashFile(path.join(packageRoot,"windows-package.json")) !== manifestSha256)throw new Error("Untrusted bridge package manifest");
  const manifest=await verifyWindowsPackage(packageRoot,{allowPreview:true});
  const deployment=await loadWindowsDeployment(environment.ALPR_WINDOWS_INSTALLATION,{allowPreview:true});
  const ps=environment.SystemRoot+"\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const serviceScript=path.join(packageRoot,"host","Pause-Updates.ps1");
  deployment.run(ps,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",serviceScript,deployment.root,deployment.data,"stop"]);
  try {
  const sameRelease=manifest.commit === deployment.current.commit && manifest.version === deployment.current.version;
  const result=sameRelease ? {target:{commit:manifest.commit}} : await runWindowsUpdater(["update","--package",packageRoot,"--manifest-sha256",manifestSha256],environment,
    {confirmed:true,allowPreview:true,deployment,retainPrevious:true,automaticRecovery:true,
      progress:phase=>console.log(`ALPR_SETUP_PROGRESS:${phase}`)});
  let stopped=false;
  try {
    deployment.service("stop");stopped=true;
    await refreshWindowsUpdateHost(deployment.installationFile);
    const script=path.join(deployment.root,"host","Enable-Updates.ps1");
    deployment.run(environment.SystemRoot+"\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",script,deployment.root,deployment.data]);
  } finally { if(stopped)deployment.service("start"); }
  await deployment.health();
  const selected=JSON.parse(await readFile(deployment.installationFile,"utf8"));
  const running=await deployment.attest();
  if(running.current !== selected.current || running.commit !== result.target.commit || !running.listenerOwned) throw new Error("Updated application ownership check failed");
  console.log("ALPR_SETUP_PROGRESS:ALPR is ready. Use your existing password and finish the checks in Settings > Software Updates.");
  return result;
  } finally {
    deployment.run(ps,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",serviceScript,deployment.root,deployment.data,"start"]);
  }
}
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  const [packageRoot,manifestSha256,...extra]=process.argv.slice(2);
  if(extra.length || !packageRoot || !manifestSha256)throw new Error("Run the verified Windows installer");
  try {await enableWindowsUpdates(path.resolve(packageRoot),manifestSha256);}
  catch(error){console.error("ALPR_SETUP_ERROR:Windows update could not complete. Your data and recovery copies are preserved.");console.error(error.stack);process.exitCode=1;}
}
