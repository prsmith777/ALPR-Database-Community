import test from "node:test";
import assert from "node:assert/strict";
import { BlueIrisExportDiagnosticService } from "../lib/blue-iris-export-diagnostic.mjs";

function harness() {
  const calls = [];
  let now = Date.parse("2026-08-09T23:30:00.000Z");
  const remotePath = "@202073";
  const workspace = {
    root: "/tmp/alpr-blue-iris-timeline",
    workspace: "/tmp/alpr-blue-iris-timeline/job-test",
    clipPath: "/tmp/alpr-blue-iris-timeline/job-test/export.mp4",
  };
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
        utc: Date.parse("2026-08-09T23:29:30.000Z"),
        durationMs: 8_000,
        status: "complete",
        progress: 100,
        complete: true,
        fileSize: 12_345,
      }];
    },
    async downloadTimelineExport(input) {
      calls.push(["download", input]);
      return { bytes: 2_500_000 };
    },
    async deleteTimelineExport(path) {
      calls.push(["delete", path]);
      return { remotePath: path, deleted: true };
    },
  };
  const state = {
    calls,
    client,
    workspace,
    registry: new Map(),
    now: () => now,
    async createWorkspace() {
      calls.push(["workspace-create"]);
      return workspace;
    },
    async removeWorkspace(value) {
      calls.push(["workspace-remove", value]);
    },
    async probe(filePath) {
      calls.push(["probe", filePath]);
      return {
        codec: "h264",
        width: 2_688,
        height: 1_520,
        durationMs: 8_000,
        startTimeMs: 0,
        fileSize: 2_500_000,
      };
    },
    advance(milliseconds) { now += milliseconds; },
  };
  return state;
}

test("manual export diagnostic pauses after every explicit direct-copy phase", async () => {
  const state = harness();
  const service = new BlueIrisExportDiagnosticService(state);
  const actor = { id: 7, username: "admin" };
  const created = await service.create({
    actor,
    camera: "Cam149",
    start: "2026-08-09T23:29:30.000Z",
  });

  assert.equal(created.status, "queued");
  assert.equal(created.remotePath, "@202073");
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
  assert.equal(checked.complete, true);
  assert.equal(state.calls.some(([name]) => name === "download"), false);

  state.advance(2_000);
  const downloaded = await service.download({ actor, token: created.token });
  assert.equal(downloaded.status, "download_validated");
  assert.equal(downloaded.downloadValidated, true);
  assert.deepEqual(downloaded.probe, {
    codec: "h264",
    width: 2_688,
    height: 1_520,
    durationMs: 8_000,
    startTimeMs: 0,
    fileSize: 2_500_000,
  });
  assert.deepEqual(
    state.calls.find(([name]) => name === "download"),
    ["download", { uri: "@202073", destinationPath: "/tmp/alpr-blue-iris-timeline/job-test/export.mp4" }]
  );
  assert.equal(state.calls.some(([name]) => name === "delete"), false);

  state.advance(2_000);
  const removed = await service.remove({ actor, token: created.token });
  assert.equal(removed.status, "remote_deleted");
  assert.ok(removed.deletedAt);
  assert.deepEqual(state.calls.at(-1), ["delete", "@202073"]);

  state.advance(2_000);
  const cleaned = await service.cleanup({ actor, token: created.token });
  assert.equal(cleaned.status, "finished");
  assert.ok(cleaned.localRemovedAt);
  assert.deepEqual(state.calls.at(-1), ["workspace-remove", state.workspace]);
  assert.equal(state.registry.size, 0);
});

test("a disappeared queue record remains eligible for its one verified exact download", async () => {
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

  const downloaded = await service.download({ actor, token: created.token });
  assert.equal(downloaded.downloadValidated, true);
  assert.equal(state.calls.filter(([name]) => name === "download").length, 1);
  assert.equal(state.calls.some(([name]) => name === "delete"), false);
});

test("manual export diagnostic cannot download before an explicit status check", async () => {
  const state = harness();
  const service = new BlueIrisExportDiagnosticService(state);
  const actor = { id: 7 };
  const created = await service.create({
    actor,
    camera: "Cam149",
    start: "2026-08-09T23:29:30.000Z",
  });

  await assert.rejects(
    service.download({ actor, token: created.token }),
    /check the export status once/i
  );
  assert.equal(state.calls.some(([name]) => name === "download"), false);
});

test("manual export diagnostic cannot delete before a validated download", async () => {
  const state = harness();
  const service = new BlueIrisExportDiagnosticService(state);
  const actor = { id: 7 };
  const created = await service.create({
    actor,
    camera: "Cam149",
    start: "2026-08-09T23:29:30.000Z",
  });
  await service.check({ actor, token: created.token });

  await assert.rejects(
    service.remove({ actor, token: created.token }),
    /download and validate/i
  );
  assert.equal(state.calls.some(([name]) => name === "delete"), false);
});

test("download validation failure removes only the staging copy and permits an explicit retry", async () => {
  const state = harness();
  let probeCount = 0;
  state.probe = async (filePath) => {
    state.calls.push(["probe", filePath]);
    probeCount += 1;
    return probeCount === 1
      ? { codec: "h264", width: 1_280, height: 720, durationMs: 8_000, fileSize: 500_000 }
      : { codec: "h264", width: 2_688, height: 1_520, durationMs: 8_000, fileSize: 2_500_000 };
  };
  const service = new BlueIrisExportDiagnosticService(state);
  const actor = { id: 7 };
  const created = await service.create({
    actor,
    camera: "Cam149",
    start: "2026-08-09T23:29:30.000Z",
  });
  await service.check({ actor, token: created.token });

  const failed = await service.download({ actor, token: created.token });
  assert.equal(failed.status, "download_failed");
  assert.equal(failed.downloadValidated, false);
  assert.match(failed.downloadError, /1280x720/);
  assert.equal(state.calls.filter(([name]) => name === "workspace-remove").length, 1);
  assert.equal(state.calls.some(([name]) => name === "delete"), false);

  const retried = await service.download({ actor, token: created.token });
  assert.equal(retried.downloadValidated, true);
  assert.equal(retried.downloadAttemptCount, 2);
  assert.equal(state.calls.filter(([name]) => name === "download").length, 2);
});

test("mismatched reserved start metadata fails closed before download", async () => {
  const state = harness();
  const originalStart = state.client.startTimelineExport;
  state.client.startTimelineExport = async (input) => ({
    ...await originalStart(input),
    utc: new Date(input.start).getTime() + 2_000,
  });
  const service = new BlueIrisExportDiagnosticService(state);
  const actor = { id: 7 };
  const created = await service.create({
    actor,
    camera: "Cam149",
    start: "2026-08-09T23:29:30.000Z",
  });
  state.client.listTimelineExports = async () => [];
  await service.check({ actor, token: created.token });

  const failed = await service.download({ actor, token: created.token });
  assert.equal(failed.downloadValidated, false);
  assert.match(failed.downloadError, /requested export start time/i);
  assert.equal(state.calls.some(([name]) => name === "download"), false);
  assert.equal(state.calls.some(([name]) => name === "delete"), false);
});

test("manual export diagnostic cannot operate on another administrator's path", async () => {
  const state = harness();
  const service = new BlueIrisExportDiagnosticService(state);
  const created = await service.create({
    actor: { id: 7 },
    camera: "Cam149",
    start: "2026-08-09T23:29:30.000Z",
  });

  await assert.rejects(
    service.check({ actor: { id: 8 }, token: created.token }),
    /unavailable or has expired/i
  );
  assert.equal(state.calls.some(([name]) => name === "download"), false);
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
