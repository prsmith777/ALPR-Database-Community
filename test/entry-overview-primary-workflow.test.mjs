import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Vehicle Views exposes the reviewed Entry Overview and Cam143 binding as an editable primary mapping", async () => {
  const component = await source("components/settings/VehicleIntelligenceSettings.jsx");

  assert.match(component, /ENTRY_OVERVIEW_SOURCE_CAMERA = "Entry Overview"/);
  assert.match(component, /ENTRY_OVERVIEW_SOURCE_SHORT_NAME = "Cam143"/);
  assert.match(component, /This is an editable field, not a restricted list/);
  assert.match(component, /new Set\(\[\.\.\.\(overviewSetup\?\.status\?\.observedSources \|\| \[\]\), ENTRY_OVERVIEW_SOURCE_CAMERA\]\)/);
  assert.match(component, /overviewContext[\s\S]*sourceCameraName: ENTRY_OVERVIEW_SOURCE_CAMERA[\s\S]*sourceCameraShortName: ENTRY_OVERVIEW_SOURCE_SHORT_NAME[\s\S]*sourceRole: "primary"/);
  assert.match(component, /ENTRY_OVERVIEW_HISTORY_CAMERAS\.includes\(overviewDraft\.plateCameraName\)/);
});

test("server validation keeps direct Entry primary mappings separate from Street route fallback", async () => {
  const actions = await source("app/actions.js");
  const start = actions.indexOf("export async function saveVehicleOverviewPairProfile");
  const end = actions.indexOf("export async function deleteVehicleOverviewPairProfile", start);
  const section = actions.slice(start, end);

  assert.match(section, /Entry Overview mappings must use the Primary overview role/);
  assert.match(section, /Entry Overview mappings are limited to Entry LPR 1 and Entry LPR 2/);
  assert.match(section, /Entry Overview must use the Blue Iris display name Entry Overview and short name Cam143/);
  assert.match(section, /Entry LPR primary Vehicle Views must use the Entry overview setting/);
  assert.match(section, /persistedSourceCameraName = overviewContext === "entry"/);
  assert.match(section, /persistedSourceCameraShortName = overviewContext === "entry"/);
});

test("Cam143 route payload has an independent shadow-first activation control", async () => {
  const [component, actions] = await Promise.all([
    source("components/settings/VehicleIntelligenceSettings.jsx"),
    source("app/actions.js"),
  ]);

  assert.match(component, /entryFallbackPayloadMode/);
  assert.match(component, /Cam143 payload mode/);
  assert.match(component, /Shadow validation only/);
  assert.match(component, /Two Entry LPR reads prove identity/);
  assert.match(component, /Cam143 never establishes plate identity/);
  assert.match(actions, /overviewPayloadMode/);
  assert.match(actions, /Select Off, Shadow, or Active for the Entry Overview payload/);
});
