import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Vehicle Setup Processing loads and renders the ReID v2 conversion preview only there", async () => {
  const [page, settings] = await Promise.all([
    source("app/settings/vehicle-intelligence/VehicleIntelligenceSectionPage.jsx"),
    source("components/settings/VehicleIntelligenceSettings.jsx"),
  ]);

  assert.match(page, /getVehicleReidV2ConversionPreviewOverview/);
  assert.match(
    page,
    /section === "processing"[\s\S]*?getVehicleReidV2ConversionPreviewOverview\(\)[\s\S]*?initialVehicleReidV2ConversionPreview/
  );
  assert.match(page, /vehicleReidV2ConversionPreview\.data\.overview/);

  const processing = settings.slice(
    settings.indexOf('<TabsContent value="processing"'),
    settings.indexOf('<TabsContent value="calibration"')
  );
  assert.match(
    processing,
    /<VehicleReidV2ConversionPanel initialOverview=\{initialVehicleReidV2ConversionPreview\} \/>/
  );
  assert.equal((settings.match(/<VehicleReidV2ConversionPanel/g) || []).length, 1);
});

test("conversion preview UI exposes bounded lifecycle controls without a cutover action", async () => {
  const panel = await source("components/settings/VehicleReidV2ConversionPanel.jsx");

  for (const action of [
    "getVehicleReidV2ConversionPreviewOverview",
    "startVehicleReidV2ConversionPreview",
    "processVehicleReidV2ConversionPreviewBatch",
    "setVehicleReidV2ConversionPreviewPaused",
    "cancelVehicleReidV2ConversionPreview",
    "retryVehicleReidV2ConversionPreviewJob",
    "verifyVehicleReidV2ConversionPreview",
  ]) assert.match(panel, new RegExp(`${action}\\b`), action);

  assert.match(panel, /BATCH_SIZES = Object\.freeze\(\[1, 5, 25, 250\]\)/);
  assert.match(panel, /persistedBatchSize/);
  assert.match(panel, /setBatchSize\(String\(persistedBatchSize\)\)/);
  assert.match(panel, /Next preview batch/);
  assert.match(panel, /Process preview batch/);
  assert.match(panel, /Finalize preview state/);
  assert.match(panel, /startVehicleReidV2ConversionPreview\(\{ batchSize: Number\(batchSize\) \}\)/);
  const processAction = panel.slice(
    panel.indexOf("processVehicleReidV2ConversionPreviewBatch({"),
    panel.indexOf("}),", panel.indexOf("processVehicleReidV2ConversionPreviewBatch({"))
  );
  assert.match(processAction, /runId,/);
  assert.match(processAction, /limit: Number\(batchSize\)/);
  assert.doesNotMatch(processAction, /previewFingerprint/);
  assert.match(panel, /status === "previewing"/);
  assert.match(panel, /Pause preview/);
  assert.match(panel, /Resume preview/);
  assert.match(panel, /Cancel preview/);
  assert.match(panel, /Retry once/);
  assert.match(panel, /Verify frozen preview/);
  assert.doesNotMatch(panel, /cut over|make v2 primary|materialize authoritative/i);
});

test("conversion preview UI makes Stage 1 safety and every projection category explicit", async () => {
  const panel = await source("components/settings/VehicleReidV2ConversionPanel.jsx");

  assert.match(panel, /Stage 1 conversion preview only/);
  assert.match(panel, /No authoritative v2 profile, profile member, or read assignment is written here/);
  assert.match(panel, /never changes the current identity source/);
  assert.match(panel, /authority\.assignments/);
  assert.match(panel, /terminal job failure/);
  assert.match(panel, /comparison evidence only and never create v2 identity/);
  assert.match(panel, /Cosine similarity never establishes identity by itself/);

  for (const metric of [
    "projectedProfiles",
    "projectedMultiMemberProfiles",
    "projectedSingletonProfiles",
    "projectedMembers",
    "assignedReads",
    "unassignedReads",
    "canonicalImageAssignments",
    "sharedAssetAssignments",
    "exactPlateOnlyAssignments",
    "historicalExactPlateAssignments",
    "nighttimeExactPlateAssignments",
    "conflictedComponents",
    "conflictedReads",
    "staleEvidenceReads",
  ]) assert.match(panel, new RegExp(`metrics\\.${metric}\\b`), metric);

  assert.match(panel, /Shared canonical assets count once/);
  assert.match(panel, /Historical and nighttime reads require trustworthy exact-plate evidence/);
  assert.match(panel, /Conflict and unavailable evidence/);
  assert.match(panel, /Preserved conflicts/);
});

test("conversion preview UI exposes fingerprints and v1 comparison as observation only", async () => {
  const panel = await source("components/settings/VehicleReidV2ConversionPanel.jsx");

  assert.match(panel, /Identity evidence fingerprint/);
  assert.match(panel, /Source candidate fingerprint/);
  assert.match(panel, /Conversion preview fingerprint/);
  assert.match(panel, /Last revalidation fingerprint/);
  assert.match(panel, /Fingerprint mismatch/);
  assert.match(panel, /Exact fingerprint match/);
  assert.match(panel, /Current v1 comparison — observation only/);
  for (const metric of [
    "v1AssignedReads",
    "bothAssignedReads",
    "v1OnlyReads",
    "v2OnlyReads",
    "neitherAssignedReads",
    "exactPartitionMatches",
    "v1ClusterSplits",
    "projectedV2Merges",
    "sameInBothPairs",
    "v1SameV2DifferentPairs",
    "v2SameV1DifferentPairs",
  ]) assert.match(panel, new RegExp(`metrics\\.${metric}\\b`), metric);
  assert.match(panel, /A v1 cluster is never used to join, split, or assign v2 identity/);
  assert.match(panel, /Projected profile samples/);
});

test("conversion preview polls only active preview states", async () => {
  const panel = await source("components/settings/VehicleReidV2ConversionPanel.jsx");

  assert.match(panel, /ACTIVE_STATUSES\.has\(status\)/);
  assert.match(panel, /if \(!polling\) return undefined/);
  assert.match(panel, /window\.setInterval\([\s\S]*5000/);
});
