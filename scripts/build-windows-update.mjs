import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { verifyWindowsPackage, hashFile } from "./windows-native-package.mjs";
import { windowsUpdateAssetNames, WINDOWS_UPDATE_PROTOCOL } from "./windows-update-release.mjs";

const root=path.resolve(import.meta.dirname,"..");
export async function buildWindowsUpdate(args=process.argv.slice(2)) {
  const index=args.indexOf("--package");
  if(index < 0 || !args[index+1] || process.platform !== "win32")throw new Error("Build on Windows with --package VERIFIED_PACKAGE [--preview]");
  const packageRoot=path.resolve(args[index+1]);
  const manifest=await verifyWindowsPackage(packageRoot,{allowPreview:args.includes("--preview")});
  const source=spawnSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8",windowsHide:true});
  const state=spawnSync("git",["status","--porcelain","--untracked-files=normal"],{cwd:root,encoding:"utf8",windowsHide:true});
  if(source.status !== 0 || state.status !== 0 || source.stdout.trim() !== manifest.commit || state.stdout.trim())throw new Error("Build Windows update assets from the same clean source commit as their native package");
  const names=windowsUpdateAssetNames(`v${manifest.version}`);
  const output=path.join(root,"dist","updates",manifest.channel === "stable"?"stable":manifest.commit.slice(0,12));
  await mkdir(output,{recursive:true});
  const archive=path.join(output,names.archive);
  const command="Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:ALPR_PACKAGE_SOURCE,$env:ALPR_PACKAGE_ARCHIVE,[IO.Compression.CompressionLevel]::Optimal,$false)";
  const result=spawnSync(path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile","-NonInteractive","-Command",`$ErrorActionPreference='Stop';${command}`],
    {env:{...process.env,ALPR_PACKAGE_SOURCE:packageRoot,ALPR_PACKAGE_ARCHIVE:archive},encoding:"utf8",windowsHide:true});
  if(result.status !== 0)throw new Error("Windows update ZIP creation failed: "+result.stderr);
  const {stat}=await import("node:fs/promises");
  const sha256=await hashFile(archive),sizeBytes=(await stat(archive)).size;
  const metadata={formatVersion:1,updaterProtocol:WINDOWS_UPDATE_PROTOCOL,source:manifest.source,tag:`v${manifest.version}`,commit:manifest.commit,
    channel:manifest.channel,manifestSha256:await hashFile(path.join(packageRoot,"windows-package.json")),archive:{name:names.archive,sha256,sizeBytes}};
  await writeFile(path.join(output,names.metadata),JSON.stringify(metadata,null,2)+"\n",{flag:"wx"});
  await writeFile(archive+".sha256",`${sha256}  ${names.archive}\n`,{flag:"wx"});
  console.log("Verified Windows UI update assets: "+output);
  return {archive,metadata};
}
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))await buildWindowsUpdate();
