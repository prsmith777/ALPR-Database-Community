import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runMaintenance } from "../scripts/community-maintenance.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "alpr-maintenance-test-"));
  const operations = [];
  const services = [];
  let status = "rolled-back";
  const options = {
    environment: { ALPR_UPDATE_CONTROL_DIR: root },
    logger: { log() {}, error() {} },
    confirm: async () => "INSTALL v0.1.46",
    systemctl: (args) => {
      services.push(args[0]);
      if (args[0] === "is-active") return "active";
      if (args[0] === "show") return root;
      return "";
    },
    updater: async (args, environment, settings) => {
      assert.equal(settings.root, root);
      if (args[0] === "status") return { status };
      operations.push(args);
      const request = JSON.parse(await readFile(join(root, "request-active.json"), "utf8"));
      assert.equal(request.actor.id, "host-maintenance");
      status = "ready-for-acceptance";
      return { status, target: { tag: "v0.1.46" }, backup: { directory: "/private/retained" } };
    },
  };
  try { await run({ root, options, operations, services, setStatus: (value) => { status = value; } }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("maintenance stops only the matching service, updates, publishes acceptance state, and restarts", async () => {
  await fixture(async ({ root, options, operations, services }) => {
    const result = await runMaintenance(root, "v0.1.46", options);
    assert.equal(result.phase, "succeeded");
    assert.equal(result.updaterStatus, "ready-for-acceptance");
    assert.deepEqual(operations, [["update", "--to", "v0.1.46"]]);
    assert.deepEqual(services, ["is-active", "show", "stop", "start"]);
    assert.equal(JSON.parse(await readFile(join(root, "state.json"), "utf8")).updaterStatus, "ready-for-acceptance");
  });
});

test("maintenance refuses unfinished updates and pending browser requests before changes", async () => {
  await fixture(async ({ root, options, operations, services, setStatus }) => {
    setStatus("validation-failed");
    await assert.rejects(runMaintenance(root, "v0.1.46", options), /roll back the current/);
    setStatus("rolled-back");
    await writeFile(join(root, "request.json"), "pending");
    await assert.rejects(runMaintenance(root, "v0.1.46", options), /pending or active/);
    assert.deepEqual(operations, []);
    assert.deepEqual(services, []);
    assert.equal(await readFile(join(root, "request.json"), "utf8"), "pending");
  });
});

test("maintenance refuses another installation's service and foreground agents", async () => {
  await fixture(async ({ root, options, operations }) => {
    options.systemctl = (args) => args[0] === "is-active" ? "active" : join(root, "other");
    await assert.rejects(runMaintenance(root, "v0.1.46", options), /another installation/);
    options.systemctl = () => null;
    await writeFile(join(root, "agent.lock"), String(process.pid));
    await assert.rejects(runMaintenance(root, "v0.1.46", options), /already running/);
    assert.deepEqual(operations, []);
  });
});

test("decline changes nothing and queue arrivals during confirmation are preserved", async () => {
  await fixture(async ({ root, options, services, operations }) => {
    options.confirm = async () => "no";
    assert.deepEqual(await runMaintenance(root, "v0.1.46", options), { cancelled: true });
    assert.ok(!services.includes("stop"));
    options.confirm = async () => {
      await writeFile(join(root, "request.json"), "late request");
      return "INSTALL v0.1.46";
    };
    await assert.rejects(runMaintenance(root, "v0.1.46", options), /browser request arrived/);
    assert.deepEqual(services.slice(-2), ["stop", "start"]);
    assert.deepEqual(operations, []);
    assert.equal(await readFile(join(root, "request.json"), "utf8"), "late request");
  });
});

test("failed update is recorded for the UI and service is restarted without acceptance", async () => {
  await fixture(async ({ root, options, services }) => {
    options.updater = async (args) => {
      if (args[0] === "status") return { status: "rolled-back" };
      throw new Error("fixture database check failed");
    };
    await assert.rejects(runMaintenance(root, "v0.1.46", options), /fixture database check failed/);
    assert.equal(services.at(-1), "start");
    assert.equal(JSON.parse(await readFile(join(root, "state.json"), "utf8")).phase, "failed");
  });
});

test("maintenance respects another launcher lock and recovers a dead worker lock", async () => {
  await fixture(async ({ root, options, operations, services }) => {
    await writeFile(join(root, "maintenance.lock"), String(process.pid));
    await assert.rejects(runMaintenance(root, "v0.1.46", options), /already running/);
    assert.deepEqual(operations, []);
    assert.ok(!services.includes("stop"));
    await rm(join(root, "maintenance.lock"));
    const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    assert.equal(exited.status, 0);
    await writeFile(join(root, "agent.lock"), exited.stdout);
    await writeFile(join(root, "maintenance.lock"), exited.stdout);
    assert.equal((await runMaintenance(root, "v0.1.46", options)).phase, "succeeded");
    await assert.rejects(readFile(join(root, "agent.lock")), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "maintenance.lock")), { code: "ENOENT" });
  });
});
