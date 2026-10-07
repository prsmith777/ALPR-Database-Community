import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { communityUpdateAgentInternals } from "../scripts/community-update-agent.mjs";
import { ensureCommunityUpdateAgent, setupCommunityUpdateAgent } from "../scripts/community-update-agent-setup.mjs";

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "alpr-helper-setup-"));
  const systemdDirectory = join(root, "systemd");
  const serviceDirectory = join(root, "units");
  await mkdir(systemdDirectory);
  await mkdir(serviceDirectory);
  await mkdir(join(root, "update-control"));
  const now = new Date("2026-01-02T03:04:05Z");
  await writeFile(join(root, "update-control", "heartbeat.json"), JSON.stringify({ formatVersion: 1, observedAt: now.toISOString(), pid: 9876 }));
  let linger = false;
  const commands = [];
  const messages = [];
  const runner = (command, args, options) => {
    commands.push({ command, args, options });
    assert.equal(options.env.XDG_RUNTIME_DIR, "/run/user/1234");
    assert.equal(options.env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1234/bus");
    if (command === "loginctl") return linger ? "yes" : "no";
    if (command === "sudo") { linger = true; return ""; }
    if (command === "systemctl" && args.includes("show")) return "MainPID=9876\nActiveState=active";
    if (command === "systemctl") return "";
    throw new Error("Unexpected helper command");
  };
  return {
    root, serviceDirectory, commands, messages,
    options: {
      root, systemdDirectory, serviceDirectory, runner,
      platform: "linux", identity: { uid: 1234, username: "fixture-owner", homedir: root },
      environment: { USER: "wrong-user", XDG_RUNTIME_DIR: "/wrong", DBUS_SESSION_BUS_ADDRESS: "wrong" },
      interactive: false, clock: () => now, readyAttempts: 2, sleep: async () => {}, busAvailable: async () => true,
      logger: { log(message) { messages.push(message); } }, ...overrides,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("setup uses the actual owner, restores a missing session bus environment, and verifies persistent readiness", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await ensureCommunityUpdateAgent(f.options), { status: "ready", startupAfterReboot: true, preserved: false });
    assert.deepEqual(f.commands.find(c => c.command === "sudo").args, ["-n", "loginctl", "enable-linger", "fixture-owner"]);
    const unit = await readFile(join(f.serviceDirectory, communityUpdateAgentInternals.SERVICE_NAME), "utf8");
    assert.match(unit, /NoNewPrivileges=true/);
    assert.match(unit, /WantedBy=default.target/);
    assert.ok(f.commands.some(c => c.args.includes("enable") && c.args.includes("--now")));
    f.commands.length = 0;
    assert.equal((await ensureCommunityUpdateAgent(f.options)).preserved, true);
    assert.ok(!f.commands.some(c => c.command === "sudo"));
    assert.equal(await readFile(join(f.serviceDirectory, communityUpdateAgentInternals.SERVICE_NAME), "utf8"), unit);
  } finally { await f.cleanup(); }
});

test("a matching existing service keeps its custom configuration and another installation is never overwritten", async () => {
  const f = await fixture();
  const path = join(f.serviceDirectory, communityUpdateAgentInternals.SERVICE_NAME);
  try {
    const unit = communityUpdateAgentInternals.serviceFile(f.root).replace("RestartSec=5", "RestartSec=9");
    await writeFile(path, unit);
    assert.equal((await ensureCommunityUpdateAgent(f.options)).preserved, true);
    assert.equal(await readFile(path, "utf8"), unit);
    const other = communityUpdateAgentInternals.serviceFile(join(f.root, "another-install"));
    await writeFile(path, other);
    f.commands.length = 0;
    await assert.rejects(ensureCommunityUpdateAgent(f.options), /belongs to another installation/);
    assert.equal(await readFile(path, "utf8"), other);
    assert.ok(!f.commands.some(c => c.command === "systemctl"));
  } finally { await f.cleanup(); }
});

test("readiness rejects a stale, future, wrong-process, or malformed heartbeat", async () => {
  const f = await fixture();
  try {
    for (const heartbeat of [
      { formatVersion: 1, observedAt: "2026-01-02T03:00:00Z", pid: 9876 },
      { formatVersion: 1, observedAt: "2026-01-02T03:05:00Z", pid: 9876 },
      { formatVersion: 1, observedAt: "2026-01-02T03:04:05Z", pid: 1111 },
      { formatVersion: 99, observedAt: "2026-01-02T03:04:05Z", pid: 9876 },
    ]) {
      await writeFile(join(f.root, "update-control", "heartbeat.json"), JSON.stringify(heartbeat));
      await assert.rejects(ensureCommunityUpdateAgent(f.options), /fresh heartbeat/);
    }
  } finally { await f.cleanup(); }
});

test("unsupported hosts, root, unavailable buses, and denied sudo leave a clear manual fallback", async () => {
  const f = await fixture();
  try {
    await assert.rejects(ensureCommunityUpdateAgent({ ...f.options, systemdDirectory: join(f.root, "absent") }), /requires a Linux systemd host/);
    await assert.rejects(ensureCommunityUpdateAgent({ ...f.options, identity: { uid: 0 } }), /not root/);
    await assert.rejects(ensureCommunityUpdateAgent({ ...f.options, busAvailable: async () => false }), /user bus is unavailable/);
    const result = await setupCommunityUpdateAgent({ ...f.options, ensureAgent: async () => { throw new Error("sudo permission denied"); } });
    assert.deepEqual(result, { status: "manual", code: "helper-setup-incomplete" });
    assert.match(f.messages.join("\n"), /ALPR is running/);
    assert.match(f.messages.join("\n"), /\.\/alpr-community agent install/);
  } finally { await f.cleanup(); }
});
