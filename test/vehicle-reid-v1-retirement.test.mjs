import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CaptureAssetService } from "../lib/capture-asset-service.mjs";
import { VehicleReidV2AuthorityRepository } from "../lib/vehicle-reid-v2-authority-repository.mjs";
import { VehicleReidV2AuthorityService } from "../lib/vehicle-reid-v2-authority-service.mjs";
import { VisualIndexWorker } from "../lib/visual-index-worker.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Stage 3 schema defaults active and makes the first v1 producer stop reversible and non-deleting", async () => {
  const migration = await source("migrations.sql");
  const stage3 = migration.slice(
    migration.indexOf("Stage 3 begins with a reversible producer stop")
  );

  assert.match(stage3, /v1_producer_state VARCHAR\(16\) NOT NULL DEFAULT 'active'/);
  assert.match(stage3, /v1_producer_state IN \('active','stopped'\)/);
  assert.match(stage3, /NEW\.mode <> 'v2_primary'/);
  assert.match(stage3, /v1_rollback must immediately retain the v2_primary conversion run/);
  assert.match(stage3, /v1_rollback requires an active ReID v1 producer/);
  assert.match(stage3, /vehicle_reid_control_v1_producer_active_for_rollback/);
  assert.match(stage3, /guard_stopped_vehicle_reid_v1_writes/);
  assert.match(stage3, /BEFORE INSERT OR UPDATE ON public\.capture_assets/);
  assert.match(stage3, /BEFORE INSERT OR UPDATE ON public\.vehicle_clusters/);
  assert.match(stage3, /BEFORE INSERT OR UPDATE ON public\.vehicle_cluster_assignments/);
  assert.match(stage3, /BEFORE INSERT OR UPDATE ON public\.vehicle_match_feedback/);
  assert.match(stage3, /BEFORE INSERT OR UPDATE ON public\.vehicle_plate_associations/);
  assert.doesNotMatch(stage3, /BEFORE DELETE ON public\.(capture_assets|vehicle_clusters|vehicle_cluster_assignments)/);
  assert.doesNotMatch(stage3, /DELETE FROM public\.(capture_assets|vehicle_clusters|vehicle_cluster_assignments)/);
  assert.match(stage3, /2026082101_vehicle_reid_v1_producer_stop/);
});

test("producer transition requires the exact phrase, serializes storage writers, and audits preservation", async () => {
  const calls = [];
  const executor = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT * FROM public.vehicle_reid_control")) {
        return {
          rows: [{
            mode: "v2_primary",
            transition_run_id: 17,
            v1_producer_state: "active",
            v1_producer_revision: 1,
          }],
        };
      }
      if (sql.includes("UPDATE public.vehicle_reid_control")) {
        return {
          rows: [{
            mode: "v2_primary",
            transition_run_id: 17,
            v1_producer_state: "stopped",
            v1_producer_revision: 2,
          }],
        };
      }
      return { rows: [] };
    },
  };
  const repository = new VehicleReidV2AuthorityRepository({ executor });

  await assert.rejects(
    repository.transitionV1Producer({
      state: "stopped",
      confirmation: "stop",
      actor: { id: 1, username: "admin", displayName: "Admin" },
    }),
    (error) => error?.code === "VEHICLE_REID_V1_PRODUCER_CONFIRMATION"
  );

  const result = await repository.transitionV1Producer({
    state: "stopped",
    confirmation: "STOP REID V1 PRODUCER",
    actor: { id: 1, username: "admin", displayName: "Admin" },
  });
  assert.equal(result.v1_producer_state, "stopped");
  assert.ok(calls.some(({ sql, params }) => (
    sql.includes("pg_advisory_xact_lock") && params[0] === "alpr_storage_cleanup"
  )));
  const audit = calls.find(({ sql }) => sql.includes("INSERT INTO public.audit_events"));
  assert.ok(audit);
  assert.equal(audit.params[1], "vehicle.reid_v1_producer_stopped");
  assert.equal(audit.params[2], "vehicle_reid_control");
  assert.match(audit.params[5], /"historicalDataDeleted":false/);
  assert.match(audit.params[5], /"filesDeleted":false/);
});

test("authority service exposes producer state and retained v1 counts", async () => {
  const service = new VehicleReidV2AuthorityService({
    repository: {
      async getOverview() {
        return {
          control: {
            mode: "v2_primary",
            revision: 3,
            v1_producer_state: "stopped",
            v1_producer_revision: 2,
            v1_producer_changed_at: "2026-08-21T12:00:00.000Z",
          },
          counts: {},
          liveJobs: {},
          v1Counts: {
            assets: "31459",
            clusters: "120",
            assignments: "900",
            last_write_at: "2026-08-21T11:59:00.000Z",
          },
        };
      },
    },
  });
  const overview = await service.getOverview();
  assert.equal(overview.control.v1ProducerState, "stopped");
  assert.equal(overview.control.v1ProducerRevision, 2);
  assert.equal(overview.v1Retained.assets, 31_459);
  assert.equal(overview.v1Retained.assignments, 900);
  assert.equal(overview.v1Retained.lastWriteAt, "2026-08-21T11:59:00.000Z");
});

test("stopped producer refuses a new legacy asset before image IO", async () => {
  let imageReads = 0;
  const service = new CaptureAssetService({
    repository: {
      async getAsset() { return null; },
      async getV1ProducerControl() {
        return { mode: "v2_primary", v1_producer_state: "stopped", v1_producer_revision: 2 };
      },
    },
    fileStorage: {
      async getImage() { imageReads += 1; return Buffer.from("unused"); },
    },
  });

  await assert.rejects(
    service.indexRead({ id: 42, image_path: "original.jpg", camera_name: "LPR" }),
    (error) => error?.code === "VEHICLE_REID_V1_PRODUCER_STOPPED"
  );
  assert.equal(imageReads, 0);
});

test("visual index worker becomes inert when the durable producer control is stopped", async () => {
  let safetyCalls = 0;
  let indexCalls = 0;
  const worker = new VisualIndexWorker({
    service: {
      async getStatus() {
        return {
          pending: 50,
          retryable: 0,
          v1Producer: { mode: "v2_primary", state: "stopped", revision: 2 },
        };
      },
      async indexBatch() { indexCalls += 1; return {}; },
    },
    loadSettings: async () => ({ visualIndex: { enabled: true, paused: false } }),
    safetyProbe: async () => { safetyCalls += 1; return { safe: true }; },
    logger: {},
  });

  const result = await worker.runOnce();
  assert.equal(result.delayMs, 30_000);
  assert.equal(worker.snapshot().phase, "retired");
  assert.equal(safetyCalls, 0);
  assert.equal(indexCalls, 0);
});

test("operator surface uses typed stop and restore controls without a deletion action", async () => {
  const [panel, actions] = await Promise.all([
    source("components/settings/VehicleReidV2ConversionPanel.jsx"),
    source("app/actions.js"),
  ]);
  assert.match(panel, /STOP REID V1 PRODUCER/);
  assert.match(panel, /RESTORE REID V1 PRODUCER/);
  assert.match(panel, /does not delete or alter any original image, Overview image/);
  assert.match(actions, /transitionVehicleReidV1Producer[\s\S]*requirePermission\("maintenance\.manage"\)/);
  assert.doesNotMatch(panel, /Delete ReID v1/);
});
