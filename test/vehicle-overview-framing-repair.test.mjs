import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  VehicleOverviewFramingRepairService,
  overviewFramingRepairProfileFromClaim,
} from "../lib/vehicle-overview-framing-repair.mjs";

function readyRead(id, overrides = {}) {
  return {
    id,
    plate_number: `TEST${id}`,
    camera_name: "Street LPR 2",
    timestamp: "2026-08-15T17:24:00.123456Z",
    read_timestamp_text: "2026-08-15 17:24:00.123456+00",
    bi_trigger_direction_label: "Westbound",
    vehicle_image_status: "ready",
    vehicle_image_path: `derived/overview/${id}.jpg`,
    vehicle_image_source_kind: "overview_primary",
    vehicle_image_updated_at_text: "2026-08-15 17:25:00.654321+00",
    vehicle_image_selection_metadata: {
      profileId: 7,
      profileRevision: 3,
      overviewContext: "street",
      sourceCameraName: "Street Overview",
      sourceCameraShortName: "Cam149",
      expectedDeltaMs: 8500,
      toleranceMs: 1500,
    },
    ...overrides,
  };
}

test("repair preview freezes only revalidated direct edge/tight candidates", async () => {
  const reads = [
    readyRead(10),
    readyRead(11, { vehicle_image_source_kind: "overview_pair_share" }),
    readyRead(12),
  ];
  let created = null;
  const service = new VehicleOverviewFramingRepairService({
    repository: {
      async getOverviewFramingRepairCandidates() { return reads; },
      async createOverviewFramingRepairPreview(input) {
        created = input;
        return { id: 4, candidateCount: input.items.length };
      },
    },
    auditService: {
      async auditRead(read) {
        return read.id === 12
          ? { repairEligible: false, actualBox: { left: 0.1, top: 0.1, right: 0.8, bottom: 0.8 } }
          : {
              repairEligible: true,
              repairReason: "VEHICLE_TOUCHES_IMAGE_EDGE",
              actualBox: { left: 0.4, top: 0.1, right: 1, bottom: 0.8 },
              completenessTier: 0,
              edgeMargin: 0,
              edgeContacts: 1,
            };
      },
    },
  });

  const preview = await service.preview({ readIds: [10, 11, 12], actor: { id: 2 } });

  assert.equal(preview.run.candidateCount, 1);
  assert.deepEqual(preview.rejected, [
    { readId: 11, reason: "ACQUISITION_PROFILE_UNAVAILABLE" },
    { readId: 12, reason: "NOT_EDGE_OR_TIGHT_FRAMING" },
  ]);
  assert.equal(created.items[0].read.id, 10);
  assert.match(created.previewFingerprint, /^[0-9a-f]{64}$/);
});

test("claimed repair profile reconstructs the frozen direct Overview acquisition", () => {
  const expectedIdentity = crypto.createHash("sha256")
    .update(JSON.stringify({ jobId: 9, kind: "overview_framing_repair" }))
    .digest("hex");
  const profile = overviewFramingRepairProfileFromClaim({
    camera_name: "Street LPR 2",
    bi_trigger_direction_label: "Westbound",
    framing_repair_job_id: 9,
    framing_repair_profile_id: 7,
    framing_repair_profile_revision: 3,
    framing_repair_source_kind: "overview_primary",
    framing_repair_overview_context: "street",
    framing_repair_source_camera_name: "Street Overview",
    framing_repair_source_camera_short_name: "Cam149",
    framing_repair_expected_delta_ms: 8500,
    framing_repair_tolerance_ms: 1500,
  });

  assert.deepEqual(profile, {
    id: 7,
    revision: 3,
    profile_kind: "framing_repair",
    profile_identity: expectedIdentity,
    source_kind: "overview_primary",
    source_camera_name: "Street Overview",
    source_camera_short_name: "Cam149",
    plate_camera_name: "Street LPR 2",
    direction_label: "Westbound",
    source_role: "primary",
    overview_context: "street",
    expected_delta_ms: 8500,
    tolerance_ms: 1500,
    enabled: true,
  });
});

