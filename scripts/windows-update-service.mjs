import { fork } from "node:child_process";
import { lstat, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCommunityUpdateRequest } from "../lib/community-update-control.mjs";
import { assertRealDirectory, atomicJson } from "./windows-deployment.mjs";
import { verifyWindowsPackage } from "./windows-native-package.mjs";
import { windowsUpdateSummary } from "./windows-update-worker.mjs";
import { refreshWindowsUpdateHost } from "./windows-update-host.mjs";

async function readRegularJson(file) {
  const handle = await open(file,"r");
  try {
    const stat = await handle.stat();
    const entry = await lstat(file);
    if (!stat.isFile() || entry.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error("Invalid Windows update request file");
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const {bytesRead} = await handle.read(bytes,0,bytes.length,0);
    if (bytesRead > 64 * 1024) throw new Error("Windows update request is too large");
    return JSON.parse(bytes.subarray(0,bytesRead).toString("utf8"));
  } finally { await handle.close(); }
}
function checkedRequest(input, clock = Date.now) {
  const result = validateCommunityUpdateRequest(input,{requireIdentity:true});
  const age = clock() - Date.parse(result.createdAt);
  if (input.formatVersion !== 1 || age < -30_000 || age > 5 * 60_000) throw new Error("Windows update request is unsupported or expired");
  return result;
}
async function publication(directory, name, value) {
  await assertRealDirectory(directory);
  const destination = path.join(directory,name);
  try { const stat = await lstat(destination); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Invalid public update state file"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await atomicJson(destination,value);
}
export async function claimWindowsUpdateRequest({control,privateRoot,clock}) {
  await assertRealDirectory(control); await assertRealDirectory(privateRoot);
  const queued = path.join(control,"request.json");
  let input;
  try { input = await readRegularJson(queued); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  // Copy only the validated fixed-operation object into private storage. A
  // writable inbox file is never executed or used as a package/path argument.
  const request = checkedRequest(input,clock);
  const requestFile = path.join(privateRoot,`request-${request.id}.json`);
  await writeFile(requestFile,JSON.stringify(request),{flag:"wx"});
  await rm(queued);
  return {request,requestFile};
}
export async function runWindowsUpdateService(installationFile, options = {}) {
  const installation = JSON.parse(await readFile(installationFile,"utf8"));
  const root = path.dirname(installationFile), data = installation.dataRoot;
  if (installation.profile !== "windows-native" || installation.installRoot !== root || !path.isAbsolute(data) ||
      path.basename(installationFile) !== "installation.json") throw new Error("Invalid protected Windows update installation");
  await assertRealDirectory(root); await assertRealDirectory(data);
  const privateRoot = path.join(data,"management","updates"), control = path.join(data,"update-control");
  // Setup creates both directories with different, protected ACLs. Never adopt
  // an app-created parent or construct the privileged lock in the inbox.
  await assertRealDirectory(privateRoot); await assertRealDirectory(control);
  const lockFile = path.join(privateRoot,"agent.lock");
  let lock;
  try { lock = await open(lockFile,"wx"); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = await readRegularJson(lockFile);
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error("Invalid private Windows updater lock");
    try { process.kill(previous.pid,0); throw new Error("Windows update service is already running"); }
    catch (probe) { if (probe.code !== "ESRCH") throw probe; }
    await rm(lockFile); lock = await open(lockFile,"wx");
  }
  await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
  let stopping = false, child = null;
  let pendingRecovery=null;
  const stop = () => { stopping = true; };
  process.on("SIGTERM",stop); process.on("SIGINT",stop);
  const heartbeat = () => publication(control,"heartbeat.json",{formatVersion:1,observedAt:new Date().toISOString()});
  let heartbeatWrite = Promise.resolve();
  const timer = setInterval(() => { heartbeatWrite = heartbeatWrite.then(heartbeat).catch((error)=>console.error(error.message)); },5_000);
  try {
    await heartbeat();
    try {
      const recorded=JSON.parse(await readFile(path.join(data,"management","backups","updater-state.json"),"utf8"));
      await publication(control,"state.json",{formatVersion:1,operation:"update",phase:"succeeded",...windowsUpdateSummary("update",recorded),completedAt:new Date().toISOString()});
    } catch(error) {
      if(error.code !== "ENOENT")throw error;
      await publication(control,"state.json",{formatVersion:1,phase:"idle",updaterStatus:"current",message:"Ready to check for stable Community updates."});
    }
    try {
      const active=await readRegularJson(path.join(privateRoot,"active.json"));
      if(!Number.isSafeInteger(active.workerPid) || active.workerPid <= 0 || path.dirname(active.requestFile) !== privateRoot || path.basename(active.requestFile) !== `request-${active.requestId}.json`)throw new Error("Invalid private recovery record");
      while(!stopping) {
        try{process.kill(active.workerPid,0);}catch(error){if(error.code === "ESRCH")break;throw error;}
        await new Promise(resolve=>setTimeout(resolve,1_000));
      }
      const request=await readRegularJson(active.requestFile);
      validateCommunityUpdateRequest(request,{requireIdentity:true});
      if(request.id !== active.requestId)throw new Error("Private recovery request differs");
      pendingRecovery={request,requestFile:active.requestFile,recover:true};
    }catch(error){if(error.code !== "ENOENT")throw error;await rm(path.join(control,"request-active.json"),{force:true});}
    while (!stopping) {
      let claimed;
      try { claimed = pendingRecovery || await claimWindowsUpdateRequest({control,privateRoot}); pendingRecovery=null; }
      catch (error) {
        console.error(error.message);
        await publication(control,"state.json",{formatVersion:1,phase:"failed",message:"The update request was invalid or already processed. Check the updater log before retrying.",completedAt:new Date().toISOString()});
        // Remove only the invalid fixed inbox entry, never follow a junction.
        const queued = path.join(control,"request.json");
        try { const info = await lstat(queued); if (info.isFile() && !info.isSymbolicLink()) await rm(queued); } catch (failure) { if (failure.code !== "ENOENT") throw failure; }
      }
      if (!claimed) { await new Promise((resolve)=>setTimeout(resolve,1_000)); continue; }
      const {request,requestFile} = claimed;
      const state = {formatVersion:1,requestId:request.id,operation:request.operation,phase:"running",createdAt:request.createdAt,
        startedAt:new Date().toISOString(),targetTag:request.target,message:"Starting the requested Windows update operation."};
      await publication(control,"request-active.json",{requestId:request.id});
      await publication(control,"state.json",state);
      let result = null, success = false, updates = Promise.resolve();
      try {
        const selected = JSON.parse(await readFile(installationFile,"utf8"));
        if (!/^\d+\.\d+\.\d+-[a-f0-9]{12}$/.test(selected.current || "")) throw new Error("Invalid selected Windows release");
        const release = path.join(root,"releases",selected.current);
        await verifyWindowsPackage(release,{allowPreview:true});
        child = (options.fork || fork)(path.join(root,"host","windows-update-worker.mjs"),[installationFile,requestFile,...(claimed.recover?["--recover"]:[])],
          {execPath:path.join(release,"runtime","node.exe"),windowsHide:true,stdio:["ignore","inherit","inherit","ipc"],env:{...process.env}});
        await atomicJson(path.join(privateRoot,"active.json"),{requestId:request.id,workerPid:child.pid,requestFile,startedAt:state.startedAt});
        child.on("message",(message)=>{
          if (message?.kind === "progress" && typeof message.message === "string") {
            updates=updates.then(()=>publication(control,"state.json",{...state,message:message.message.slice(0,300)}));
          } else if (["result","error"].includes(message?.kind) && message.result && typeof message.result === "object") {
            result=message.result; success=message.kind === "result";
          }
        });
        const code = await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",(code)=>resolve(code));});
        success = success && code === 0;
        await updates;
        if(success && request.operation === "update" && !claimed.recover)await refreshWindowsUpdateHost(installationFile);
        await publication(control,"state.json",{...state,...result,phase:success?"succeeded":"failed",completedAt:new Date().toISOString(),
          message:result?.message || "The Windows update worker stopped unexpectedly. Preserve all ALPR data and check the updater log."});
      } catch (error) {
        console.error(error.stack || error.message);
        await updates.catch(()=>{});
        await publication(control,"state.json",{...state,...result,phase:"failed",message:"The Windows update operation could not complete. Preserve all ALPR data and check the updater log.",completedAt:new Date().toISOString()});
      } finally {
        child=null;
        await rm(path.join(control,"request-active.json"),{force:true});
        if(success || !claimed.recover)await rm(path.join(privateRoot,"active.json"),{force:true});
        // Keep the small validated request as an audit/replay-prevention record.
      }
    }
  } finally {
    clearInterval(timer); await heartbeatWrite;
    await lock.close(); await rm(lockFile,{force:true});
    process.off("SIGTERM",stop); process.off("SIGINT",stop);
  }
}
export const windowsUpdateServiceInternals = Object.freeze({readRegularJson,checkedRequest,publication});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [installationFile,...extra]=process.argv.slice(2);
  if (!installationFile || extra.length) throw new Error("Run the installed Windows update service");
  await runWindowsUpdateService(installationFile);
}
