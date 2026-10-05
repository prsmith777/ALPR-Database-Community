import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ensureInstallerCompiler } from "./build-windows-setup.mjs";
import { hashFile, verifyWindowsPackage } from "./windows-native-package.mjs";
import { verifyWindowsSetupStartup } from "./test-windows-setup-startup.mjs";

const root = path.resolve(import.meta.dirname,"..");
const [packageArgument,fromArgument] = process.argv.slice(2);
if (!packageArgument || !fromArgument) throw new Error("Usage: node scripts/build-windows-repair.mjs VERIFIED_PACKAGE_DIR INSTALLED_PREVIEW_PACKAGE_DIR");
const packageRoot = path.resolve(packageArgument), fromRoot = path.resolve(fromArgument);
const target = await verifyWindowsPackage(packageRoot,{allowPreview:true});
const previous = await verifyWindowsPackage(fromRoot,{allowPreview:true});
if (target.channel !== "preview" || previous.channel !== "preview" || target.version !== previous.version || target.commit === previous.commit) {
  throw new Error("Repairs require two different commits of the same Community preview version");
}
for (const file of ["schema.sql","migrations.sql"]) {
  if (target.files[file] !== previous.files[file]) throw new Error("A code repair cannot change the database schema or migrations");
}
const git = (args) => {
  const result = spawnSync("git",args,{cwd:root,encoding:"utf8",windowsHide:true});
  if (result.status !== 0) throw new Error("Cannot read build source state");
  return result.stdout.trim();
};
if (git(["rev-parse","HEAD"]) !== target.commit || git(["status","--porcelain","--untracked-files=normal"])) throw new Error("Build the repair from its clean payload source commit");
if (!target.files["host/windows-code-repair.mjs"]) throw new Error("Package does not include the code repair controller");
const sourceFile = path.join(root,"scripts/windows/CommunityRepair.iss");
const {compiler} = await ensureInstallerCompiler();
await verifyWindowsSetupStartup({compiler,sourceFile});
console.log("Verified compiled repair wizard startup");
const outputRoot = path.join(root,"dist/setup");
await mkdir(outputRoot,{recursive:true});
const name = "ALPR-Settings-Repair-" + target.commit.slice(0,12);
const output = path.join(outputRoot,name + ".exe");
if (existsSync(output)) throw new Error("Repair output already exists");
const manifestSha256 = await hashFile(path.join(packageRoot,"windows-package.json"));
const build = spawnSync(compiler,["/Q","/DPackageRoot="+packageRoot,"/DManifestSha256="+manifestSha256,
  "/DPackageVersion="+target.version,"/DFromCommit="+previous.commit,"/DOutputRoot="+outputRoot,"/DOutputName="+name,sourceFile],
  {cwd:root,windowsHide:true,stdio:"inherit"});
if (build.error || build.status !== 0) throw new Error("Repair executable compilation failed");
const sha256 = await hashFile(output);
await writeFile(output + ".sha256",sha256 + "  " + path.basename(output) + "\n",{flag:"wx"});
await writeFile(output + ".json",JSON.stringify({source:target.source,version:target.version,fromCommit:previous.commit,
  commit:target.commit,payloadManifestSha256:manifestSha256,repairSha256:sha256,wizardStartup:"verified",signed:false,desktopAcceptance:"pending"},null,2)+"\n",{flag:"wx"});
console.log("Built Settings repair: " + output);
