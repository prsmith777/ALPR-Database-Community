import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serializeReleaseMetadata } from "./write-release-metadata.mjs";
import { assertWindowsHost, COMMUNITY_SOURCE, hashFile, listPackageFiles, verifyWindowsPackage } from "./windows-native-package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WINSW_URL = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe";
const WINSW_SHA256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da";

async function copyDependencyLicenses(source, destination) {
  await mkdir(destination);
  const index = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, name);
      else if (entry.isFile() && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(entry.name)) {
        // Flatten paths so nested dependency notices do not push the Windows
        // installer beyond inbox PowerShell's legacy path limit.
        const id = createHash("sha256").update(name).digest("hex") + ".txt";
        await cp(file, path.join(destination, id));
        index.push({ source: name, notice: id });
      }
    }
  }
  await visit(source);
  await writeFile(path.join(destination, "index.json"), JSON.stringify(index, null, 2) + "\n");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, windowsHide: true, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${path.basename(command)} failed`);
  return result;
}

async function main() {
  assertWindowsHost();
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Build with Node.js 24");
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const commit = run("git", ["rev-parse", "HEAD"], { stdio: "pipe", encoding: "utf8" }).stdout.trim();
  const tag = run("git", ["describe", "--exact-match", "--tags", "HEAD"], { stdio: "pipe", encoding: "utf8", allowFailure: true });
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=normal"], { stdio: "pipe", encoding: "utf8" }).stdout.trim();
  const stable = !dirty && tag.status === 0 && tag.stdout.trim() === `v${packageJson.version}`;
  if (!stable && !process.argv.includes("--preview")) throw new Error("Stable Windows packages require a clean exact Community version tag; use --preview for development");
  // Always rebuild to prevent packaging stale standalone files from another
  // checkout. Restore the tracked generated file after embedding this build.
  const metadataFile = path.join(root, "lib", "built-release-metadata.mjs");
  const originalMetadata = await readFile(metadataFile, "utf8");
  try {
    await writeFile(metadataFile, serializeReleaseMetadata({ gitSha: commit, channel: stable ? "stable" : "preview" }));
    run(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "build"]);
  } finally {
    await writeFile(metadataFile, originalMetadata);
  }
  const name = `alpr-community-${packageJson.version}-${commit.slice(0, 12)}-windows-x64`;
  const destination = path.join(root, "dist", name);
  // Exclusive creation prevents accidentally overwriting an existing package.
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination);
  await cp(path.join(root, ".next", "standalone"), path.join(destination, "app"), { recursive: true, dereference: true });
  for (const relative of ["next/dist/compiled/@vercel/nft", "braces", "micromatch"]) {
    const forbidden = path.join(destination, "app", "node_modules", relative);
    try {
      await readdir(forbidden);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Build-only dependency leaked into the Windows runtime: " + relative);
  }
  await cp(path.join(root, ".next", "static"), path.join(destination, "app", ".next", "static"), { recursive: true });
  await cp(path.join(root, "public"), path.join(destination, "app", "public"), { recursive: true });
  await cp(path.join(root, "models"), path.join(destination, "app", "models"), { recursive: true });
  // The external OpenVINO package must include its native DLLs in the final
  // runtime, irrespective of Next.js tracing of dynamic addon loading.
  await cp(path.join(root, "node_modules", "openvino-node"), path.join(destination, "app", "node_modules", "openvino-node"), { recursive: true });
  for (const dependency of ["js-yaml", "argparse"]) {
    await cp(path.join(root, "node_modules", dependency), path.join(destination, "app", "node_modules", dependency), { recursive: true });
  }
  await mkdir(path.join(destination, "runtime"));
  await cp(process.execPath, path.join(destination, "runtime", "node.exe"));
  const response = await fetch(WINSW_URL, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`WinSW download failed: HTTP ${response.status}`);
  const wrapper = path.join(destination, "runtime", "winsw.exe");
  await writeFile(wrapper, Buffer.from(await response.arrayBuffer()));
  if (await hashFile(wrapper) !== WINSW_SHA256) throw new Error("WinSW checksum mismatch");
  for (const [name, url] of [
    ["WinSW-LICENSE.txt", "https://raw.githubusercontent.com/winsw/winsw/v2.12.0/LICENSE.txt"],
    ["Node-LICENSE.txt", `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`],
  ]) {
    const license = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!license.ok) throw new Error(`Required license download failed: ${name}`);
    await writeFile(path.join(destination, "runtime", name), await license.text());
  }
  await mkdir(path.join(destination, "host"));
  for (const file of ["windows-update-host.mjs","windows-enable-updates.mjs","windows-update-service.mjs","windows-update-worker.mjs","windows-update-release.mjs","windows-native-package.mjs", "windows-service.mjs", "windows-service-startup.mjs", "windows-maintenance.mjs", "windows-code-repair.mjs", "windows-deployment.mjs", "native-reid-upgrade-policy.mjs", "windows-migration.mjs", "community-migration-bundle.mjs", "postgres-major-migration.mjs"]) {
    await cp(path.join(root, "scripts", file), path.join(destination, "host", file));
  }
  for (const file of ["schema.sql", "migrations.sql", "LICENSE"]) await cp(path.join(root, file), path.join(destination, file));
  await cp(path.join(root, "scripts", "windows", "Install.ps1"), path.join(destination, "Install.ps1"));
  await cp(path.join(root, "docs", "WINDOWS_NATIVE.md"), path.join(destination, "README-WINDOWS.md"));
  await cp(path.join(root, "scripts", "windows", "Service-Control.ps1"), path.join(destination, "host", "Service-Control.ps1"));
  for (const file of ["Pause-Updates.ps1","Enable-Updates.ps1","Update-Service.ps1","Expand-Update.ps1","Network.ps1","Network-Helpers.ps1","Setup-Helpers.ps1","ExportMigration.ps1"]) {
    await cp(path.join(root,"scripts/windows",file),path.join(destination,"host",file));
  }
  await mkdir(path.join(destination,"lib"));
  for (const file of ["community-update-control.mjs","community-update-shape.mjs"]) {
    await cp(path.join(root,"lib",file),path.join(destination,"lib",file));
  }
  await cp(path.join(root, "scripts", "openvino-runtime-probe.cjs"), path.join(destination, "app", "openvino-runtime-probe.cjs"));
  await writeFile(path.join(destination, "THIRD-PARTY-NOTICES.txt"),
    "Node.js: runtime/Node-LICENSE.txt\nWinSW 2.12.0 (MIT): runtime/WinSW-LICENSE.txt\nOpenVINO 2025.4.0 (Apache-2.0): bundled licenses in app/node_modules/openvino-node/bin\nDependency license/notice files and their source paths: dependency-licenses/index.json\nPostgreSQL and FFmpeg are downloaded directly from their publishers by graphical setup, or installed separately by the operator. Their binaries are not embedded in this package or the setup executable.\n");
  await copyDependencyLicenses(path.join(root, "node_modules"), path.join(destination, "dependency-licenses"));
  // Exercise all three AI models using the shipped Node.exe and native DLLs.
  run(path.join(destination, "runtime", "node.exe"), ["openvino-runtime-probe.cjs"], { cwd: path.join(destination, "app") });
  run(path.join(destination, "runtime", "node.exe"), ["-e", "require('sharp'); require('bcrypt'); require('pg'); require('mqtt'); require('js-yaml')"], { cwd: path.join(destination, "app") });
  const files = {};
  for (const file of await listPackageFiles(destination)) files[file] = await hashFile(path.join(destination, ...file.split("/")));
  await writeFile(path.join(destination, "windows-package.json"), JSON.stringify({
    formatVersion: 1, source: COMMUNITY_SOURCE, version: packageJson.version, commit,
    channel: stable ? "stable" : "preview", platform: "win32", arch: "x64", files,
  }, null, 2) + "\n");
  await verifyWindowsPackage(destination, { allowPreview: true });
  console.log(`Verified native Windows package: ${destination}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
