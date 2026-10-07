import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  if (result.error) throw result.error;
  return result;
}
function section(source, start, end) {
  const first = source.indexOf(start), last = end ? source.indexOf(end, first) : source.length;
  if (first < 0 || last <= first) throw new Error("Cannot locate actual installer uninstall code");
  return source.slice(first, last);
}

// Compile the production uninstall handlers unchanged into a disposable,
// non-elevated installation. Only the controller and files are fixtures; no
// production paths, services, firewall rules or machine registry keys exist.
export async function verifyWindowsSetupUninstall({ compiler, sourceText, failure = "none" }) {
  if (process.platform !== "win32") throw new Error("Uninstall verification requires Windows");
  if (!["none", "check", "remove"].includes(failure)) throw new Error("Unknown uninstall fixture");
  const source = sourceText ?? await readFile(path.join(root, "scripts/windows/CommunitySetup.iss"), "utf8");
  const code = section(source, "function Powershell: String;", "function InitializeSetup:") +
    section(source, "procedure UninstallOutput(", "procedure CancelButtonClick(") +
    section(source, "function InitializeUninstall:");
  const scratch = await mkdtemp(path.join(os.tmpdir(), "alpr-inno-uninstall-"));
  const installed = path.join(scratch, "installed"), appId = "ALPR-Uninstall-Test-" + randomUUID();
  const uninstaller = path.join(installed, "unins000.exe");
  const controller = path.join(installed, "Uninstall.ps1");
  const args = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"];
  try {
    await mkdir(path.join(scratch, "retained-data"));
    await writeFile(path.join(scratch, "retained-data", "database.txt"), "preserved database and images");
    await writeFile(path.join(scratch, "program.txt"), "disposable program");
    await writeFile(path.join(scratch, "Uninstall.ps1"), `param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
if ($CheckOnly) {
    if ('${failure}' -eq 'check') { Write-Output 'Ownership check refused'; exit 1 }
    Set-Content -LiteralPath (Join-Path $PSScriptRoot '..\\checked.txt') -Value 'checked'
    Write-Output 'Ownership check passed'; exit 0
}
Write-Output 'ALPR_SETUP_PROGRESS:Stopping disposable fixture...'
if ('${failure}' -eq 'remove') { Write-Output 'Fixture service removal refused'; exit 1 }
Set-Content -LiteralPath (Join-Path $PSScriptRoot '..\\removed.txt') -Value 'removed'
Write-Output 'ALPR_SETUP_PROGRESS:Disposable fixture stopped; data preserved...'
`);
    const fixture = `[Setup]
AppId=${appId}
AppName=ALPR Disposable Uninstall Test
AppVersion=0.0.0
DefaultDirName=${installed}
PrivilegesRequired=lowest
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=yes
CloseApplications=no
RestartApplications=no
SetupLogging=yes
UninstallLogging=yes
OutputDir=${scratch}
OutputBaseFilename=uninstall-test
[Files]
Source: "Uninstall.ps1"; DestDir: "{app}"
Source: "program.txt"; DestDir: "{app}\\program"
[UninstallDelete]
Type: filesandordirs; Name: "{app}\\program"
[Code]
${code}
`;
    const sourceFile = path.join(scratch, "uninstall-test.iss");
    await writeFile(sourceFile, fixture);
    const build = run(compiler, ["/Q", sourceFile], scratch);
    if (build.status !== 0) throw new Error("Uninstall probe compilation failed: " + build.stdout + build.stderr);
    const setup = run(path.join(scratch, "uninstall-test.exe"), [...args, "/LOG=" + path.join(scratch, "setup.log")], scratch);
    if (setup.status !== 0 || !existsSync(uninstaller)) throw new Error("Disposable fixture installation failed: " + (setup.error?.message || "exit " + setup.status) + "\n" + await readFile(path.join(scratch, "setup.log"), "utf8").catch(() => setup.stdout + setup.stderr));
    const logFile = path.join(scratch, "uninstall.log");
    const uninstall = run(uninstaller, [...args, "/LOG=" + logFile], scratch);
    // Inno's first phase can exit while its temporary second-phase executable
    // finishes deleting the original uninstaller. Wait for that phase's log.
    let log = "";
    for (let attempt = 0; attempt < 48; attempt++) {
      log = await readFile(logFile, "utf8").catch(() => "");
      if (log.includes("Log closed.")) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!log.includes("Log closed.")) throw new Error("Uninstaller second phase did not finish: \n" + log);
    if (failure === "none") {
      // Inno can return success even when a post-uninstall event throws.
      // Inspect its real log as well as its exit code and removed files.
      if (uninstall.status !== 0 || !log.includes("Uninstallation process succeeded.") ||
          /Runtime error|raised an exception|Could not call proc/i.test(log) ||
          existsSync(uninstaller) || existsSync(path.join(installed, "program")) ||
          !existsSync(path.join(scratch, "checked.txt")) || !existsSync(path.join(scratch, "removed.txt"))) {
        throw new Error("Actual uninstall lifecycle failed (exit " + uninstall.status + "): \n" + log);
      }
    } else {
      if (uninstall.status === 0 || !existsSync(controller) ||
          !existsSync(path.join(installed, "program", "program.txt")) || existsSync(path.join(scratch, "removed.txt")) ||
          log.includes("Starting the uninstallation process.")) {
        throw new Error("Failed ownership/removal check did not preserve the fixture: \n" + log);
      }
      const message = failure === "check" ? "InitializeUninstall returned False" : "ALPR services could not be removed";
      if (!log.includes(message)) throw new Error("Uninstall failed for an unexpected reason: \n" + log);
    }
    if (await readFile(path.join(scratch, "retained-data", "database.txt"), "utf8") !== "preserved database and images") {
      throw new Error("Uninstall touched retained data");
    }
    return { verified: true, failure, retainedData: true };
  } finally {
    // A rejected fixture remains installed. Remove its own files/key only;
    // never broaden cleanup to a real ALPR installation.
    if (path.dirname(path.resolve(scratch)) !== path.resolve(os.tmpdir())) {
      throw new Error("Refusing to remove an uninstall probe outside the temporary directory");
    }
    const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const key = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + appId + "_is1";
    const cleanup = run(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      `if (Test-Path -LiteralPath '${key}') { Remove-Item -LiteralPath '${key}' -Recurse -Force -ErrorAction Stop }`], scratch);
    if (cleanup.status !== 0) throw new Error("Disposable uninstall registry cleanup failed: " + cleanup.stderr);
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/test-windows-setup-uninstall.mjs <ISCC.exe>");
  for (const failure of ["none", "check", "remove"]) {
    console.log(await verifyWindowsSetupUninstall({ compiler: path.resolve(process.argv[2]), failure }));
  }
}
