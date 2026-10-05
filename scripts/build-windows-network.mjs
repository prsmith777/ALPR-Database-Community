import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {ensureInstallerCompiler} from "./build-windows-setup.mjs";
import {assertWindowsHost,hashFile} from "./windows-native-package.mjs";
import {verifyWindowsSetupStartup} from "./test-windows-setup-startup.mjs";

const root=path.resolve(import.meta.dirname,"..");
assertWindowsHost();
const git=(args)=>{
  const result=spawnSync("git",args,{cwd:root,encoding:"utf8",windowsHide:true});
  if(result.status!==0)throw new Error("Cannot read network tool source state");
  return result.stdout.trim();
};
const commit=git(["rev-parse","HEAD"]);
if(git(["status","--porcelain","--untracked-files=normal"]))throw new Error("Build the network tool from clean source");
const previous=spawnSync("git",["show","5783f41b504408fd748325855e2a27b29953c907:scripts/windows/Uninstall.ps1"],{cwd:root,windowsHide:true});
if(previous.status!==0)throw new Error("The supervised preview's original uninstaller is unavailable");
// Existing preview builds used Windows checkout line endings. Accept the exact
// original script in either Git LF or Windows CRLF form, never arbitrary code.
const previousUninstallerSha256=[previous.stdout,Buffer.from(previous.stdout.toString("utf8").replace(/\r?\n/g,"\r\n"))]
  .map((bytes)=>createHash("sha256").update(bytes).digest("hex")).filter((value,index,all)=>all.indexOf(value)===index).join(",");
const version=JSON.parse(await readFile(path.join(root,"package.json"),"utf8")).version;
const {compiler}=await ensureInstallerCompiler();
const sourceFile=path.join(root,"scripts/windows/CommunityNetwork.iss");
await verifyWindowsSetupStartup({compiler,sourceFile});
console.log("Verified compiled network access wizard startup");
const outputRoot=path.join(root,"dist/setup"),name="ALPR-Network-Access-"+commit.slice(0,12);
await mkdir(outputRoot,{recursive:true});
const output=path.join(outputRoot,name+".exe");
if(existsSync(output))throw new Error("Network tool output already exists");
const built=spawnSync(compiler,["/Q","/DPackageVersion="+version,"/DPreviousUninstallerSha256="+previousUninstallerSha256,
  "/DOutputRoot="+outputRoot,"/DOutputName="+name,sourceFile],{cwd:root,stdio:"inherit",windowsHide:true});
if(built.error||built.status!==0)throw new Error("Network access tool compilation failed");
const sha256=await hashFile(output);
await writeFile(output+".sha256",sha256+"  "+path.basename(output)+"\n",{flag:"wx"});
await writeFile(output+".json",JSON.stringify({source:"https://github.com/prsmith777/ALPR-Database-Community",version,commit,
  toolSha256:sha256,previousUninstallerSha256,signed:false,wizardStartup:"verified",desktopAcceptance:"pending"},null,2)+"\n",{flag:"wx"});
console.log("Built network access tool: "+output);