test("each repair job receives a stable distinct export identity", () => {
  const claim = {
    camera_name: "Street LPR 2",
    bi_trigger_direction_label: "Westbound",
    framing_repair_profile_id: 7,
    framing_repair_profile_revision: 3,
    framing_repair_source_kind: "overview_primary",
    framing_repair_overview_context: "street",
    framing_repair_source_camera_name: "Street Overview",
    framing_repair_source_camera_short_name: "Cam149",
    framing_repair_expected_delta_ms: 8500,
    framing_repair_tolerance_ms: 1500,
  };
  const first = overviewFramingRepairProfileFromClaim({
    ...claim,
    framing_repair_job_id: 9,
  });
  const resumed = overviewFramingRepairProfileFromClaim({
    ...claim,
    framing_repair_job_id: 9,
  });
  const next = overviewFramingRepairProfileFromClaim({
    ...claim,
    framing_repair_job_id: 10,
  });

  assert.match(first.profile_identity, /^[0-9a-f]{64}$/);
  assert.equal(resumed.profile_identity, first.profile_identity);
  assert.notEqual(next.profile_identity, first.profile_identity);
  assert.equal(overviewFramingRepairProfileFromClaim(claim), null);
});

test("foundation is inert and preserves current images unless replacement completeness improves", async () => {
  const [migrations, repository, queue, actions, component, postgresGate, workflow] = await Promise.all([
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/blue-iris-vehicle-frame-repository.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/blue-iris-vehicle-frame-queue.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
    readFile(new URL("../components/settings/VehicleIntelligenceSettings.jsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/test-overview-framing-repair-postgres.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ]);
  const marker = migrations.slice(migrations.indexOf("2026081502_vehicle_overview_framing_repair"));

  assert.match(migrations, /vehicle_overview_framing_repair_runs/);
  assert.match(migrations, /vehicle_overview_framing_repair_jobs/);
  assert.match(migrations, /profile_kind IN \('pair','entry_history','framing_repair'\)/);
  assert.doesNotMatch(marker, /INSERT INTO public\.vehicle_overview_framing_repair_jobs/);
  assert.match(repository, /replacementTier >= 2/);
  assert.match(repository, /replacementMargin >= 0\.015/);
  assert.match(repository, /SET status = \$3::varchar\(20\)/);
  assert.match(repository, /CASE WHEN \$3::varchar\(20\) IN/);
  assert.match(repository, /Returning false tells the frame service/);
  assert.doesNotMatch(repository, /SET vehicle_image_status = 'processing', vehicle_image_queue_kind = 'overview_repair'/);
  assert.match(repository, /SET vehicle_image_queue_kind = 'overview_repair'/);
  assert.match(repository, /reads\.vehicle_image_status = 'ready'[\s\S]*reads\.vehicle_image_queue_kind = 'overview_repair'/);
  assert.match(repository, /claimed_job\.prior_image_path AS framing_repair_prior_image_path/);
  assert.match(repository, /claimed_job\.prior_detection_box AS framing_repair_prior_detection_box/);
  assert.match(repository, /vehicle_image_status = 'processing'[\s\S]*vehicle_image_status = 'ready'[\s\S]*vehicle_image_queue_kind = 'overview_repair'/);
  assert.match(queue, /claimNextOverviewFramingRepairJob\(\{ requireNoLiveWork: true \}\)/);
  assert.match(actions, /previewVehicleOverviewFramingRepairs/);
  assert.match(actions, /requirePermission\("maintenance\.manage"\)/);
  assert.match(component, /Create repair preview/);
  assert.match(component, /Blur, difficult sun or exposure/);
  assert.ok(postgresGate.indexOf("await guard()") < postgresGate.indexOf("INSERT INTO public.vehicle_overview_pair_profiles"));
  assert.match(postgresGate, /application environment identity must be absent/);
  assert.match(postgresGate, /REPLACEMENT_NOT_MORE_COMPLETE/);
  assert.match(postgresGate, /failure restoration SQL must type-check/);
  assert.match(workflow, /yarn test:overview-framing-repair:postgres/);
});
