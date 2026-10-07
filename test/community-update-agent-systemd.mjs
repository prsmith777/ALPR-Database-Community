import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureCommunityUpdateAgent } from "./scripts/community-update-agent-setup.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const identity = userInfo();
assert.equal(identity.username, "alpr-helper-ci");
assert.ok(root.startsWith("/tmp/alpr-helper-ci.") && root.endsWith("/app"));
const serviceName = "alpr-community-update-agent.service";
const unitPath = join(identity.homedir, ".config/systemd/user", serviceName);
const receiptPath = join(root, "receipt.json");
function systemctl(...args) {
  const result = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, XDG_RUNTIME_DIR: "/run/user/" + identity.uid, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/" + identity.uid + "/bus" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function runningHeartbeat() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const heartbeat = JSON.parse(await readFile(join(root, "update-control/heartbeat.json"), "utf8"));
    const pid = Number(systemctl("show", serviceName, "--property=MainPID", "--value"));
    if (pid > 0 && heartbeat.pid === pid && Date.now() - Date.parse(heartbeat.observedAt) < 10_000) {
      assert.equal(systemctl("is-active", serviceName), "active");
      assert.equal(systemctl("is-enabled", serviceName), "enabled");
      return heartbeat;
    }
    await sleep(250);
  }
  throw new Error("No fresh heartbeat after user-manager restart");
}
const command = process.argv[2];
if (command === "install") {
  assert.equal((await ensureCommunityUpdateAgent({ root, interactive: false })).status, "ready");
  await writeFile(receiptPath, JSON.stringify(await runningHeartbeat()));
} else if (command === "verify-startup") {
  const previous = JSON.parse(await readFile(receiptPath, "utf8"));
  const heartbeat = await runningHeartbeat();
  assert.notEqual(heartbeat.pid, previous.pid);
} else if (command === "preserve") {
  const unit = await readFile(unitPath, "utf8");
  const heartbeat = await runningHeartbeat();
  assert.equal((await ensureCommunityUpdateAgent({ root, interactive: false })).preserved, true);
  assert.equal(await readFile(unitPath, "utf8"), unit);
  assert.equal((await runningHeartbeat()).pid, heartbeat.pid);
} else throw new Error("Unknown CI fixture operation");
