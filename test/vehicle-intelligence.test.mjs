import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createColorSignature } from "../lib/vehicle-color-signature.mjs";
import {
  VEHICLE_COLOR_MODEL,
  VEHICLE_TYPE_MODEL,
  VEHICLE_TYPE_PROVIDER,
  assessVehicleColorPixels,
  inferVehicleColor,
  inferVehicleType,
} from "../lib/vehicle-attributes.mjs";
import {
  VEHICLE_INTELLIGENCE_NAVIGATION,
} from "../lib/vehicle-intelligence-navigation.mjs";
import { BLUE_IRIS_TRIGGER_DIRECTION_ALGORITHM } from "../lib/blue-iris-trigger-direction.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function pixels(red, green, blue) {
  const result = Buffer.alloc(16 * 16 * 3);
  for (let offset = 0; offset < result.length; offset += 3) {
    result[offset] = red;
    result[offset + 1] = green;
    result[offset + 2] = blue;
  }
  return result;
}

function vector(x, y) {
  const result = new Float32Array(512);
  result[0] = x;
  result[1] = y;
  return result;
}

test("vehicle color remains per-read evidence with confidence", () => {
  assert.deepEqual(
    { ...inferVehicleColor(createColorSignature(pixels(220, 20, 20))), signature: undefined },
    { status: "ready", value: "red", confidence: 0.99, reliability: 1, signature: undefined }
  );
  assert.equal(inferVehicleColor(createColorSignature(pixels(240, 240, 240))).value, "white");
  assert.equal(inferVehicleColor(createColorSignature(pixels(10, 10, 10))).value, "black");
});

test("monochrome night captures do not receive a guessed vehicle color", () => {
  const monochrome = Buffer.alloc(16 * 16 * 3);
  for (let offset = 0; offset < monochrome.length; offset += 3) {
    const value = (offset / 3 * 17) % 256;
    monochrome[offset] = value;
    monochrome[offset + 1] = Math.min(255, value + 2);
    monochrome[offset + 2] = Math.max(0, value - 2);
  }
  const observation = assessVehicleColorPixels(monochrome);
  assert.deepEqual(
    {
      status: observation.status,
      value: observation.value,
      confidence: observation.confidence,
      reason: observation.reason,
      monochromeRatio: observation.monochromeRatio,
    },
    {
      status: "unknown",
      value: null,
      confidence: null,
      reason: "monochrome_capture",
      monochromeRatio: 1,
    }
  );
  assert.match(VEHICLE_COLOR_MODEL, /v2$/);
});

test("color assessment remains enabled for genuinely chromatic captures", () => {
  const observation = assessVehicleColorPixels(pixels(220, 20, 20));
  assert.equal(observation.status, "ready");
  assert.equal(observation.value, "red");
  assert.equal(observation.reason, null);
  assert.equal(observation.monochromeRatio, 0);
});

