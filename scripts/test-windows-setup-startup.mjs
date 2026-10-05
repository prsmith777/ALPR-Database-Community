import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

// Execute the actual Inno script and native wizard controls. The compile-time
// probe excludes every installable file/action, requires no administrator token,
// and deliberately Abort()s in InitializeWizard. It cannot install ALPR.
export async function verifyWindowsSetupStartup({ compiler, sourceFile = path.join(root, "scripts/windows/CommunitySetup.iss") }) {
  if (process.platform !== "win32") throw new Error("Installer startup verification requires Windows");
  const scratch = await mkdtemp(path.join(os.tmpdir(), "alpr-inno-startup-"));
  try {
    const build = spawnSync(compiler, [
      "/Q", "/DStartupProbe=1", "/DPackageRoot=" + root,
      "/DManifestSha256=" + "0".repeat(64), "/DPackageVersion=0.0.0",
      "/DOutputRoot=" + scratch, "/DOutputName=startup-probe", sourceFile,
    ], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    if (build.error || build.status !== 0) {
      throw new Error("Installer startup probe compilation failed: " + (build.error?.message || build.stdout + build.stderr));
    }
    const logFile = path.join(scratch, "startup.log");
    const run = spawnSync(path.join(scratch, "startup-probe.exe"), [
      "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=" + logFile,
    ], { cwd: scratch, encoding: "utf8", windowsHide: true, timeout: 20_000 });
    const log = await readFile(logFile, "utf8").catch(() => "");
    // Exit 1 is intentional: Inno reports InitializeWizard's silent EAbort.
    // A compile-only check or an earlier startup failure cannot satisfy this.
    if (run.error || run.status !== 1 || !log.includes("ALPR_STARTUP_PROBE_PASSED") ||
        !log.includes("Got EAbort exception.") || /Runtime error|Type Mismatch|Starting the installation process/i.test(log)) {
      throw new Error("Installer wizard startup verification failed: " + (run.error?.message || "exit " + run.status) + "\n" + log);
    }
    return { verified: true, hostOsAccepted: log.includes("ALPR_STARTUP_PROBE_OS_CHECK=1") };
  } finally {
    if (path.dirname(path.resolve(scratch)) !== path.resolve(os.tmpdir())) {
      throw new Error("Refusing to remove a startup probe outside the temporary directory");
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const compiler = process.argv[2];
  if (!compiler) throw new Error("Usage: node scripts/test-windows-setup-startup.mjs <ISCC.exe>");
  console.log(await verifyWindowsSetupStartup({ compiler: path.resolve(compiler) }));
}
