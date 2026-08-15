import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("saved Overview audit and repair entry points are withdrawn", async () => {
  const [actions, settings, queue, repository, frameService] = await Promise.all([
    source("app/actions.js"),
    source("components/settings/VehicleIntelligenceSettings.jsx"),
    source("lib/blue-iris-vehicle-frame-queue.mjs"),
    source("lib/blue-iris-vehicle-frame-repository.mjs"),
    source("lib/blue-iris-vehicle-frame.mjs"),
  ]);

  assert.doesNotMatch(actions, /VehicleOverviewFraming(?:Audit|Repair)/);
  assert.doesNotMatch(settings, /Saved Overview framing audit|Create repair preview/);
  assert.doesNotMatch(queue, /claimNextOverviewFramingRepairJob|overview_framing_repair/);
  assert.doesNotMatch(repository, /createOverviewFramingRepairPreview|markOverviewFramingRepair/);
  assert.doesNotMatch(frameService, /selectTargetedOverviewRepairVehicleFrame|overview_framing_repair/);

  await assert.rejects(access(new URL("../lib/vehicle-overview-framing-audit.mjs", import.meta.url)));
  await assert.rejects(access(new URL("../lib/vehicle-overview-framing-repair.mjs", import.meta.url)));
});

test("normal live Overview final-frame validation remains active", async () => {
  const frameService = await source("lib/blue-iris-vehicle-frame.mjs");

  assert.match(frameService, /selectAnchoredOverviewVehicleFrame/);
  assert.match(frameService, /validateOverviewFinalFrame/);
  assert.match(frameService, /FINAL_FRAME_INCOMPLETE/);
  assert.match(frameService, /overviewFinalCandidates/);
});

test("withdrawal migration restores interrupted reads and leaves repair history intact", async () => {
  const migrations = await source("migrations.sql");
  const marker = migrations.indexOf("2026081504_withdraw_overview_framing_repair");
  assert.notEqual(marker, -1);
  const withdrawal = migrations.slice(Math.max(0, marker - 5_000));

  assert.match(migrations, /CREATE TABLE IF NOT EXISTS public\.vehicle_overview_framing_repair_runs/);
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS public\.vehicle_overview_framing_repair_jobs/);
  assert.match(withdrawal, /vehicle_image_status = 'ready'/);
  assert.match(withdrawal, /vehicle_image_queue_kind = prior\.prior_queue_kind/);
  assert.match(withdrawal, /vehicle_image_updated_at = prior\.prior_image_updated_at_text::timestamptz/);
  assert.match(withdrawal, /OVERVIEW_FRAMING_REPAIR_WITHDRAWN/);
  assert.match(withdrawal, /profile_kind = 'framing_repair'/);
  assert.match(withdrawal, /SET status = 'cancelled'/);
  assert.match(withdrawal, /'reason', 'FEATURE_WITHDRAWN'/);
  assert.doesNotMatch(withdrawal, /DROP TABLE/);
  assert.doesNotMatch(withdrawal, /DELETE FROM public\.vehicle_overview_framing_repair/);
});
