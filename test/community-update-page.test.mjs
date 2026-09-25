import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  confirmationForCommunityUpdate,
  readCommunityUpdateControlSnapshot,
  submitCommunityUpdateRequest,
  validateCommunityUpdateRequest,
} from "../lib/community-update-control.mjs";
import {
  communityUpdateAgentInternals,
  processCommunityUpdateRequest,
} from "../scripts/community-update-agent.mjs";
import {
  shouldReloadForRunningRelease,
  softwareUpdateReloadUrl,
} from "../lib/software-update-browser.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("software update requests accept only fixed operations, exact tags, and exact confirmations", () => {
  assert.equal(confirmationForCommunityUpdate("update", "v1.2.3"), "INSTALL v1.2.3");
  assert.equal(confirmationForCommunityUpdate("rollback"), "ROLL BACK AND DISCARD NEW WRITES");
  assert.throws(() => validateCommunityUpdateRequest({ operation: "shell" }), /Unsupported/);
  assert.throws(() => validateCommunityUpdateRequest({ operation: "update", target: "latest" }), /exact/);
  assert.throws(
    () => validateCommunityUpdateRequest({ operation: "update", target: "v1.2.3", confirmation: "yes" }),
    /INSTALL v1\.2\.3/
  );
  assert.equal(validateCommunityUpdateRequest({
    operation: "rollback",
    confirmation: "ROLL BACK AND DISCARD NEW WRITES",
  }).operation, "rollback");
});