test("live-feed vehicle descriptors use a side rail without reducing image height", async () => {
  const table = await source("components/PlateTable.jsx");
  assert.match(table, /w-\[calc\(100vw-2rem\)\][^\n]*max-w-7xl/);
  assert.match(table, /lg:grid-cols-\[minmax\(0,1fr\)_11rem\]/);
  assert.match(table, /<div className="contents">/);
  assert.match(table, /lg:col-start-2 lg:row-span-2 lg:row-start-1/);
  assert.match(table, /<ImageViewer[\s\S]*?<aside className="h-full rounded-lg border p-2\.5 text-sm [^"]*lg:min-h-0">/);
  assert.match(table, /<aside[\s\S]*?<div className="text-xs uppercase text-muted-foreground">Type<\/div>[\s\S]*?<div className="text-xs uppercase text-muted-foreground">Color<\/div>/);
  assert.match(table, /<aside[\s\S]*?<span>Direction<\/span>/);
  assert.match(table, /text-lg font-semibold leading-tight/);
  assert.match(table, /focus_coordinates: displayedImageView === "vehicle"/);
  assert.match(table, /zoomLabel=\{displayedImageView === "vehicle" \? "Zoom to Vehicle" : "Zoom to Plate"\}/);
  assert.match(
    table,
    /<DialogFooter className="self-end lg:col-start-1 lg:row-start-2">[\s\S]*?className="grid w-full gap-3"[\s\S]*?className=\{POPUP_ACTION_GRID_CLASS\}/
  );
  const directionSection = table.slice(table.indexOf("<span>Direction</span>"), table.indexOf("<aside"));
  assert.doesNotMatch(directionSection, /vehicleColor|vehicleBodyType/);
  const vehicleMetadata = table.slice(
    table.indexOf('<div className="text-xs uppercase text-muted-foreground">Vehicle</div>'),
    table.indexOf('<div className="relative h-[40vh]')
  );
  assert.match(vehicleMetadata, /Vehicle #\$\{selectedImage\.vehicleProfileId\}/);
  assert.match(vehicleMetadata, /Legacy Vehicle #\$\{selectedImage\.vehicleProfileId\}/);
  assert.match(vehicleMetadata, /\/visual_search\/profiles\/\$\{selectedImage\.vehicleProfileId\}/);
  assert.match(vehicleMetadata, /\/visual_search\/vehicles\/\$\{selectedImage\.vehicleProfileId\}/);
  assert.doesNotMatch(vehicleMetadata, /vehicleClusterStatus|vehicleClusterSimilarity/);
});

test("live-feed refreshes do not reset a user's vehicle zoom", async () => {
  const viewer = await source("components/ImageViewer.jsx");
  assert.match(viewer, /const initializedViewRef = useRef\(null\)/);
  assert.match(viewer, /initializedViewRef\.current === viewResetKey/);
  assert.match(viewer, /initializedViewRef\.current = viewResetKey;[\s\S]*?setZoom\(clampZoom\(initialZoom\)\)/);
  assert.match(viewer, /const width = Number\(element\.naturalWidth \|\| element\.width\)/);
  assert.match(viewer, /setImageSize\(\{ url: image\.url, width, height \}\)/);
  assert.doesNotMatch(viewer, /const img = new Image\(\)/);
});

test("local vehicle type inference preserves confidence and model provenance", async () => {
  assert.deepEqual(inferVehicleType([0.8, 0.05, 0.1, 0.05]), {
    status: "ready",
    value: "car",
    confidence: 0.8,
    scores: { car: 0.8, bus: 0.05, truck: 0.1, van: 0.05 },
  });
  assert.deepEqual(inferVehicleType([0.4, 0.1, 0.3, 0.2]), {
    status: "unknown",
    value: null,
    confidence: 0.4,
    scores: { car: 0.4, bus: 0.1, truck: 0.3, van: 0.2 },
  });
  assert.equal(VEHICLE_TYPE_PROVIDER, "openvino-open-model-zoo");
  assert.match(VEHICLE_TYPE_MODEL, /vehicle-attributes-recognition-barrier-0039/);
  const [modelXml, modelBin, modelLicense] = await Promise.all([
    readFile(new URL("../models/visual-search/vehicle-attributes-recognition-barrier-0039.xml", import.meta.url)),
    readFile(new URL("../models/visual-search/vehicle-attributes-recognition-barrier-0039.bin", import.meta.url)),
    source("models/visual-search/LICENSE.open-model-zoo.txt"),
  ]);
  assert.ok(modelXml.length > 40_000);
  assert.ok(modelBin.length > 1_000_000);
  assert.match(modelLicense, /Apache License[\s\S]*Version 2\.0/);
});

test("Community vehicle setup exposes one portable camera route", async () => {
  const [shell, settingsForm, mainSidebar, vehicleSettings] = await Promise.all([
    source("components/settings/SettingsShell.jsx"),
    source("app/settings/SettingsForm.jsx"),
    source("components/Sidebar.jsx"),
    source("components/settings/VehicleIntelligenceSettings.jsx"),
  ]);
  assert.match(shell, /href: "\/settings\/vehicle-intelligence"/);
  assert.match(shell, /title: "Vehicle Setup"/);
  assert.match(mainSidebar, /label: "Vehicle Intelligence"/);
  assert.match(vehicleSettings, /saveVehicleDirectionProfile/);
  assert.doesNotMatch(vehicleSettings, /vehicle-views|vehicle-intelligence\/processing|vehicle-intelligence\/calibration|useRouteTab/);
  assert.match(shell, /<Link key=\{item\.id\} href=\{item\.href\}/);
  assert.match(shell, /settings-sidebar-collapsed/);
  assert.doesNotMatch(shell, /isLocalSection|onSelect &&/);
  assert.doesNotMatch(settingsForm, /onSelect=\{setActiveSection\}/);
});
