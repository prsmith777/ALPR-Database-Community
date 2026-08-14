import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [script, packageJson, workflow] = await Promise.all([
  readFile(new URL("../scripts/test-vehicle-image-asset-cleanup-postgres.mjs", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
]);

test("canonical cleanup PostgreSQL gate fails closed before filesystem or database mutation", () => {
  const optIn = script.indexOf("process.env[OPT_IN_NAME] !== \"true\"");
  const expectedDatabase = script.indexOf("urlDatabase !== expectedDatabase");
  const guardTable = script.indexOf("codex_integration_test_guard");
  const environmentIdentity = script.indexOf("host_maintenance_environment_identity");
  const emptyDatabase = script.indexOf("AS plate_reads");
  const temporaryRoot = script.indexOf("fs.mkdtemp");
  const firstFixtureInsert = script.indexOf("INSERT INTO public.vehicle_image_assets");

  for (const position of [
    optIn,
    expectedDatabase,
    guardTable,
    environmentIdentity,
    emptyDatabase,
    temporaryRoot,
    firstFixtureInsert,
  ]) {
    assert.ok(position >= 0);
  }
  assert.ok(optIn < expectedDatabase);
  assert.ok(expectedDatabase < temporaryRoot);
  assert.ok(guardTable < temporaryRoot);
  assert.ok(environmentIdentity < temporaryRoot);
  assert.ok(emptyDatabase < temporaryRoot);
  assert.ok(temporaryRoot < firstFixtureInsert);
  assert.doesNotMatch(script, /process\.env\.[A-Z0-9_]*(?:STORAGE|PATH)/);
  assert.match(script, /expectedDatabase !== "fixture_test"/);
  assert.match(script, /codex_vehicle_asset_cleanup_\[0-9a-f\]/);
  assert.match(script, /pg_try_advisory_lock\(hashtextextended/);
  assert.match(script, /lock_timeout=5000/);
  assert.match(script, /statement_timeout=30000/);
});

test("canonical cleanup gate exercises reconciliation, late-reference protection, and a deletion control", () => {
  assert.match(script, /runStorageReconciliationBatch/);
  assert.match(script, /createStorageCleanupPreview/);
  assert.match(script, /executeStorageCleanupPreview/);
  assert.match(script, /confirmation: STORAGE_CLEANUP_CONFIRMATION/);
  assert.match(script, /protected-before-scan/);
  assert.match(script, /protected-after-scan/);
  assert.match(script, /deletion-control/);
  assert.match(script, /"skipped-referenced": 1/);
  assert.match(script, /deleted: 1/);
  assert.match(script, /error\?\.code === "ENOENT"/);
  assert.match(script, /reconciliation_required: "false"/);
  assert.ok(
    script.indexOf("const preview = await createStorageCleanupPreview") <
      script.lastIndexOf("await insertAsset(protectedAfterScan)"),
    "late canonical reference must be created after the frozen cleanup preview"
  );
  assert.match(script, /assert\.deepEqual\(residue\.rows\[0\]/);
  assert.ok(
    script.indexOf("INSERT INTO public.audit_event_archive") <
      script.indexOf("DELETE FROM public.audit_events"),
    "fixture audit rows must be archived before the append-only hot table can release them"
  );
  assert.match(script, /Refusing to remove an unvalidated temporary cleanup root/);
});

test("CI creates the disposable guard and opts in to the exact package command", () => {
  const parsedPackage = JSON.parse(packageJson);
  assert.equal(
    parsedPackage.scripts["test:vehicle-image-asset-cleanup:postgres"],
    "node scripts/test-vehicle-image-asset-cleanup-postgres.mjs"
  );
  assert.match(workflow, /CREATE TABLE public\.codex_integration_test_guard/);
  assert.match(workflow, /vehicle-image-asset-cleanup:v1/);
  assert.match(workflow, /VEHICLE_IMAGE_ASSET_CLEANUP_POSTGRES_TEST_OPT_IN='true'/);
  assert.match(workflow, /VEHICLE_IMAGE_ASSET_CLEANUP_POSTGRES_TEST_DATABASE='fixture_test'/);
  assert.match(workflow, /VEHICLE_IMAGE_ASSET_CLEANUP_POSTGRES_TEST_GUARD_TOKEN='ci-disposable-pg17'/);
  assert.match(workflow, /yarn test:vehicle-image-asset-cleanup:postgres/);
});
