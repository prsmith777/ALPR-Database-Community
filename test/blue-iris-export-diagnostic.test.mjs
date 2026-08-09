import test from "node:test";
import assert from "node:assert/strict";
import { BlueIrisExportDiagnosticService } from "../lib/blue-iris-export-diagnostic.mjs";

function harness() {
  const calls = [];
  let now = Date.parse("2026-08-09T23:30:00.000Z");
  const remotePath = "Clipboard\\ALPR_DIAGNOSTIC.mp4";
  const client = {
    async testConnection() {
      calls.push(["connection"]);
      return { cameras: [{ id: "Cam149", enabled: true }] };
    },
    async startTimelineExport(input) {
      calls.push(["start", input]);
      return {
        remotePath,
        uri: remotePath,
        utc: new Date(input.start).getTime(),
        durationMs: input.durationMs,
        status: "queued",
        progress: null,
        complete: false,
        fileSize: null,
      };
    },
    async listTimelineExports() {
      calls.push(["list"]);
      return [{
        remotePath,
        uri: remotePath,
        status: "complete",
        progress: 100,
        complete: true,
        fileSize: 12_345,
      }];
    },
    async deleteTimelineExport(path) {
      calls.push(["delete", path]);
      return { remotePath: path, deleted: true };
    },
  };
  return {
    calls,
    client,
    registry: new Map(),
    now: () => now,
    advance(milliseconds) { now += milliseconds; },
  };
}

test("manual export diagnostic pauses after each explicit direct-copy phase", async () => {
  const state = harness();
  const service = new BlueIrisExportDiagnosticService(state);
  const actor = { id: 7, username: "admin" };
  const created = await service.create({
    actor,
    camera: "Cam149",
    start: "2026-08-09T23:29:30.000Z",
  });

  assert.equal(created.status, "queued");
  assert.equal(created.remotePath, "Clipboard\\ALPR_DIAGNOSTIC.mp4");
  assert.deepEqual(state.calls.map(([name]) => name), ["connection", "start"]);
  assert.deepEqual(state.calls[1][1], {
    camera: "Cam149",
    start: new Date("2026-08-09T23:29:30.000Z"),
    durationMs: 8_000,
    profile: 0,
    reencode: false,
    substream: false,
  });

  state.advance(2_000);
  const checked = await service.check({ actor, token: created.token });
  assert.equal(checked.status, "complete");
  assert.equal(checked.progress, 100);
  assert.equal(checked.complete, true);
  assert.deepEqual(state.calls.map(([name]) => name), ["connection", "start", "list"]);

  state.advance(2_000);
  const removed = await service.remove({ actor, token: created.token });
  assert.equal(removed.status, "deleted");
  assert.ok(removed.deletedAt);
  assert.deepEqual(state.calls.at(-1), ["delete", "Clipboard\\ALPR_DIAGNOSTIC.mp4"]);
});

test("manual export diagnostic treats a missing queue record as unconfirmed", async () => {
  const state = harness();
  state.client.listTimelineExports = async () => {
    state.calls.push(["list"]);
    return [];
  };
  const service = new BlueIrisExportDiagnosticService(state);
  const actor = { id: 7 };
  const created = await service.create({
    actor,
    camera: "Cam149",
    start: "2026-08-09T23:29:30.000Z",
  });
  const checked = await service.check({ actor, token: created.token });

  assert.equal(checked.status, "not_listed");
  assert.equal(checked.listed, false);
  assert.equal(checked.complete, false);
  assert.deepEqual(state.calls.map(([name]) => name), ["connection", "start", "list"]);
});

test("manual export diagnostic cannot delete another administrator's path", async () => {
  const state = harness();
  const service = new BlueIrisExportDiagnosticService(state);
  const created = await service.create({
    actor: { id: 7 },
    camera: "Cam149",
    start: "2026-08-09T23:29:30.000Z",
  });

  await assert.rejects(
    service.remove({ actor: { id: 8 }, token: created.token }),
    /unavailable or has expired/i
  );
  assert.equal(state.calls.some(([name]) => name === "delete"), false);
});

test("manual export diagnostic cannot delete before a status check confirms completion", async () => {
  const state = harness();
  const service = new BlueIrisExportDiagnosticService(state);
  const actor = { id: 7 };
  const created = await service.create({
    actor,
    camera: "Cam149",
    start: "2026-08-09T23:29:30.000Z",
  });

  await assert.rejects(
    service.remove({ actor, token: created.token }),
    /confirm completion before deleting/i
  );
  assert.equal(state.calls.some(([name]) => name === "delete"), false);
});

test("repeating Create recovers the existing owned diagnostic without another export", async () => {
  const state = harness();
  const service = new BlueIrisExportDiagnosticService(state);
  const input = {
    actor: { id: 7 },
    camera: "Cam149",
    start: "2026-08-09T23:29:30.000Z",
  };
  const first = await service.create(input);
  const recovered = await service.create(input);

  assert.equal(recovered.token, first.token);
  assert.equal(state.calls.filter(([name]) => name === "start").length, 1);
});
