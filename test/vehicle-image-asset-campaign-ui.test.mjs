import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("canonical Overview catalog is loaded and rendered only for Vehicle Setup Processing", async () => {
  const [page, settings] = await Promise.all([
    source("app/settings/vehicle-intelligence/VehicleIntelligenceSectionPage.jsx"),
    source("components/settings/VehicleIntelligenceSettings.jsx"),
  ]);

  assert.match(
    page,
    /section === "processing"[\s\S]*getVehicleImageAssetCatalogOverview\(\)[\s\S]*initialVehicleImageCatalog/
  );
  assert.match(page, /vehicleImageCatalog\.data\.overview/);

  const processing = settings.slice(
    settings.indexOf('<TabsContent value="processing"'),
    settings.indexOf('<TabsContent value="calibration"')
  );
  assert.match(processing, /<VehicleImageAssetCatalogPanel initialOverview=\{initialVehicleImageCatalog\}/);
  assert.match(processing, /Historical direction backfill/);
  assert.equal((settings.match(/<VehicleImageAssetCatalogPanel/g) || []).length, 1);
});

test("catalog panel exposes the previewed bounded campaign without external enrichment", async () => {
  const panel = await source("components/settings/VehicleImageAssetCatalogPanel.jsx");

  for (const action of [
    "getVehicleImageAssetCatalogOverview",
    "previewVehicleImageAssetCatalog",
    "confirmVehicleImageAssetCatalogBatch",
    "setVehicleImageAssetCatalogPaused",
    "cancelVehicleImageAssetCatalog",
    "retryVehicleImageAssetCatalogJob",
  ]) {
    assert.match(panel, new RegExp(`${action}\\b`), action);
  }

  assert.match(panel, /BATCH_SIZES = Object\.freeze\(\[1, 5, 25, 250\]\)/);
  assert.match(panel, /Create catalog preview/);
  assert.match(panel, /Create delta preview/);
  assert.match(panel, /Catalog next batch/);
  assert.match(panel, /count\(counts\.retryable\)/);
  assert.match(panel, /Pause catalog/);
  assert.match(panel, /Resume catalog/);
  assert.match(panel, /Cancel remaining/);
  assert.match(panel, /Failures eligible for one bounded retry/);
  assert.match(panel, /Retry item/);
  assert.match(panel, /previewFingerprint: run\.previewFingerprint/);
  assert.match(panel, /limit: Number\(batchSize\)/);
});

test("catalog panel polls only active work and explains storage and identity safeguards", async () => {
  const panel = await source("components/settings/VehicleImageAssetCatalogPanel.jsx");

  assert.match(panel, /status === "previewing" \|\| \(status === "running" && activeJobs > 0\)/);
  assert.match(panel, /if \(!pollingActive\) return undefined/);
  assert.match(panel, /window\.setInterval\([\s\S]*5000\)/);
  assert.match(panel, /catalog\.currentLinks/);
  assert.match(panel, /catalog\.staleLinks/);
  assert.match(panel, /identity eligible/);
  assert.match(panel, /display only/);
  assert.match(panel, /additional storage/);
  assert.match(panel, /duplicate copies avoided/);
  assert.match(panel, /Existing Vehicle Views and ReID remain unchanged/);
  assert.match(panel, /Plate Recognizer and other external services are not contacted/);
  assert.match(panel, /Superseded and zero-link canonical assets are retained/);
  assert.match(panel, /no asset deletion or cleanup control/);
  assert.doesNotMatch(panel, />Delete(?: asset| file| image)/i);
});

test("catalog server actions use existing setup and maintenance permissions", async () => {
  const actions = await source("app/actions.js");
  const statusAction = actions.slice(
    actions.indexOf("export async function getVehicleImageAssetCatalogOverview"),
    actions.indexOf("export async function previewVehicleImageAssetCatalog")
  );
  assert.match(statusAction, /requirePermission\("system\.manage_settings"\)/);

  for (const name of [
    "previewVehicleImageAssetCatalog",
    "confirmVehicleImageAssetCatalogBatch",
    "setVehicleImageAssetCatalogPaused",
    "cancelVehicleImageAssetCatalog",
    "retryVehicleImageAssetCatalogJob",
  ]) {
    const start = actions.indexOf(`export async function ${name}`);
    const end = actions.indexOf("export async function", start + 1);
    const action = actions.slice(start, end < 0 ? undefined : end);
    assert.ok(start >= 0, name);
    assert.match(action, /requirePermission\("maintenance\.manage"\)/, name);
    assert.match(action, /revalidatePath\("\/settings\/vehicle-intelligence\/processing"\)/, name);
  }
});
