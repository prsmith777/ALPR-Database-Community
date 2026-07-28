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
  const [route, migrations] = await Promise.all([
    readFile(new URL("../app/api/plate-reads/route.js", import.meta.url), "utf8"),
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
  ]);

  assert.match(route, /parseBlueIrisAlertPointer/);
  assert.match(route, /bi_alert_clip/);
  assert.match(route, /bi_alert_path/);
  assert.match(route, /bi_alert_offset_ms/);
  assert.match(migrations, /2026072704_blue_iris_alert_correlation/);
  assert.doesNotMatch(route, /readFile\([^)]*ALERT_CLIP/);
});
