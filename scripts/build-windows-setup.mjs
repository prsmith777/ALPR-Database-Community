import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertWindowsHost, hashFile, verifyWindowsPackage } from "./windows-native-package.mjs";
import { verifyWindowsSetupStartup } from "./test-windows-setup-startup.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, windowsHide: true, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(path.basename(command) + " failed");
}
async function download(pin, file) {
  if (!existsSync(file)) {
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error("Compiler download failed: " + response.status);
    await writeFile(file, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
  }
  if (await hashFile(file) !== pin.sha256) throw new Error("Installer compiler checksum mismatch");
}
export async function ensureInstallerCompiler() {
  const pins = JSON.parse(await readFile(path.join(root, "scripts", "windows", "setup-prerequisites.json"), "utf8"));
  const cache = path.join(root, ".native-dependencies");
  await mkdir(cache, { recursive: true });
  const compilerRoot = path.join(cache, "inno-" + pins.compiler.version);
  const compiler = process.env.ALPR_ISCC_PATH || path.join(compilerRoot, "ISCC.exe");
  if (!existsSync(compiler)) {
    if (process.env.ALPR_ISCC_PATH) throw new Error("ALPR_ISCC_PATH does not exist");
    const file = path.join(cache, "innosetup-" + pins.compiler.version + ".exe");
    await download(pins.compiler, file);
    // Inno's documented portable mode writes only into this build cache,
    // without installing a system compiler or registering file associations.
    run(file, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/NOICONS", "/PORTABLE=1", "/DIR=" + compilerRoot]);
  }
  return { compiler, pins };
}
export async function buildWindowsSetup(args = process.argv.slice(2)) {
  assertWindowsHost();
  const packageIndex = args.indexOf("--package");
  if (packageIndex < 0 || !args[packageIndex + 1]) throw new Error("Use --package <verified-native-package> [--preview]");
  const packageRoot = path.resolve(args[packageIndex + 1]);
  const manifest = await verifyWindowsPackage(packageRoot, { allowPreview: args.includes("--preview") });
  const source = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  const state = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (source.status !== 0 || state.status !== 0 || source.stdout.trim() !== manifest.commit || state.stdout.trim()) {
    throw new Error("Build graphical setup from the same clean source commit as its native package");
  }
  const installer = await readFile(path.join(packageRoot, "Install.ps1"), "utf8");
  if (!installer.includes("AdministratorPasswordFile") || !installer.includes("CopyPrerequisites")) throw new Error("Rebuild the native package with the graphical installer engine");
  const manifestSha256 = await hashFile(path.join(packageRoot, "windows-package.json"));
  const { compiler, pins } = await ensureInstallerCompiler();
  await verifyWindowsSetupStartup({ compiler });
  console.log("Verified compiled installer wizard startup before packaging");
  const outputRoot = path.join(root, "dist", "setup");
  await mkdir(outputRoot, { recursive: true });
  const name = `ALPR-Community-${manifest.version}-${manifest.commit.slice(0,12)}-${manifest.channel}-Setup`;
  const output = path.join(outputRoot, name + ".exe");
  if (existsSync(output)) throw new Error("Installer output already exists; preserve it or choose a new source commit");
  run(compiler, [
    "/DPackageRoot=" + packageRoot, "/DManifestSha256=" + manifestSha256,
    "/DPackageVersion=" + manifest.version, "/DOutputRoot=" + outputRoot, "/DOutputName=" + name,
    path.join(root, "scripts", "windows", "CommunitySetup.iss"),
  ]);
  const checksum = await hashFile(output);
  await writeFile(output + ".sha256", checksum + "  " + path.basename(output) + "\n", { flag: "wx" });
  await writeFile(output + ".json", JSON.stringify({ formatVersion: 1, source: manifest.source,
    version: manifest.version, commit: manifest.commit, channel: manifest.channel,
    payloadManifestSha256: manifestSha256, setupSha256: checksum, prerequisites: pins,
    signed: false, wizardStartup: "verified", desktopAcceptance: "pending" }, null, 2) + "\n", { flag: "wx" });
  console.log("Built graphical Windows setup: " + output);
  return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWindowsSetup();
}
