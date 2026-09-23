import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("ordinary settings pages do not wait for unrelated maintenance or identity inventories", async () => {
  const page = await source("app/settings/SettingsSectionPage.jsx");
  assert.match(page, /needsSettings = canManageSettings/);
  assert.match(page, /needsSecurity = sectionId === "security"/);
  assert.match(page, /needsStorageMaintenance = canManageSettings[\s\S]*sectionId === "privacy"/);
  assert.match(page, /needsSettings \? getSettings\(\)/);
  assert.match(page, /canManageUsers && needsSecurity/);
  assert.match(page, /needsStorageMaintenance \? getStorageMaintenanceOverview\(\)/);
  assert.doesNotMatch(page, /canManageSettings \? getStorageMaintenanceOverview\(\)/);
});

test("Community Vehicle Setup loads only portable camera direction data", async () => {
  const sectionPage = await source("app/settings/vehicle-intelligence/VehicleIntelligenceSectionPage.jsx");
  assert.match(sectionPage, /includeBackfill: false/);
  assert.match(sectionPage, /includeCaptures: false/);
  assert.match(sectionPage, /includeBlueIrisTriggerDirection: true/);
  assert.doesNotMatch(sectionPage, /getBlueIrisVehicleFrameQueueStatus|getVehicleOverviewSetup/);
  assert.match(await source("app/settings/vehicle-intelligence/page.jsx"), /VehicleIntelligenceSectionPage/);
});

test("direction setup skips calibration and status queries when a tab does not display them", async () => {
  const service = await source("lib/capture-asset-service.mjs");
  assert.match(service, /includeBackfill = options\?\.includeBackfill !== false/);
  assert.match(service, /selected && includeCaptures/);
  assert.match(service, /&& includeBlueIrisTriggerDirection/);
  assert.match(service, /this\.getStatus\(\{ includeDirection: false \}\)/);
  assert.match(service, /const \[status, direction, vehicleTypePending, vehicleColorPending, v1Producer\] = await Promise\.all/);
});

test("Vehicle Intelligence paints before camera detector previews are loaded", async () => {
  const [actions, component] = await Promise.all([
    source("app/actions.js"),
    source("components/VisualSearch.jsx"),
  ]);
  assert.match(actions, /includeCameraSetup: canManageIndex && input\?\.includeCameraSetup === true/);
  assert.match(actions, /export async function getVisualSearchCameraSetup\(\)/);
  assert.match(component, /window\.setTimeout\([\s\S]*refreshCameraSetup\(\)[\s\S]*250/);
  assert.match(component, /current\?\.cameraProfiles \? \{ cameraProfiles: current\.cameraProfiles \}/);
});
