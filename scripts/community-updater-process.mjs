import { spawn } from "node:child_process";
import { resolve } from "node:path";

// A long-lived host agent must not cache the updater across Git checkouts.
// The fixed child program uses IPC, not shell evaluation or parsed build logs.
const ENTRY = `
  import { pathToFileURL } from "node:url";
  import { join } from "node:path";
  process.once("message", async ({ argumentsList, root, confirmed }) => {
    try {
      const { runUpdaterCommand } = await import(pathToFileURL(join(root, "scripts", "community-updater.mjs")));
      const result = await runUpdaterCommand(argumentsList, process.env, {
        root, confirmed, ...(argumentsList[0] === "status" ? { logger: { log() {}, error() {} } } : {}),
      });
      process.send({ ok: true, result }, () => process.disconnect());
    } catch (error) {
      process.exitCode = 1;
      process.send({ ok: false, error: String(error?.message || "Updater failed") }, () => process.disconnect());
    }
  });
`;

export async function runFreshUpdater(argumentsList, environment, options = {}) {
  if (!["check", "status", "update", "validate", "accept", "rollback", "cleanup"].includes(argumentsList?.[0])) {
    throw new Error("Unsupported isolated updater operation");
  }
  const root = resolve(options.root);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", ENTRY], {
      cwd: root, env: environment, windowsHide: true,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let reply;
    child.once("error", reject);
    child.on("message", (message) => { reply = message; });
    child.once("exit", (code, signal) => {
      if (code === 0 && reply?.ok === true) resolvePromise(reply.result);
      else reject(new Error(reply?.error || `Updater process ended without success (code ${code}, signal ${signal})`));
    });
    child.send({ argumentsList, root, confirmed: options.confirmed === true });
  });
}
