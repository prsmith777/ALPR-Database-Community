import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { runUpdaterCommand } from "./community-updater.mjs";
import { submitCommunityUpdateRequest } from "../lib/community-update-control.mjs";
import { processCommunityUpdateRequest } from "./community-update-agent.mjs";

const SERVICE = "alpr-community-update-agent.service";
function systemctl(args, { optional = false } = {}) {
  const result = spawnSync("systemctl", ["--user", ...args, SERVICE], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    if (optional) return null;
    throw new Error("Could not " + args[0] + " the installation's update service; no further operation will run.");
  }
  return String(result.stdout || "").trim();
}
async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function runMaintenance(root, target, options = {}) {
  root = resolve(root);
  if (!/^v\d+\.\d+\.\d+$/.test(target)) throw new Error("An exact stable target is required");
  const updater = options.updater || runUpdaterCommand;
  const environment = options.environment || process.env;
  const directory = resolve(environment.ALPR_UPDATE_CONTROL_DIR || join(root, "update-control"));
  const service = options.systemctl || systemctl;
  const log = options.logger || console;
  const state = await updater(["status"], environment, { root, logger: { log() {} } });
  if (state && !["accepted", "rolled-back"].includes(state.status)) {
    throw new Error("Finish or roll back the current update first. Retain its backup.");
  }
  for (const file of ["request.json", "request-active.json"]) {
    if (await exists(join(directory, file))) {
      throw new Error("A browser update request is pending or active. Finish it first.");
    }
  }
  const active = service(["is-active"], { optional: true }) === "active";
  if (active) {
    const serviceRoot = service(["show", "--property=WorkingDirectory", "--value"]);
    if (resolve(serviceRoot) !== root) throw new Error("The update service belongs to another installation");
  } else if (await exists(join(directory, "agent.lock"))) {
    throw new Error("Stop the foreground update agent before using the maintenance launcher");
  }
  log.log("This will back up and update this installation to " + target + ".");
  log.log("It temporarily stops this installation's update service, then restarts it. Do not use the browser update controls meanwhile.");
  const answer = await options.confirm("Type INSTALL " + target + " to continue: ");
  if (answer.trim() !== "INSTALL " + target) return { cancelled: true };
  if (active) service(["stop"]);
  try {
    // Stop first, then repeat the queue check to catch requests arriving while
    // confirmation was being read. Never overwrite an existing request.
    for (const file of ["request.json", "request-active.json"]) {
      if (await exists(join(directory, file))) throw new Error("A browser request arrived; restart the service and finish it first.");
    }
    await submitCommunityUpdateRequest({
      operation: "update", target, confirmation: "INSTALL " + target,
    }, {
      directory, requireAgentOnline: false,
      actor: { id: "host-maintenance", username: "Local installation owner" },
    });
    const result = await processCommunityUpdateRequest({
      directory, root, environment, logger: log, runUpdaterCommand: updater,
    });
    if (!result) throw new Error("Maintenance request was not claimed; do not start another update until its state is inspected");
    if (result.phase !== "succeeded") throw new Error(result.message);
    log.log("Technical system checks passed. Return to Software Updates for real-use checks and Accept update.");
    return result;
  } finally {
    if (active) service(["start"]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (process.argv.length !== 4) throw new Error("Use the verified community-maintenance.sh launcher from the installation directory");
    if (userInfo().uid === 0) throw new Error("Run as the installation owner, not root");
    await runMaintenance(process.argv[2], process.argv[3], { confirm: (question) => terminal.question(question) });
  } catch (error) {
    console.error("Maintenance stopped safely: " + error.message);
    process.exitCode = 1;
  } finally { terminal.close(); }
}
