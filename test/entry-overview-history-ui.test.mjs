import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Entry Overview history actions use the dedicated preview and bounded-run APIs", async () => {
  const actions = await source("app/actions.js");
  const start = actions.indexOf("const ENTRY_OVERVIEW_HISTORY_PLATE_CAMERAS");
  const end = actions.indexOf("export async function saveVehicleOverviewPairProfile", start);
  const section = actions.slice(start, end);

  assert.match(section, /"Entry LPR 1"[\s\S]*"Entry LPR 2"/);
  assert.match(section, /sourceCameraName: "Entry Overview"/);
  assert.match(section, /sourceCameraShortName: "Cam143"/);
  assert.match(section, /ENTRY_OVERVIEW_HISTORY_BATCH_SIZES = new Set\(\[1, 5, 25\]\)/);
  assert.match(section, /listEntryOverviewHistoryProfiles\(\{ enabledOnly: true \}\)/);
  assert.match(section, /saveEntryOverviewHistoryProfile\(/);
  assert.match(section, /previewEntryOverviewBackfillRun\(\{/);
  assert.match(section, /getLatestEntryOverviewBackfillRun\(\{ jobLimit: 1 \}\)/);
  assert.match(section, /getEntryOverviewBackfillRun\(runId, \{ jobLimit: 1 \}\)/);
  assert.match(section, /confirmEntryOverviewBackfillRun\(\{/);
  assert.match(section, /setEntryOverviewBackfillRunState\(/);
  assert.match(section, /cancelEntryOverviewBackfillRun\(runId\)/);
  assert.match(section, /previewableRemaining: count\("previewable_remaining"\)/);
  assert.match(section, /previewed: count\("previewed"\)/);
  assert.match(section, /return date\.toISOString\(\)/);
  assert.match(section, /Wait for the current Entry Overview history batch to finish/);
  assert.doesNotMatch(section, /queueHistorical\(/);
});

test("Vehicle Views renders a blank, preview-first Entry Overview history workflow", async () => {
  const component = await source("components/settings/VehicleIntelligenceSettings.jsx");
  const start = component.indexOf("const [entryHistoryDeltas");
  const end = component.indexOf('<TabsContent value="processing"', start);
  const section = component.slice(start, end);

  assert.match(section, /const \[entryHistoryStart, setEntryHistoryStart\] = useState\(""\)/);
  assert.match(section, /const \[entryHistoryEnd, setEntryHistoryEnd\] = useState\(""\)/);
  assert.match(section, /initialOverviewSetup\?\.entryOverviewHistory\?\.latestRun/);
  assert.match(section, /type="datetime-local"/);
  assert.match(section, /startAt: startAt\.toISOString\(\)/);
  assert.match(section, /endAt: endAt\.toISOString\(\)/);
  assert.match(section, /The end is exclusive and both boundaries are frozen by the preview/);
  assert.match(section, /Entry Overview <span[^>]*>\(Cam143\)<\/span>/);
  assert.match(section, /Entry LPR 1 and Entry LPR 2/);
  assert.match(section, /previewed \|\| 0/);
  assert.match(section, /previewableRemaining \|\| 0/);
  assert.match(section, /<SelectItem value="1">1 read<\/SelectItem>/);
  assert.match(section, /<SelectItem value="5">5 reads<\/SelectItem>/);
  assert.match(section, /<SelectItem value="25">25 reads<\/SelectItem>/);
  assert.match(section, /Queue next batch/);
  assert.match(section, /entryHistoryBatchActive/);
  assert.match(section, /Pause history/);
  assert.match(section, /Resume history/);
  assert.match(section, /Cancel remaining/);
  assert.match(section, /<Progress value=\{entryHistoryProgress\}/);
  assert.doesNotMatch(section, /2026-05-19/);
});

test("legacy history controls cannot select or broadly enqueue configured Entry LPR history", async () => {
  const component = await source("components/settings/VehicleIntelligenceSettings.jsx");

  assert.match(component, /genericFrameHistoryProfiles = \(data\.profiles \|\| \[\]\)\.filter\([\s\S]*!ENTRY_OVERVIEW_HISTORY_CAMERAS\.includes\(profile\.cameraName\)/);
  assert.match(component, /All-camera history is disabled while Entry Overview history is configured/);
  assert.match(component, /disabled=\{Boolean\(busy\) \|\| !frameQueue\?\.configured \|\| entryHistoryProfilesConfigured\}[\s\S]*Queue all camera history/);
  assert.match(component, /Entry LPR 1 and Entry LPR 2 are intentionally excluded/);
});

test("Vehicle Views restores and refreshes a run inside its existing setup and status requests", async () => {
  const [actions, page] = await Promise.all([
    source("app/actions.js"),
    source("app/settings/vehicle-intelligence/VehicleIntelligenceSectionPage.jsx"),
  ]);

  assert.match(actions, /getBlueIrisVehicleFrameQueueStatus\(input = \{\}\)[\s\S]*entryOverviewHistoryRunId[\s\S]*entryOverviewHistoryRun: entryOverviewHistoryRunData/);
  assert.match(actions, /getVehicleOverviewSetup\(\)[\s\S]*latestRun: entryOverviewHistoryRunData\(latestEntryHistoryRun\)/);
  assert.match(page, /section === "views"[\s\S]*getBlueIrisVehicleFrameQueueStatus\(\)[\s\S]*getVehicleOverviewSetup\(\)/);
  assert.doesNotMatch(page, /previewVehicleEntryOverviewHistory|getLatestEntryOverviewBackfillRun/);
});
