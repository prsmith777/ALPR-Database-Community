import assert from "node:assert/strict";
import test from "node:test";

import {
  assessEntryOverviewHistoryDaylight,
  entryOverviewHistoryLifecycle,
  entryOverviewHistoryProfileFromClaim,
  loadEntryOverviewHistoryEvidenceImage,
} from "../lib/entry-overview-history-backfill.mjs";

function imageProcessorFor(rgb) {
  return () => ({
    resize() { return this; },
    toColourspace() { return this; },
    removeAlpha() { return this; },
    raw() { return this; },
    async toBuffer() { return rgb; },
  });
}

test("retained plate evidence prefers the stored path and falls back to image_data", async () => {
  const fromPath = await loadEntryOverviewHistoryEvidenceImage({
    image_path: "plates/read.jpg",
    image_data: Buffer.from("fallback").toString("base64"),
  }, {
    async getImage() { return Buffer.from("path"); },
  });
  assert.equal(fromPath.source, "image_path");
  assert.equal(fromPath.buffer.toString(), "path");

  const fromData = await loadEntryOverviewHistoryEvidenceImage({
    image_path: "plates/missing.jpg",
    image_data: `data:image/jpeg;base64,${Buffer.from("retained").toString("base64")}`,
  }, {
    async getImage() { return null; },
  });
  assert.equal(fromData.source, "image_data");
  assert.equal(fromData.buffer.toString(), "retained");

  const afterStorageError = await loadEntryOverviewHistoryEvidenceImage({
    image_path: "plates/unreadable.jpg",
    image_data: Buffer.from("retained-after-error").toString("base64"),
  }, {
    async getImage() { throw new Error("storage temporarily unavailable"); },
  });
  assert.equal(afterStorageError.source, "image_data");
  assert.equal(afterStorageError.buffer.toString(), "retained-after-error");
});

test("missing or unreadable retained evidence stays daylight-unverified", async () => {
  const missing = await assessEntryOverviewHistoryDaylight({}, {});
  assert.equal(missing.status, "unverified");
  assert.equal(missing.errorCode, "DAYLIGHT_UNVERIFIED");
  assert.equal(missing.evidence.evaluated, false);
  assert.equal(missing.evidence.eligible, false);

  const unreadable = await assessEntryOverviewHistoryDaylight({
    image_data: Buffer.from("not-an-image").toString("base64"),
  }, {}, {
    imageProcessor() { throw new Error("bad image"); },
  });
  assert.equal(unreadable.status, "unverified");
  assert.equal(unreadable.evidence.reason, "retained_plate_image_unreadable");
});

test("monochrome evidence is nighttime while color evidence may reach Cam143", async () => {
  const monochromePixels = Buffer.alloc(48 * 32 * 3, 100);
  const nighttime = await assessEntryOverviewHistoryDaylight({
    image_data: Buffer.from("source").toString("base64"),
  }, {}, { imageProcessor: imageProcessorFor(monochromePixels) });
  assert.equal(nighttime.status, "nighttime");
  assert.equal(nighttime.errorCode, "NIGHTTIME_UNAVAILABLE");
  assert.equal(nighttime.evidence.monochrome, true);

  const colorPixels = Buffer.alloc(48 * 32 * 3);
  for (let offset = 0; offset < colorPixels.length; offset += 3) {
    colorPixels[offset] = 180;
    colorPixels[offset + 1] = 80;
    colorPixels[offset + 2] = 30;
  }
  const daytime = await assessEntryOverviewHistoryDaylight({
    image_data: Buffer.from("source").toString("base64"),
  }, {}, { imageProcessor: imageProcessorFor(colorPixels) });
  assert.equal(daytime.status, "eligible");
  assert.equal(daytime.errorCode, null);
  assert.equal(daytime.evidence.evaluated, true);
  assert.equal(daytime.evidence.eligible, true);
});

test("a claimed historical read maps to the immutable Cam143 profile and lifecycle", async () => {
  const read = {
    id: 901,
    camera_name: "Entry LPR 1",
    vehicle_image_claim_token: "10000000-0000-4000-8000-000000000901",
    entry_history_job_id: 81,
    entry_history_profile_id: 7,
    entry_history_profile_key: "a".repeat(64),
    entry_history_profile_revision: 3,
    entry_history_profile_kind: "entry_history",
    entry_overview_source_kind: "entry_overview_history",
    overview_source_camera_name: "Entry Overview",
    overview_source_camera_short_name: "Cam143",
    overview_expected_delta_ms: 250,
    overview_tolerance_ms: 3_000,
    entry_history_algorithm_revision: "entry-overview-history-v1",
  };
  const profile = entryOverviewHistoryProfileFromClaim(read);
  assert.equal(profile.id, 7);
  assert.equal(profile.profile_key, "a".repeat(64));
  assert.equal(profile.source_camera_name, "Entry Overview");
  assert.equal(profile.source_camera_short_name, "Cam143");
  assert.equal(profile.direction_label, null);
  assert.equal(profile.expected_delta_ms, 250);
  assert.equal(profile.tolerance_ms, 3_000);

  const calls = [];
  const lifecycle = entryOverviewHistoryLifecycle({
    async heartbeatEntryOverviewBackfillJob(...args) { calls.push(["heartbeat", ...args]); return { id: 81 }; },
    async markEntryOverviewBackfillReady(...args) { calls.push(["ready", ...args]); return { id: 901 }; },
    async markEntryOverviewBackfillFailed(...args) { calls.push(["failed", ...args]); return { id: 901 }; },
  }, read);
  await lifecycle.heartbeat();
  await lifecycle.markReady({
    frame: { framePath: "derived/new.jpg" },
    options: { exportToken: "20000000-0000-4000-8000-000000000901" },
  });
  await lifecycle.markFailed({
    failure: { status: "unavailable", errorCode: "VEHICLE_NOT_VISIBLE", retryable: false },
  });
  assert.equal(calls[0][0], "heartbeat");
  assert.equal(calls[0][1], 81);
  assert.equal(calls[1][0], "ready");
  assert.equal(calls[1][1], 81);
  assert.equal(calls[1][3].claimToken, read.vehicle_image_claim_token);
  assert.equal(calls[2][0], "failed");
  assert.equal(calls[2][2].unavailable, true);
});
