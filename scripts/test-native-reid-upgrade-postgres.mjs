import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

// Only CI-created, sentinel-guarded, empty scratch databases may execute this test.
const expected = process.env.NATIVE_REID_TEST_DATABASE;
if (process.env.NATIVE_REID_TEST_OPT_IN !== "true"
    || !/^codex_native_reid_[0-9a-f]{8,32}$/.test(expected || "")
    || decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)) !== expected) {
  throw new Error("Native ReID upgrade test requires an explicitly named disposable database.");
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  const guard = await pool.query("SELECT current_database() AS name, scope, guard_token FROM public.codex_integration_test_guard");
  assert.deepEqual(guard.rows, [{ name: expected, scope: "native-reid-upgrade", guard_token: process.env.NATIVE_REID_TEST_GUARD_TOKEN }]);
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'codex_integration_test_guard'");
  assert.equal(tables.rowCount, 0, "upgrade fixture must start empty");
  const oldRoot = new URL("../.ci-prior-community/", import.meta.url);
  await pool.query(await readFile(new URL("schema.sql", oldRoot), "utf8"));
  await pool.query("SET search_path TO public");
  await pool.query(await readFile(new URL("migrations.sql", oldRoot), "utf8"));
  const actor = await pool.query(`INSERT INTO public.users(username, display_name, password_hash)
    VALUES ('upgrade_fixture', 'Upgrade fixture', 'non-authenticating-test-value') RETURNING id`);
  await pool.query("INSERT INTO public.tags(name, color) VALUES ('Upgrade fixture tag', '#123456')");
  const read = await pool.query(`INSERT INTO public.plate_reads
    (plate_number, image_path, vehicle_image_path, camera_name, timestamp)
    VALUES ('TSTUP01', 'images/upgrade-plate.jpg', 'images/upgrade-vehicle.jpg',
      'Synthetic upgrade camera', CURRENT_TIMESTAMP) RETURNING *`);
  const readId = read.rows[0].id;
  await pool.query(`INSERT INTO public.capture_assets
    (read_id, asset_type, algorithm_version, status, source_image_path, error_code)
    VALUES ($1, 'vehicle_crop', 'test-retired-cache', 'failed', 'images/upgrade-plate.jpg', 'TEST_ONLY')`, [readId]);
  const before = await pool.query("SELECT id, plate_number, observed_plate, image_path, vehicle_image_path, camera_name, timestamp, review_status, review_revision, validated FROM public.plate_reads WHERE id = $1", [readId]);
  const migrations = await readFile(new URL("../migrations.sql", import.meta.url), "utf8");
  for (let pass = 0; pass < 2; pass++) {
    await pool.query(migrations);
    const after = await pool.query("SELECT id, plate_number, observed_plate, image_path, vehicle_image_path, camera_name, timestamp, review_status, review_revision, validated FROM public.plate_reads WHERE id = $1", [readId]);
    assert.deepEqual(after.rows, before.rows, "original read and image references must be unchanged");
    const control = await pool.query("SELECT mode, processing_enabled FROM public.vehicle_reid_control WHERE singleton");
    assert.deepEqual(control.rows, [{ mode: "v2_primary", processing_enabled: true }]);
    for (const table of ["capture_assets", "camera_visual_profiles", "vehicle_clusters",
      "vehicle_cluster_assignments", "vehicle_plate_associations", "vehicle_match_feedback",
      "vehicle_reid_v2_conversion_runs"]) {
      assert.equal((await pool.query("SELECT to_regclass($1) AS relation", ["public." + table])).rows[0].relation, null);
    }
    assert.equal((await pool.query("SELECT count(*)::integer AS count FROM public.users WHERE id = $1", [actor.rows[0].id])).rows[0].count, 1);
    assert.equal((await pool.query("SELECT count(*)::integer AS count FROM public.tags WHERE name = 'Upgrade fixture tag'")).rows[0].count, 1);
    for (const table of ["vehicle_image_asset_live_catalog_control", "vehicle_image_crop_live_control"]) {
      assert.equal((await pool.query(`SELECT enabled FROM public.${table} WHERE singleton`)).rows[0].enabled, true);
    }
  }
  await assert.rejects(pool.query("UPDATE public.vehicle_reid_control SET mode = 'unsupported'"), error => error.code === "23514");
  // Replaying migrations must not unpause a native installation.
  await pool.query("UPDATE public.vehicle_reid_control SET processing_enabled = FALSE");
  await pool.query(migrations);
  assert.equal((await pool.query("SELECT processing_enabled FROM public.vehicle_reid_control")).rows[0].processing_enabled, false);
  console.log("native_reid_previous_release_upgrade_and_replay=passed");
} finally { await pool.end(); }
