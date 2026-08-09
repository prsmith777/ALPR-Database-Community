import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseBlueIrisAlertPointer } from "../lib/blue-iris-alert-pointer.mjs";

test("Blue Iris alert metadata is preserved while retaining the existing UI3 link", () => {
  assert.deepEqual(
    parseBlueIrisAlertPointer({
      clip: "@742987550.bvr",
      path: "1.0.15325",
      camera: "Street LPR 2",
    }),
    {
      alertClip: "@742987550.bvr",
      alertPath: "1.0.15325",
      offsetMs: 15325,
      playbackPath: "ui3.htm?rec=742987550.bvr-15325&cam=Street%20LPR%202",
    }
  );
});

test("partial Blue Iris metadata remains usable for future API correlation", () => {
  assert.deepEqual(
    parseBlueIrisAlertPointer({ clip: " alert.bvr ", camera: "Entry LPR 1" }),
    {
      alertClip: "alert.bvr",
      alertPath: null,
      offsetMs: null,
      playbackPath: null,
    }
  );
});

test("ingestion and migrations preserve Blue Iris pointers without storing BVR content", async () => {
  const [route, overviewRoute, migrations] = await Promise.all([
    readFile(new URL("../app/api/plate-reads/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/vehicle-overview-candidates/route.js", import.meta.url), "utf8"),
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
  ]);

  assert.match(route, /parseBlueIrisAlertPointer/);
  assert.match(route, /bi_alert_clip/);
  assert.match(route, /bi_alert_path/);
  assert.match(route, /bi_alert_offset_ms/);
  assert.match(migrations, /2026072704_blue_iris_alert_correlation/);
  assert.match(migrations, /2026072801_blue_iris_vehicle_frames/);
  assert.match(migrations, /2026072802_blue_iris_vehicle_frame_queue/);
  assert.match(migrations, /2026072803_blue_iris_vehicle_frame_quality/);
  assert.match(route, /overviewReadQueueState/);
  assert.match(route, /bi_trigger_direction_status/);
  assert.match(route, /bi_trigger_direction_label/);
  assert.doesNotMatch(route, /listOverviewPairProfiles|createOverviewCandidate/);
  assert.match(overviewRoute, /createIntegrationRouteHandler/);
  assert.match(overviewRoute, /deprecated: true/);
  assert.match(overviewRoute, /no Blue Iris motion action is required/);
  assert.match(overviewRoute, /status: 410/);
  assert.doesNotMatch(overviewRoute, /createOverviewCandidate|vehicle_overview_candidates/);
  assert.match(migrations, /2026080801_daytime_overview_vehicle_views/);
  assert.match(route, /wakeBlueIrisVehicleFrameWorker/);
  assert.doesNotMatch(route, /readFile\([^)]*ALERT_CLIP/);
});

test("Blue Iris vehicle frames are bounded, read-owned, and exposed as a two-view live-feed image", async () => {
  const [service, table, settings, reconciliation, repository, vehicleSettings] = await Promise.all([
    readFile(new URL("../lib/blue-iris-vehicle-frame.mjs", import.meta.url), "utf8"),
    readFile(new URL("../components/PlateTable.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/BlueIrisConnectionTest.jsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/storage-reconciliation-repository.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/blue-iris-vehicle-frame-repository.mjs", import.meta.url), "utf8"),
    readFile(new URL("../components/settings/VehicleIntelligenceSettings.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(service, /VEHICLE_FRAME_SAMPLE_OFFSETS_MS/);
  assert.match(service, /saveDerivedImage/);
  assert.doesNotMatch(service, /\.bvr[^\n]*readFile|readFile[^\n]*\.bvr/);
  assert.match(settings, /Select best vehicle frame/);
  assert.match(settings, /new Date\(match\?\.alert\?\.timestamp \|\| timestamp\)/);
  assert.match(table, /Plate capture/);
  assert.match(table, /Vehicle view/);
  assert.match(reconciliation, /vehicle_image_path/);
  assert.match(table, /Vehicle view:/);
  assert.match(table, /Recording unavailable/);
  assert.match(table, /Legacy plate-camera view/);
  assert.match(table, /Unavailable nighttime/);
  assert.match(table, /Blue Iris did not provide a validated direction/);
  assert.match(table, /Queued for daytime overview/);
  assert.match(table, /Camera not mapped/);
  assert.match(repository, /FOR UPDATE SKIP LOCKED/);
  assert.match(repository, /vehicle_image_attempt_count/);
  assert.match(repository, /historical_paused/);
  assert.match(vehicleSettings, /Vehicle intelligence sections/);
  assert.match(vehicleSettings, /title="Vehicle Setup"/);
  assert.match(vehicleSettings, /useRouteTab/);
  assert.match(vehicleSettings, /Cameras/);
  assert.match(vehicleSettings, /Vehicle Views/);
  assert.match(vehicleSettings, /Daytime overview retrieval/);
  assert.match(vehicleSettings, /No Street Overview alert action required/);
  assert.doesNotMatch(vehicleSettings, /vehicle-overview-candidates/);
  assert.match(vehicleSettings, /Processing/);
  assert.match(vehicleSettings, /Camera for vehicle-view history/);
  assert.match(vehicleSettings, /Optional date range/);
  assert.match(vehicleSettings, /Queue \{cameraName \|\| "selected camera"\} history/);
  assert.match(vehicleSettings, /Pause history/);
  assert.match(vehicleSettings, /Cancel pending \{cameraName \|\| "camera"\} history/);
  assert.match(repository, /cancelHistorical/);
  assert.match(repository, /vehicle_image_status IN \('pending', 'failed'\)/);
});
