import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertWindowsHost } from "./windows-native-package.mjs";
import { waitForWindowsDatabase } from "./windows-service-startup.mjs";

assertWindowsHost();
const installationFile = process.argv[2];
if (!installationFile || !path.isAbsolute(installationFile)) throw new Error("Provide the protected installation configuration");
const installation = JSON.parse(await readFile(installationFile, "utf8"));
if (installation.formatVersion !== 1 || installation.profile !== "windows-native" ||
    !/^\d+\.\d+\.\d+-[0-9a-f]{12}$/.test(installation.current)) {
  throw new Error("Unsupported native installation configuration");
}
const application = path.join(installation.installRoot, "releases", installation.current, "app");
for (const [name, value] of Object.entries(installation.environment)) process.env[name] = String(value);
process.env.VEHICLE_REID_MODEL_DIR = path.join(application, "models", "visual-search");
process.env.ALPR_RELEASE_SHA = installation.current.split("-")[1];
// Use the target release's Node binary so native addons and Node security
// patches travel with each application release. The fixed IPC bridge asks
// Next.js to run its own SIGINT cleanup on Windows.
const entry = "import {pathToFileURL} from 'node:url';import path from 'node:path';await import(pathToFileURL(path.join(process.cwd(),'server.js')));process.on('message',()=>process.emit('SIGINT'));";
let child;
const stopping = new AbortController();
const shutdown = () => {
  stopping.abort();
  if (child?.connected) child.send("stop", () => {});
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
// The isolated runtime smoke test uses the same fixed stop message that the
// launcher sends to Next.js. WinSW itself uses SIGINT and has no IPC channel.
process.on("message", (message) => { if (message === "stop") shutdown(); });
const disconnect = () => { if (process.connected) process.disconnect(); };
try {
  await waitForWindowsDatabase(installation, application, {
    signal: stopping.signal,
    onWaiting: () => console.log("Waiting for PostgreSQL before starting ALPR..."),
  });
  console.log("PostgreSQL is ready; starting ALPR.");
  process.chdir(application);
  child = spawn(path.join(installation.installRoot, "releases", installation.current, "runtime", "node.exe"),
    ["--input-type=module", "-e", entry], { cwd: application, env: process.env, windowsHide: true, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  child.once("error", () => { console.error("Native application process could not start"); process.exitCode = 1; disconnect(); });
  child.once("exit", (code) => { process.exitCode = code ?? 1; disconnect(); });
} catch {
  if (stopping.signal.aborted) process.exitCode = 0;
  else {
    console.error("ALPR could not verify PostgreSQL readiness. Windows will retry the application service.");
    process.exitCode = 1;
  }
  disconnect();
}