test("browser requests are exclusive private files and snapshots expose only bounded state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alpr-update-control-"));
  try {
    await assert.rejects(
      submitCommunityUpdateRequest({ operation: "check" }, { directory }),
      /agent is offline/
    );
    const request = await submitCommunityUpdateRequest({ operation: "check" }, {
      directory,
      actor: { id: "42", username: "admin\nignored" },
      clock: () => new Date("2026-09-24T18:00:00.000Z"),
      requireAgentOnline: false,
    });
    assert.equal(request.accepted, true);
    const stored = JSON.parse(await readFile(join(directory, "request.json"), "utf8"));
    assert.equal(stored.operation, "check");
    assert.equal(stored.actor.username, "admin ignored");
    assert.equal(stored.confirmation, null);
    await assert.rejects(
      submitCommunityUpdateRequest({ operation: "check" }, { directory, requireAgentOnline: false }),
      /already queued/
    );
    const snapshot = await readCommunityUpdateControlSnapshot({ directory });
    assert.equal(snapshot.queued, true);
    assert.equal(snapshot.busy, true);
    assert.equal(snapshot.agent.online, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restricted host agent processes a check and preserves rollback availability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alpr-update-agent-"));
  try {
    const clock = () => new Date("2026-09-24T18:05:00.000Z");
    await submitCommunityUpdateRequest({ operation: "check" }, { directory, clock, requireAgentOnline: false });
    const calls = [];
    const completed = await processCommunityUpdateRequest({
      directory,
      clock,
      logger: { log() {}, error() {} },
      runUpdaterCommand: async (argumentsList) => {
        calls.push(argumentsList);
        if (argumentsList[0] === "status") {
          return { status: "accepted", backup: { directory: "/private/backup" }, acceptance: { cleanupEligibleAt: "2026-10-08T18:00:00.000Z" } };
        }
        return { current: { tag: "v0.1.28" }, target: { tag: "v0.1.29" } };
      },
    });
    assert.deepEqual(calls, [["check"], ["status"]]);
    assert.equal(completed.phase, "succeeded");
    assert.equal(completed.targetTag, "v0.1.29");
    assert.equal(completed.updaterStatus, "accepted");
    assert.equal(completed.rollbackEligibleUntil, "2026-10-08T18:00:00.000Z");
    assert.equal(completed.rollbackPresent, true);
    const snapshot = await readCommunityUpdateControlSnapshot({ directory });
    assert.equal(snapshot.busy, false);
    assert.equal(snapshot.state.targetTag, "v0.1.29");
    await assert.rejects(readFile(join(directory, "request-active.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent failures are redacted and do not strand an active request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alpr-update-agent-failure-"));
  try {
    await submitCommunityUpdateRequest({ operation: "check" }, { directory, requireAgentOnline: false });
    const failed = await processCommunityUpdateRequest({
      directory,
      logger: { log() {}, error() {} },
      runUpdaterCommand: async () => { throw new Error("DB_PASSWORD=super-secret\nfailed"); },
    });
    assert.equal(failed.phase, "failed");
    assert.doesNotMatch(failed.message, /super-secret/);
    assert.match(failed.message, /\[redacted\]/);
    await assert.rejects(readFile(join(directory, "request-active.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed validation preserves the guarded rollback state for the page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alpr-update-agent-recovery-"));
  try {
    await submitCommunityUpdateRequest({ operation: "validate" }, { directory, requireAgentOnline: false });
    const failed = await processCommunityUpdateRequest({
      directory,
      logger: { log() {}, error() {} },
      runUpdaterCommand: async ([command]) => {
        if (command === "status") {
          return {
            status: "validation-failed",
            backup: { directory: "/private/backup" },
            current: { tag: "v0.1.28" },
            target: { tag: "v0.1.29" },
          };
        }
        throw new Error("application health check failed");
      },
    });
    assert.equal(failed.phase, "failed");
    assert.equal(failed.updaterStatus, "validation-failed");
    assert.equal(failed.targetTag, "v0.1.29");
    assert.equal(failed.rollbackPresent, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an update tab reloads when the recovered server reports a new release", () => {
  assert.equal(shouldReloadForRunningRelease("0.1.33", "0.1.34"), true);
  assert.equal(shouldReloadForRunningRelease("0.1.34", "0.1.34"), false);
  assert.equal(shouldReloadForRunningRelease("unknown", "0.1.34"), false);
  assert.equal(
    softwareUpdateReloadUrl("http://192.168.0.10:3100/settings/software-updates", "0.1.34"),
    "http://192.168.0.10:3100/settings/software-updates?release=0.1.34",
  );
});

test("Software Updates page is permission-guarded, linked, and keeps Docker off the web container", async () => {
  const [page, panel, statusRoute, shape, shell, actions, compose, dockerfile, launcher, agent] = await Promise.all([
    source("app/settings/software-updates/page.jsx"),
    source("app/settings/software-updates/SoftwareUpdatesPanel.jsx"),
    source("app/api/software-updates/status/route.js"),
    source("lib/community-update-shape.mjs"),
    source("components/settings/SettingsShell.jsx"),
    source("app/actions.js"),
    source("docker-compose.yml"),
    source("Dockerfile"),
    source("alpr-community"),
    source("scripts/community-update-agent.mjs"),
  ]);
  assert.match(page, /requirePagePermission\("maintenance\.manage"\)/);
  assert.match(shell, /Software Updates/);
  assert.match(shell, /\/settings\/software-updates/);
  assert.match(actions, /requestSoftwareUpdate[\s\S]{0,180}requirePermission\("maintenance\.manage"\)/);
  assert.match(shape, /ROLL BACK AND DISCARD NEW WRITES/);
  assert.match(panel, /Records written after the update snapshot will be discarded/);
  assert.match(panel, /Check for updates/);
  assert.match(panel, /Run validation again/);
  assert.match(panel, /Accept update/);
  assert.match(panel, /The host update agent is offline\. Start it before accepting the update\./);
  assert.match(panel, /Select all five checks before accepting the update\./);
  assert.match(panel, /fetch\("\/api\/software-updates\/status"/);
  assert.doesNotMatch(panel, /getSoftwareUpdateStatus/);
  assert.match(panel, /window\.location\.replace/);
  assert.match(statusRoute, /denyUnlessRoutePermission\("maintenance\.manage"\)/);
  assert.match(statusRoute, /Cache-Control": "no-store"/);
  assert.match(statusRoute, /getReleaseInfo\(\)/);
  assert.match(compose, /\.\/update-control:\/app\/update-control/);
  assert.doesNotMatch(compose, /docker\.sock/);
  assert.match(dockerfile, /\/app\/update-control/);
  assert.match(launcher, /community-update-agent\.mjs/);
  assert.doesNotMatch(agent, /\bexec\s*\(|shell:\s*true/);
});

test("systemd service runs the fixed agent entry point with a private umask", () => {
  assert.equal(
    communityUpdateAgentInternals.hostControlDirectory({ root: "/opt/alpr-community" }),
    resolve("/opt/alpr-community/update-control")
  );
  const unit = communityUpdateAgentInternals.serviceFile("/opt/alpr-community", "/usr/bin/node");
  assert.match(unit, /WorkingDirectory=\/opt\/alpr-community/);
  assert.doesNotMatch(unit, /WorkingDirectory="/);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/alpr-community\/scripts\/community-update-agent\.mjs" run/);
  assert.match(unit, /UMask=0007/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /Restart=on-failure/);
  const unitWithSpaces = communityUpdateAgentInternals.serviceFile("/opt/ALPR Community", "/opt/Node 24/node");
  assert.match(unitWithSpaces, /WorkingDirectory=\/opt\/ALPR\\x20Community/);
  assert.match(unitWithSpaces, /ExecStart="\/opt\/Node 24\/node" "\/opt\/ALPR Community\/scripts\/community-update-agent\.mjs" run/);
});
