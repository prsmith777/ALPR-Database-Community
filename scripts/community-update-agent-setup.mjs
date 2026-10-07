import { lstat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { communityUpdateControlInternals } from "../lib/community-update-control.mjs";
import { communityUpdateAgentInternals, installCommunityUpdateAgent } from "./community-update-agent.mjs";

function defaultRunner(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || command + " failed").trim());
  return String(result.stdout || "").trim();
}

async function isSystemdHost(directory) {
  try { return (await lstat(directory)).isDirectory(); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function ensureCommunityUpdateAgent(options = {}) {
  if ((options.platform || process.platform) !== "linux" ||
      !await isSystemdHost(options.systemdDirectory || "/run/systemd/system")) {
    throw new Error("Automatic Software Updates setup requires a Linux systemd host; use the command-line updater or supervise the agent run command on this host");
  }
  const identity = options.identity || userInfo();
  if (!Number.isSafeInteger(identity.uid) || identity.uid <= 0 || !identity.username || !identity.homedir) {
    throw new Error("Run helper setup as the normal Linux account that owns this installation, not root");
  }
  const runner = options.runner || defaultRunner;
  const environment = {
    ...(options.environment || process.env),
    XDG_RUNTIME_DIR: "/run/user/" + identity.uid,
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/" + identity.uid + "/bus",
  };
  const commandOptions = { env: environment };
  const linger = () => runner("loginctl", ["show-user", identity.username, "--property=Linger", "--value"], commandOptions);
  let lingering = false;
  try { lingering = linger() === "yes"; } catch { /* No user manager may exist before enabling lingering. */ }
  if (!lingering) {
    const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    (options.logger || console).log("Enabling the ALPR update helper to start after reboot for " + identity.username + ".");
    runner("sudo", [...(interactive ? [] : ["-n"]), "loginctl", "enable-linger", identity.username], {
      ...commandOptions, ...(interactive ? { stdio: "inherit", timeout: undefined } : {}),
    });
    if (linger() !== "yes") throw new Error("Startup after reboot could not be verified for the installation owner");
  }
  const wait = options.sleep || sleep;
  const attempts = options.readyAttempts || 30;
  const busAvailable = options.busAvailable || (async () => {
    try { return (await lstat(join(environment.XDG_RUNTIME_DIR, "bus"))).isSocket(); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
  let busReady = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await busAvailable()) { busReady = true; break; }
    await wait(500);
  }
  if (!busReady) throw new Error("The owner's systemd user bus is unavailable; run the recovery command from that account's login session");
  const serviceDirectory = options.serviceDirectory || join(identity.homedir, ".config", "systemd", "user");
  const service = await installCommunityUpdateAgent({ ...options, serviceDirectory, runner, environment });
  const clock = options.clock || (() => new Date());
  for (let attempt = 0; attempt < attempts; attempt++) {
    const properties = runner("systemctl", ["--user", "show", service.serviceName, "--property=ActiveState", "--property=MainPID"], commandOptions);
    const pid = Number(properties.match(/^MainPID=(\d+)$/m)?.[1]);
    const heartbeat = await communityUpdateControlInternals.readJsonFile(join(service.controlDirectory, "heartbeat.json")).catch(() => null);
    const age = new Date(clock()).getTime() - Date.parse(heartbeat?.observedAt);
    if (/^ActiveState=active$/m.test(properties) && pid > 0 && heartbeat?.pid === pid &&
        heartbeat?.formatVersion === 1 && Number.isFinite(age) && age >= 0 && age <= communityUpdateControlInternals.HEARTBEAT_MAX_AGE_MS) {
      return { status: "ready", startupAfterReboot: true, preserved: service.preserved };
    }
    await wait(500);
  }
  throw new Error("The update helper did not report a fresh heartbeat for its running service; check ./alpr-community agent status");
}

// A helper failure must never undo a healthy application installation or cutover.
export async function setupCommunityUpdateAgent(options = {}) {
  const logger = options.logger || console;
  try {
    const result = await (options.ensureAgent || ensureCommunityUpdateAgent)(options);
    logger.log("Settings > Software Updates is ready. The helper starts automatically after reboot.");
    return result;
  } catch (error) {
    logger.log("ALPR is running, but automatic Software Updates setup needs attention: " + communityUpdateAgentInternals.safeErrorMessage(error));
    logger.log("From the installation owner's Linux account, run:");
    logger.log("  cd " + JSON.stringify(resolve(options.root || ".")));
    logger.log("  ./alpr-community agent install");
    return { status: "manual", code: "helper-setup-incomplete" };
  }
}
